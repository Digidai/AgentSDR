import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { app } from "../src/api";
import { processJob, tick } from "../src/jobs";
import { digest, encrypt, hashPassword, now, sign } from "../src/core";
import type { Env } from "../src/types";
let mf: Miniflare,
  env: Env,
  cookie: string,
  org: string,
  pid: string,
  campaign: string;
const origin = "https://sdr.example.com";
const model = vi.fn(async () => ({
  response: JSON.stringify({
    classification: "interested",
    reason: "Asked for product details",
    subject: "Re: Hello",
    draft: "Thanks for your interest. What would you like to learn?",
  }),
}));
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  session = cookie,
) {
  const headers = new Headers({ Origin: origin });
  if (session) headers.set("Cookie", session);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return app.request(
    `${origin}${path}`,
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}
async function data(path: string, method = "GET", body?: unknown) {
  const r = await request(path, method, body);
  const b: any = await r.json();
  if (r.status >= 400) throw new Error(`${r.status}: ${JSON.stringify(b)}`);
  return b;
}
beforeAll(async () => {
  const output = await build({
    stdin: {
      contents: 'export default {fetch(){return new Response("test")}}',
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: output.outputFiles[0].text,
      compatibilityDate: "2026-10-17",
      d1Databases: ["DB"],
      r2Buckets: ["MEDIA"],
      queueProducers: { TASKS: "test-tasks" },
    }),
  );
  const bindings = await mf.getBindings();
  env = {
    ...bindings,
    APP_URL: origin,
    ENCRYPTION_KEY: "test-encryption-key",
    UNSUBSCRIBE_SECRET: "test-unsubscribe-secret",
    BOOTSTRAP_TOKEN: "private-setup-token",
    AI_MODEL: "mock",
    AI: { run: model },
  } as unknown as Env;
  const sql = await readFile(
    new URL("../migrations/0001_native.sql", import.meta.url),
    "utf8",
  );
  // D1 exec accepts multiple statements as separate lines.
  await env.DB.exec(sql);
}, 30000);
afterAll(async () => {
  vi.unstubAllGlobals();
  await mf?.dispose();
});
describe("real SQLite API and task integration", () => {
  it("requires the private setup secret and creates the workspace atomically", async () => {
    expect(
      (await request("/api/auth/setup", "POST", { token: "wrong" }, "")).status,
    ).toBe(403);
    const r = await request(
      "/api/auth/setup",
      "POST",
      {
        token: env.BOOTSTRAP_TOKEN,
        email: "owner@example.com",
        name: "Owner",
        organization: "Test workspace",
        password: "correct-horse-battery-staple",
      },
      "",
    );
    expect(r.status).toBe(201);
    cookie = r.headers.get("set-cookie")!.split(";")[0];
    expect(cookie).toContain("sdr_session=");
    expect(r.headers.get("set-cookie")).toContain("HttpOnly");
    const status = await data("/api/auth/status");
    org = status.user.org_id;
    expect(status.user.role).toBe("owner");
    expect(
      (await request("/api/auth/setup", "POST", { token: env.BOOTSTRAP_TOKEN }))
        .status,
    ).toBe(409);
  });
  it("requires authentication and blocks cross-origin mutations", async () => {
    expect((await request("/api/people", "GET", undefined, "")).status).toBe(
      401,
    );
    const r = await app.request(
      `${origin}/api/people`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: "https://evil.example",
          "Content-Type": "application/json",
        },
        body: "{}",
      },
      env,
    );
    expect(r.status).toBe(403);
  });
  it("persists a lead, skips duplicate imports and exports actual rows", async () => {
    pid = (
      await data("/api/people", "POST", {
        name: "Ada Example",
        email: "ada@example.com",
        company: "Example Inc",
        title: "Founder",
        website: "example.com",
      })
    ).id;
    const result = await data("/api/people/import", "POST", {
      rows: [
        { name: "Ada Duplicate", email: "ada@example.com" },
        { name: "Lin Example", email: "lin@example.com" },
      ],
    });
    expect(result).toEqual({ imported: 1, skipped: 1 });
    expect((await data("/api/people/export")).items).toHaveLength(2);
  });
  it("isolates all resource reads and mutations from another organization", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organizations(id,name) VALUES('other-org','Other workspace')",
      ),
      env.DB.prepare(
        "INSERT INTO people(id,org_id,name,email) VALUES('other-person','other-org','Other Person','other@example.com')",
      ),
      env.DB.prepare(
        "INSERT INTO enrichment_tables(id,org_id,name) VALUES('other-table','other-org','Private table')",
      ),
    ]);
    expect((await request("/api/people/other-person")).status).toBe(404);
    expect(
      (await request("/api/people/other-person", "PATCH", { notes: "attack" }))
        .status,
    ).toBe(404);
    expect(
      (await request("/api/tables/other-table/run", "POST", {})).status,
    ).toBe(404);
    expect((await data("/api/people")).total).toBe(2);
  });
  it("creates a timed sequence, enrolls once, and refuses unconfigured dispatch", async () => {
    campaign = (
      await data("/api/campaigns", "POST", {
        name: "First outreach",
        channel: "email",
        steps: [
          {
            subject: "Hello {{first_name}}",
            body: "Hi {{first_name}}, hello from our team",
            delay_minutes: 0,
          },
          {
            subject: "Following up",
            body: "Just checking in",
            delay_minutes: 2880,
          },
        ],
      })
    ).id;
    expect(
      (
        await data(`/api/campaigns/${campaign}/enroll`, "POST", {
          people: [pid, pid],
        })
      ).added,
    ).toBe(1);
    expect(
      (
        await request(`/api/campaigns/${campaign}`, "PATCH", {
          status: "active",
        })
      ).status,
    ).toBe(400);
    expect((await data(`/api/campaigns/${campaign}`)).steps).toHaveLength(2);
  });
  it("encrypts provider keys and never returns them from settings", async () => {
    await env.DB.prepare(
      "INSERT INTO integrations(org_id,kind,encrypted) VALUES(?,?,?)",
    )
      .bind(
        org,
        "resend",
        await encrypt(
          { api_key: "fake-provider-key", from_address: "owner@example.com" },
          env.ENCRYPTION_KEY,
        ),
      )
      .run();
    const settings = await data("/api/settings");
    expect(JSON.stringify(settings)).not.toContain("fake-provider-key");
    expect(settings.integrations[0].kind).toBe("resend");
  });
  it("sends a sequence exactly once under duplicate queue delivery and uses provider idempotency", async () => {
    await env.DB.prepare(
      "UPDATE organizations SET start_hour=0,end_hour=24 WHERE id=?",
    )
      .bind(org)
      .run();
    await data(`/api/campaigns/${campaign}`, "PATCH", { status: "active" });
    await tick(env);
    const job = await env.DB.prepare(
      "SELECT * FROM jobs WHERE org_id=? AND kind='send'",
    )
      .bind(org)
      .first<any>();
    const mock = vi.fn(async (_url: any, _init?: RequestInit) =>
      Response.json({ id: "provider-message-1" }),
    );
    vi.stubGlobal("fetch", mock);
    await Promise.all([processJob(env, job.id), processJob(env, job.id)]);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(
      new Headers(mock.mock.calls[0][1]?.headers).get("Idempotency-Key"),
    ).toBe(job.id);
    expect(
      (
        await env.DB.prepare("SELECT status FROM jobs WHERE id=?")
          .bind(job.id)
          .first<any>()
      ).status,
    ).toBe("done");
    expect((await data(`/api/campaigns/${campaign}`)).enrollments[0].step).toBe(
      1,
    );
    expect((await data("/api/overview")).messages.sent).toBe(1);
    vi.unstubAllGlobals();
  });
  it("stops active follow-ups on inbound reply and deduplicates webhooks", async () => {
    await data("/api/integrations/webhook", "POST", {
      secret: "webhook-secret-that-is-long-enough",
    });
    const send = () =>
      app.request(
        `${origin}/api/webhooks/${org}/email`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Secret": "webhook-secret-that-is-long-enough",
          },
          body: JSON.stringify({
            external_id: "inbound-1",
            email: "ada@example.com",
            body: "Interested. Can you send details?",
          }),
        },
        env,
      );
    expect((await send()).status).toBe(200);
    expect(await (await send()).json()).toEqual({ duplicate: true });
    expect(
      (await data(`/api/campaigns/${campaign}`)).enrollments[0].status,
    ).toBe("replied");
    expect((await data("/api/overview")).messages.replies).toBe(1);
  });
  it("classifies and creates an AI draft without sending it", async () => {
    const job = await env.DB.prepare(
      "SELECT id FROM jobs WHERE org_id=? AND kind='crm'",
    )
      .bind(org)
      .first<any>();
    await processJob(env, job.id);
    const inbox = await data("/api/inbox");
    expect(inbox.drafts).toHaveLength(1);
    expect(inbox.drafts[0].status).toBe("pending");
    expect(
      inbox.messages.find((m: any) => m.direction === "inbound").classification,
    ).toBe("interested");
    expect((await data("/api/overview")).messages.sent).toBe(1);
  });
  it("holds ambiguous provider failures and never automatically sends again", async () => {
    const draft = (await data("/api/inbox")).drafts[0];
    const queued = await data(`/api/drafts/${draft.id}/send`, "POST", {});
    const mock = vi.fn(async () => {
      throw new Error("connection interrupted");
    });
    vi.stubGlobal("fetch", mock);
    await processJob(env, queued.job);
    await processJob(env, queued.job);
    expect(mock).toHaveBeenCalledTimes(1);
    const job = await env.DB.prepare("SELECT status FROM jobs WHERE id=?")
      .bind(queued.job)
      .first<any>();
    expect(job.status).toBe("uncertain");
    expect(
      (await request(`/api/jobs/${queued.job}/retry`, "POST", {})).status,
    ).toBe(400);
    vi.unstubAllGlobals();
  });
  it("processes opt-out without calling a model and makes unsubscribe POST-only", async () => {
    const calls = model.mock.calls.length;
    const reply = await data("/api/messages", "POST", {
      person_id: pid,
      channel: "email",
      body: "Please unsubscribe me",
    });
    await processJob(env, reply.job);
    expect(model.mock.calls.length).toBe(calls);
    expect((await data(`/api/people/${pid}`)).dnc).toBe(1);
    const sig = await sign(`${org}:${pid}`, env.UNSUBSCRIBE_SECRET);
    await env.DB.prepare("UPDATE people SET dnc=0 WHERE id=?").bind(pid).run();
    expect((await request(`/u/${org}/${pid}?s=${sig}`)).status).toBe(200);
    expect((await data(`/api/people/${pid}`)).dnc).toBe(0);
    expect((await request(`/u/${org}/${pid}?s=${sig}`, "POST")).status).toBe(
      200,
    );
    expect((await data(`/api/people/${pid}`)).dnc).toBe(1);
    expect((await request(`/u/${org}/${pid}?s=forged`, "POST")).status).toBe(
      400,
    );
  });
  it("adds an enrichment table and runs an AI column through durable jobs", async () => {
    const table = (await data("/api/tables", "POST", { name: "Research" })).id;
    await data(`/api/tables/${table}`, "PATCH", {
      columns: [
        { key: "name", name: "Name", type: "text" },
        {
          key: "summary",
          name: "Summary",
          type: "ai",
          prompt: "Summarize known data for {{name}}",
        },
      ],
    });
    await data(`/api/tables/${table}/rows`, "POST", {
      rows: [{ name: "Test Person", company: "Example" }],
    });
    expect((await data(`/api/tables/${table}/run`, "POST", {})).queued).toBe(1);
    const job = await env.DB.prepare(
      "SELECT id FROM jobs WHERE kind='enrich' AND org_id=?",
    )
      .bind(org)
      .first<any>();
    await processJob(env, job.id);
    expect((await data(`/api/tables/${table}`)).rows[0].status).toBe("done");
  });
  it("stores private files in R2 with authorization on download", async () => {
    const body = new FormData();
    body.set("person_id", pid);
    body.set(
      "file",
      new File(["private test note"], "note.txt", { type: "text/plain" }),
    );
    const r = await app.request(
      `${origin}/api/files`,
      { method: "POST", headers: { Cookie: cookie, Origin: origin }, body },
      env,
    );
    expect(r.status).toBe(201);
    const result: any = await r.json();
    expect(await (await request(`/api/files/${result.id}`)).text()).toBe(
      "private test note",
    );
    expect(
      (await request(`/api/files/${result.id}`, "GET", undefined, "")).status,
    ).toBe(401);
    await data(`/api/files/${result.id}`, "DELETE");
  });
  it("enforces member roles, invitation identity, and session revocation", async () => {
    const invite = await data("/api/members/invite", "POST", {
      email: "member@example.com",
      role: "member",
    });
    const invitationToken = new URLSearchParams(
      new URL(invite.url).hash.slice(1),
    ).get("invite");
    const response = await request(
      "/api/auth/invitation",
      "POST",
      {
        token: invitationToken,
        name: "Member",
        password: "member-password-at-least-12",
      },
      "",
    );
    expect(response.status).toBe(200);
    const memberCookie = response.headers.get("set-cookie")!.split(";")[0];
    expect(
      (
        await request(
          "/api/settings",
          "PATCH",
          { name: "Changed" },
          memberCookie,
        )
      ).status,
    ).toBe(403);
    const state: any = await (
      await request("/api/auth/status", "GET", undefined, memberCookie)
    ).json();
    expect(state.user.email).toBe("member@example.com");
    await data(`/api/members/${state.user.id}`, "DELETE");
    expect(
      (await request("/api/people", "GET", undefined, memberCookie)).status,
    ).toBe(401);
  });
  it("signs out and refuses the revoked session", async () => {
    await data("/api/auth/logout", "POST", {});
    expect((await request("/api/people")).status).toBe(401);
  });
});
