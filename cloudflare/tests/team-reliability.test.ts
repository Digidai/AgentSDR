import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { app } from "../src/api";
import { enqueue, processJob } from "../src/jobs";
import { id, encrypt, digest } from "../src/core";
import { receive } from "../src/inbound";
import {
  attachSequence,
  createSequenceDraft,
  crmSequenceTick,
} from "../src/features/crm";
import type { Env, Row } from "../src/types";

let mf: Miniflare, env: Env, cookie: string, org: string;
const origin = "https://team-reliability.invalid";
const sql = (statement: string, ...args: any[]) =>
  env.DB.prepare(statement).bind(...args);
async function req(path: string, method = "GET", body?: unknown, useEnv = env) {
  return app.request(
    `${origin}/api${path}`,
    {
      method,
      headers: {
        Origin: origin,
        Cookie: cookie || "",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    useEnv,
  );
}
async function data(path: string, method = "GET", body?: unknown) {
  const response = await req(path, method, body);
  const result: any = await response.json();
  expect(response.ok, JSON.stringify(result)).toBe(true);
  return result;
}
async function lead() {
  return (
    await data("/people", "POST", {
      name: "Synthetic reliability lead",
      email: `${id()}@example.invalid`,
      phone: "+12025550103",
    })
  ).id as string;
}
async function followup() {
  const pid = await lead();
  const sid = (
    await data("/crm/sequences", "POST", {
      name: "Synthetic follow-up",
      steps: [
        { channel: "email", body: "An approved follow-up" },
        { channel: "email", body: "The next follow-up", delay_minutes: 60 },
      ],
    })
  ).id;
  await data(`/crm/sequences/${sid}/publish`, "POST", {});
  await attachSequence(env, org, pid, sid);
  const enrollment = await sql(
    "SELECT * FROM crm_enrollments WHERE person_id=? AND status='active'",
    pid,
  ).first<Row>();
  return { pid, sid, eid: enrollment!.id as string };
}
function holdMutation(matches: (statement: string) => boolean) {
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const originals = new WeakMap<object, D1PreparedStatement>();
  const delayed = {
    ...env,
    DB: new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (statements.some((statement) => originals.has(statement))) {
              reached();
              await gate;
            }
            return target.batch(
              statements.map(
                (statement) => originals.get(statement) || statement,
              ),
            );
          };
        if (property !== "prepare") {
          const value = (target as any)[property];
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (statement: string) => {
          const prepared = target.prepare(statement);
          if (!matches(statement)) return prepared;
          return {
            bind: (...args: any[]) => {
              const bound = prepared.bind(...args);
              const wrapped = {
                run: async () => {
                  reached();
                  await gate;
                  return bound.run();
                },
                first: async (...options: any[]) => {
                  reached();
                  await gate;
                  return (bound.first as any)(...options);
                },
              };
              originals.set(wrapped, bound);
              return wrapped;
            },
          };
        };
      },
    }),
  } as Env;
  return { delayed, held, release: () => release() };
}
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("synthetic")}}',
      compatibilityDate: "2026-10-17",
      d1Databases: ["DB"],
      r2Buckets: ["MEDIA"],
    }),
  );
  env = {
    ...(await mf.getBindings()),
    APP_URL: origin,
    ENCRYPTION_KEY: "synthetic-team-reliability",
    UNSUBSCRIBE_SECRET: "synthetic-unsubscribe",
    BOOTSTRAP_TOKEN: "synthetic-bootstrap",
    TASKS: { send: vi.fn(async () => {}) },
    AI_MODEL: "synthetic",
    AI: { run: vi.fn(async () => ({ response: "synthetic reply" })) },
  } as unknown as Env;
  const dir = new URL("../migrations/", import.meta.url);
  for (const name of (await readdir(dir))
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await env.DB.exec(await readFile(new URL(name, dir), "utf8"));
  const setup = await req("/auth/setup", "POST", {
    token: env.BOOTSTRAP_TOKEN,
    email: "owner@team-reliability.invalid",
    name: "Synthetic owner",
    organization: "Synthetic reliability",
    password: "synthetic-reliability-password",
  });
  expect(setup.status).toBe(201);
  cookie = setup.headers.get("set-cookie")!.split(";")[0];
  org = (await data("/auth/status")).user.org_id;
  await sql(
    "UPDATE organizations SET timezone='UTC',start_hour=0,end_hour=24,daily_limit=10000 WHERE id=?",
    org,
  ).run();
  for (const [kind, settings] of [
    [
      "resend",
      { api_key: "synthetic", from_address: "fixture@example.invalid" },
    ],
    [
      "unipile",
      {
        api_key: "synthetic",
        base_url: "https://synthetic.unipile.com",
        whatsapp_account_id: "synthetic-account",
      },
    ],
  ] as const)
    await sql(
      "INSERT INTO integrations(org_id,kind,encrypted) VALUES(?,?,?)",
      org,
      kind,
      await encrypt(settings, env.ENCRYPTION_KEY),
    ).run();
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await mf?.dispose();
});

it("cancels an approved reply draft when the lead sends a newer reply before dispatch", async () => {
  const pid = await lead();
  const inbound = await receive(env, org, "email", {
    person_id: pid,
    external_id: id(),
    body: "Can we meet tomorrow?",
    crmEligible: false,
  });
  const did = id();
  await sql(
    "INSERT INTO drafts(id,org_id,person_id,message_id,channel,body) VALUES(?,?,?,?,'email',?)",
    did,
    org,
    pid,
    inbound.id,
    "Tomorrow works; here are the details.",
  ).run();
  const approved = await data(`/drafts/${did}/send`, "POST", {});
  await receive(env, org, "email", {
    person_id: pid,
    external_id: id(),
    body: "Actually, cancel tomorrow. Next month instead.",
    crmEligible: false,
  });
  const transport = vi.fn(async () => Response.json({ id: id() }));
  vi.stubGlobal("fetch", transport);
  await processJob(env, approved.job);
  expect(transport).not.toHaveBeenCalled();
  expect(
    (await sql("SELECT status FROM drafts WHERE id=?", did).first<Row>())!
      .status,
  ).toBe("discarded");
});

it("stops the sequence when a user deliberately deletes its generated follow-up", async () => {
  const f = await followup();
  await crmSequenceTick(env);
  const jid = `crm-sequence:${f.eid}:0`;
  await processJob(env, jid);
  const current = await sql(
    "SELECT * FROM crm_enrollments WHERE id=?",
    f.eid,
  ).first<Row>();
  expect(current!.draft_id).toBeTruthy();
  await data(`/drafts/${current!.draft_id}`, "DELETE");
  await crmSequenceTick(env);
  await processJob(env, jid);
  const resumed = await sql(
    "SELECT * FROM crm_enrollments WHERE id=?",
    f.eid,
  ).first<Row>();
  expect(resumed!.status).toBe("stopped");
  expect(resumed!.draft_id).toBeNull();
});

it("does not let an overlapping explicit retry reopen a send that became uncertain", async () => {
  const pid = await lead(),
    did = id(),
    jid = `draft:${did}`;
  await sql(
    "INSERT INTO drafts(id,org_id,person_id,channel,body) VALUES(?,?,?,'whatsapp','Synthetic retry message')",
    did,
    org,
    pid,
  ).run();
  await sql(
    "INSERT INTO jobs(id,org_id,kind,payload,status) VALUES(?,?,'send',?,'failed')",
    jid,
    org,
    JSON.stringify({ person_id: pid, draft_id: did }),
  ).run();
  const pause = holdMutation((statement) =>
    statement.startsWith(
      "UPDATE jobs SET status='pending',error='',available_at=?,updated_at=? WHERE id=? AND org_id=?",
    ),
  );
  const olderRetry = req(`/jobs/${jid}/retry`, "POST", {}, pause.delayed);
  await pause.held;
  expect((await req(`/jobs/${jid}/retry`, "POST", {})).status).toBe(200);
  const transport = vi.fn(async () => Response.json({}, { status: 503 }));
  vi.stubGlobal("fetch", transport);
  await processJob(env, jid);
  expect(
    (await sql("SELECT status FROM jobs WHERE id=?", jid).first<Row>())!.status,
  ).toBe("uncertain");
  pause.release();
  expect((await olderRetry).status).toBe(409);
  await processJob(env, jid);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(
    (await sql("SELECT status FROM jobs WHERE id=?", jid).first<Row>())!.status,
  ).toBe("uncertain");
});

it("does not change the approved message when an earlier edit completes after approval", async () => {
  const pid = await lead(),
    did = id();
  await sql(
    "INSERT INTO drafts(id,org_id,person_id,channel,body) VALUES(?,?,?,'email','Human-approved original')",
    did,
    org,
    pid,
  ).run();
  const pause = holdMutation((statement) =>
    statement.startsWith("UPDATE drafts SET subject=?,body=?"),
  );
  const edit = req(
    `/drafts/${did}`,
    "PATCH",
    { body: "Unapproved late content" },
    pause.delayed,
  );
  await pause.held;
  const approved = await data(`/drafts/${did}/send`, "POST", {});
  pause.release();
  const editResult = await edit;
  const transport = vi.fn(async () => Response.json({ id: id() }));
  vi.stubGlobal("fetch", transport);
  await processJob(env, approved.job);
  expect(editResult.status).toBe(409);
  expect(
    (await sql(
      "SELECT body FROM messages WHERE person_id=? AND direction='outbound'",
      pid,
    ).first<Row>())!.body,
  ).toBe("Human-approved original");
});

it("preserves an already-dispatching draft and its receipt when a fresh reply arrives", async () => {
  const pid = await lead(),
    did = id();
  await sql(
    "INSERT INTO drafts(id,org_id,person_id,channel,body) VALUES(?,?,?,'email','Frozen at provider dispatch')",
    did,
    org,
    pid,
  ).run();
  const approved = await data(`/drafts/${did}/send`, "POST", {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      await receive(env, org, "email", {
        person_id: pid,
        external_id: id(),
        body: "A reply arriving after dispatch",
        crmEligible: false,
      });
      expect(
        (await sql("SELECT status FROM drafts WHERE id=?", did).first<Row>())!
          .status,
      ).toBe("queued");
      return Response.json({ id: id() });
    }),
  );
  await processJob(env, approved.job);
  expect(
    (await sql(
      "SELECT status FROM jobs WHERE id=?",
      approved.job,
    ).first<Row>())!.status,
  ).toBe("done");
  expect(
    (await sql("SELECT status FROM drafts WHERE id=?", did).first<Row>())!
      .status,
  ).toBe("sent");
  expect(
    (await sql(
      "SELECT body FROM messages WHERE person_id=? AND direction='outbound'",
      pid,
    ).first<Row>())!.body,
  ).toBe("Frozen at provider dispatch");
});

it("allows an ordinary failed draft to be explicitly retried once", async () => {
  const pid = await lead(),
    did = id(),
    jid = `draft:${did}`;
  await sql(
    "INSERT INTO drafts(id,org_id,person_id,channel,body) VALUES(?,?,?,'email','Safe explicit retry')",
    did,
    org,
    pid,
  ).run();
  await sql(
    "INSERT INTO jobs(id,org_id,kind,payload,status) VALUES(?,?,'send',?,'failed')",
    jid,
    org,
    JSON.stringify({ person_id: pid, draft_id: did }),
  ).run();
  await data(`/jobs/${jid}/retry`, "POST", {});
  const transport = vi.fn(async () => Response.json({ id: id() }));
  vi.stubGlobal("fetch", transport);
  await processJob(env, jid);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(
    (await sql("SELECT status FROM drafts WHERE id=?", did).first<Row>())!
      .status,
  ).toBe("sent");
});

it("preserves uncertain-send reconciliation when its paused campaign is deleted", async () => {
  const pid = await lead();
  const cid = (
    await data("/campaigns", "POST", {
      name: "Synthetic uncertain campaign",
      channel: "email",
      steps: [{ body: "Content frozen before the uncertain response" }],
    })
  ).id;
  await data(`/campaigns/${cid}/enroll`, "POST", { people: [pid] });
  await data(`/campaigns/${cid}`, "PATCH", { status: "active" });
  const enrollment = await sql(
    "SELECT * FROM enrollments WHERE campaign_id=?",
    cid,
  ).first<Row>();
  const jid = await enqueue(env, org, "send", {
    person_id: pid,
    enrollment_id: enrollment!.id,
    step: 0,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({}, { status: 503 })),
  );
  await processJob(env, jid);
  const attempt = await sql(
    "SELECT * FROM send_attempts WHERE job_id=?",
    jid,
  ).first<Row>();
  expect(attempt!.status).toBe("uncertain");
  await data(`/campaigns/${cid}`, "PATCH", { status: "paused" });
  await data(`/campaigns/${cid}`, "DELETE");
  const reconciled = await req(
    `/send-attempts/${attempt!.id}/reconcile`,
    "POST",
    { outcome: "sent", external_id: id() },
  );
  expect(reconciled.status).toBe(200);
  const receipt = await sql(
    "SELECT * FROM messages WHERE id=?",
    `receipt:${attempt!.id}`,
  ).first<Row>();
  expect(receipt!.campaign_id).toBeNull();
  expect(receipt!.body).toBe("Content frozen before the uncertain response");
});

it("does not accept an existing user's invitation with a password revoked during acceptance", async () => {
  const invitedOrg = id(),
    raw = id();
  await sql(
    "INSERT INTO organizations(id,name) VALUES(?,?)",
    invitedOrg,
    "Synthetic invited organization",
  ).run();
  await sql(
    "INSERT INTO invitations(id,org_id,email,role,token_hash,expires_at) VALUES(?,?,?,'member',?,?)",
    id(),
    invitedOrg,
    "owner@team-reliability.invalid",
    await digest(raw),
    new Date(Date.now() + 3600000).toISOString(),
  ).run();
  const pause = holdMutation((statement) =>
    statement.startsWith("INSERT OR IGNORE INTO members"),
  );
  const accepting = req(
    "/auth/invitation",
    "POST",
    { token: raw, password: "synthetic-reliability-password" },
    pause.delayed,
  );
  await pause.held;
  const changed = await req("/auth/password", "POST", {
    current: "synthetic-reliability-password",
    password: "synthetic-password-after-revocation",
  });
  expect(changed.status).toBe(200);
  cookie = changed.headers.get("set-cookie")!.split(";")[0];
  pause.release();
  const accepted = await accepting;
  expect(accepted.status).toBe(401);
  expect(
    (await sql(
      "SELECT COUNT(*) n FROM members WHERE org_id=?",
      invitedOrg,
    ).first<Row>())!.n,
  ).toBe(0);
});

it("saves a successful receipt if its campaign is deleted after provider dispatch", async () => {
  const pid = await lead();
  const cid = (
    await data("/campaigns", "POST", {
      name: "Synthetic in-flight campaign",
      channel: "email",
      steps: [{ body: "Already dispatched content" }],
    })
  ).id;
  await data(`/campaigns/${cid}/enroll`, "POST", { people: [pid] });
  await data(`/campaigns/${cid}`, "PATCH", { status: "active" });
  const enrollment = await sql(
    "SELECT * FROM enrollments WHERE campaign_id=?",
    cid,
  ).first<Row>();
  const jid = await enqueue(env, org, "send", {
    person_id: pid,
    enrollment_id: enrollment!.id,
    step: 0,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      await data(`/campaigns/${cid}`, "PATCH", { status: "paused" });
      await data(`/campaigns/${cid}`, "DELETE");
      return Response.json({ id: id() });
    }),
  );
  await processJob(env, jid);
  expect(
    (await sql("SELECT status FROM jobs WHERE id=?", jid).first<Row>())!.status,
  ).toBe("done");
  const receipt = await sql(
    "SELECT * FROM messages WHERE person_id=? AND direction='outbound'",
    pid,
  ).first<Row>();
  expect(receipt!.campaign_id).toBeNull();
  expect(receipt!.body).toBe("Already dispatched content");
});

it("advances a dispatched follow-up receipt while preserving a pause made during delivery", async () => {
  const f = await followup();
  await createSequenceDraft(env, org, f.eid);
  const current = await sql(
    "SELECT * FROM crm_enrollments WHERE id=?",
    f.eid,
  ).first<Row>();
  const approved = await data(`/drafts/${current!.draft_id}/send`, "POST", {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      await data(`/crm/people/${f.pid}/action`, "POST", { action: "pause" });
      return Response.json({ id: id() });
    }),
  );
  await processJob(env, approved.job);
  const paused = await sql(
    "SELECT * FROM crm_enrollments WHERE id=?",
    f.eid,
  ).first<Row>();
  expect(paused!.status).toBe("paused");
  expect(paused!.step).toBe(1);
  expect(paused!.draft_id).toBeNull();
});

it("records a reconciled paused follow-up without resuming or stranding its next step", async () => {
  const f = await followup();
  await createSequenceDraft(env, org, f.eid);
  const current = await sql(
    "SELECT * FROM crm_enrollments WHERE id=?",
    f.eid,
  ).first<Row>();
  const approved = await data(`/drafts/${current!.draft_id}/send`, "POST", {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({}, { status: 503 })),
  );
  await processJob(env, approved.job);
  await data(`/crm/people/${f.pid}/action`, "POST", { action: "pause" });
  const attempt = await sql(
    "SELECT * FROM send_attempts WHERE job_id=?",
    approved.job,
  ).first<Row>();
  const externalId = id();
  const reconciliations = await Promise.all([
    req(`/send-attempts/${attempt!.id}/reconcile`, "POST", {
      outcome: "sent",
      external_id: externalId,
    }),
    req(`/send-attempts/${attempt!.id}/reconcile`, "POST", {
      outcome: "sent",
      external_id: externalId,
    }),
  ]);
  expect(reconciliations.map((r) => r.status).sort()).toEqual([200, 409]);
  const paused = await sql(
    "SELECT * FROM crm_enrollments WHERE id=?",
    f.eid,
  ).first<Row>();
  expect(paused!.status).toBe("paused");
  expect(paused!.step).toBe(1);
  expect(paused!.draft_id).toBeNull();
});
