import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { app } from "../src/api";
import { digest, encrypt, hashPassword, id } from "../src/core";
import { base64url } from "../src/features/google";
import type { Env, Row } from "../src/types";

let mf: Miniflare, env: Env;
const origin = "https://team-security.test";
const password = "synthetic-initial-password";
const sql = (query: string, ...args: any[]) =>
  env.DB.prepare(query).bind(...args);

async function request(
  path: string,
  method = "GET",
  body?: unknown,
  cookie = "",
  bindings = env,
) {
  return app.request(
    origin + "/api" + path,
    {
      method,
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    bindings,
  );
}
async function account(org: string, role: "owner" | "admin" | "member") {
  const uid = id(),
    raw = id(),
    email = `${uid}@example.invalid`;
  await sql(
    "INSERT INTO users(id,email,name,password_hash) VALUES(?,?,?,?)",
    uid,
    email,
    "Synthetic account",
    await hashPassword(password),
  ).run();
  await sql(
    "INSERT INTO members(org_id,user_id,role) VALUES(?,?,?)",
    org,
    uid,
    role,
  ).run();
  await sql(
    "INSERT INTO sessions(token_hash,user_id,org_id,expires_at) VALUES(?,?,?,?)",
    await digest(raw),
    uid,
    org,
    new Date(Date.now() + 3600000).toISOString(),
  ).run();
  return { uid, email, cookie: `sdr_session=${raw}` };
}
async function workspace() {
  const org = id();
  await sql(
    "INSERT INTO organizations(id,name) VALUES(?,?)",
    org,
    "Synthetic workspace",
  ).run();
  const owner = await account(org, "owner");
  await sql(
    "INSERT INTO integrations(org_id,kind,encrypted) VALUES(?,'resend',?)",
    org,
    await encrypt(
      {
        api_key: "synthetic-provider-key",
        from_address: "sender@example.invalid",
      },
      env.ENCRYPTION_KEY,
    ),
  ).run();
  return { org, owner };
}
async function recoveryLink(uid: string) {
  const raw = id();
  await sql(
    "INSERT INTO auth_tokens(id,user_id,kind,token_hash,expires_at) VALUES(?,?,'reset',?,?)",
    id(),
    uid,
    await digest(raw),
    new Date(Date.now() + 3600000).toISOString(),
  ).run();
  return raw;
}
function beforeBatch(action: () => Promise<void>): Env {
  let performed = false;
  return {
    ...env,
    DB: new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (!performed) {
              performed = true;
              await action();
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  } as Env;
}
function beforeSessionInsert(action: () => Promise<void>): Env {
  let performed = false;
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const perform = async () => {
    if (!performed) {
      performed = true;
      await action();
    }
  };
  return {
    ...env,
    DB: new Proxy(env.DB, {
      get(database, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (statements.some((statement) => originals.has(statement)))
              await perform();
            return database.batch(
              statements.map(
                (statement) => originals.get(statement) || statement,
              ),
            );
          };
        if (property === "prepare")
          return (query: string) => {
            const statement = database.prepare(query);
            if (!query.startsWith("INSERT INTO sessions(")) return statement;
            return {
              bind(...args: any[]) {
                const bound = statement.bind(...args);
                const wrapped = new Proxy(bound, {
                  get(prepared, operation) {
                    if (operation === "run")
                      return async () => {
                        await perform();
                        return prepared.run();
                      };
                    const value = Reflect.get(prepared, operation);
                    return typeof value === "function"
                      ? value.bind(prepared)
                      : value;
                  },
                });
                originals.set(wrapped, bound);
                return wrapped;
              },
            };
          };
        const value = Reflect.get(database, property);
        return typeof value === "function" ? value.bind(database) : value;
      },
    }),
  } as Env;
}
async function googleCallback(email: string, bindings: Env) {
  const start = await request("/auth/google", "GET", undefined, "", bindings);
  expect(start.status).toBe(302);
  const params = new URL(start.headers.get("location")!).searchParams;
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const header = base64url(
    new TextEncoder().encode(
      JSON.stringify({ alg: "RS256", kid: "synthetic-key" }),
    ),
  );
  const payload = base64url(
    new TextEncoder().encode(
      JSON.stringify({
        nonce: params.get("nonce"),
        aud: bindings.GOOGLE_CLIENT_ID,
        iss: "https://accounts.google.com",
        exp: Math.floor(Date.now() / 1000) + 600,
        email_verified: true,
        email,
        name: "Synthetic Google account",
      }),
    ),
  );
  const unsigned = header + "." + payload;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keys.privateKey,
    new TextEncoder().encode(unsigned),
  );
  const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "https://oauth2.googleapis.com/token")
        return Response.json({
          id_token: unsigned + "." + base64url(new Uint8Array(signature)),
        });
      if (url === "https://www.googleapis.com/oauth2/v3/certs")
        return Response.json({
          keys: [{ ...publicKey, kid: "synthetic-key" }],
        });
      throw new Error("Unexpected synthetic provider request");
    }),
  );
  return request(
    `/auth/callback/google?state=${params.get("state")}&code=synthetic-code`,
    "GET",
    undefined,
    start.headers.get("set-cookie")!.split(";")[0],
    bindings,
  );
}

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("fixture")}}',
      compatibilityDate: "2026-10-17",
      d1Databases: ["DB"],
      r2Buckets: ["MEDIA"],
    }),
  );
  env = {
    ...(await mf.getBindings()),
    APP_URL: origin,
    ENCRYPTION_KEY: "team-security-local-key",
    UNSUBSCRIBE_SECRET: "team-security-local-unsubscribe",
    BOOTSTRAP_TOKEN: "team-security-local-setup",
    TASKS: { send: vi.fn(async () => {}) },
    AI_MODEL: "fixture",
    AI: { run: vi.fn(async () => ({ response: "{}" })) },
  } as unknown as Env;
  const dir = new URL("../migrations/", import.meta.url);
  for (const name of (await readdir(dir))
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await env.DB.exec(await readFile(new URL(name, dir), "utf8"));
}, 30000);
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => mf?.dispose());

it("invalidates outstanding recovery links when the signed-in user changes their password", async () => {
  const { owner } = await workspace();
  let recoveryToken = "";
  const transport = vi.fn(async (_url: unknown, init: RequestInit) => {
    recoveryToken = JSON.parse(String(init.body)).text.split("#token=")[1];
    return Response.json({ id: "synthetic-reset-email" });
  });
  vi.stubGlobal("fetch", transport);
  expect(
    (await request("/auth/forgot-password", "POST", { email: owner.email }))
      .status,
  ).toBe(200);
  expect(recoveryToken).not.toBe("");
  expect(
    (
      await request(
        "/auth/password",
        "POST",
        {
          current: password,
          password: "synthetic-new-password",
        },
        owner.cookie,
      )
    ).status,
  ).toBe(200);
  const response = await request("/auth/reset-password", "POST", {
    token: recoveryToken,
    password: "synthetic-stale-link-password",
  });
  expect(response.status).toBe(400);
  expect(
    (
      await request("/auth/login", "POST", {
        email: owner.email,
        password: "synthetic-new-password",
      })
    ).status,
  ).toBe(200);
});

it("does not accept an invitation revoked while the acceptance request is preparing its transaction", async () => {
  const { org, owner } = await workspace();
  const email = `${id()}@example.invalid`;
  const invitationResponse = await request(
    "/members/invite",
    "POST",
    { email },
    owner.cookie,
  );
  expect(invitationResponse.status).toBe(201);
  const invitation = (await invitationResponse.json()) as Row;
  const raw = String(invitation.url).split("#invite=")[1];
  let revoked = false;
  const bindings = {
    ...env,
    DB: new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (!revoked) {
              revoked = true;
              const response = await request(
                `/invitations/${invitation.id}`,
                "DELETE",
                undefined,
                owner.cookie,
              );
              expect(response.status).toBe(200);
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  } as Env;
  const response = await request(
    "/auth/invitation",
    "POST",
    {
      token: raw,
      password,
      name: "Synthetic invited user",
    },
    "",
    bindings,
  );
  expect(revoked).toBe(true);
  expect(response.status).toBe(400);
  expect(
    await sql(
      "SELECT 1 FROM members m JOIN users u ON u.id=m.user_id WHERE m.org_id=? AND u.email=?",
      org,
      email,
    ).first(),
  ).toBeNull();
});

it("prevents an administrator from changing a member who became an owner after the initial read", async () => {
  const { org, owner } = await workspace();
  const admin = await account(org, "admin"),
    target = await account(org, "member");
  let promoted = false;
  const bindings = {
    ...env,
    DB: new Proxy(env.DB, {
      get(database, property) {
        if (property === "prepare")
          return (query: string) => {
            const statement = database.prepare(query);
            if (
              query !== "SELECT role FROM members WHERE org_id=? AND user_id=?"
            )
              return statement;
            return {
              bind(...args: any[]) {
                const bound = statement.bind(...args);
                return new Proxy(bound, {
                  get(prepared, operation) {
                    if (operation === "first")
                      return async () => {
                        const snapshot = await prepared.first();
                        if (!promoted) {
                          promoted = true;
                          expect(
                            (
                              await request(
                                `/members/${target.uid}`,
                                "PATCH",
                                { role: "owner" },
                                owner.cookie,
                              )
                            ).status,
                          ).toBe(200);
                        }
                        return snapshot;
                      };
                    const value = Reflect.get(prepared, operation);
                    return typeof value === "function"
                      ? value.bind(prepared)
                      : value;
                  },
                });
              },
            };
          };
        const value = Reflect.get(database, property);
        return typeof value === "function" ? value.bind(database) : value;
      },
    }),
  } as Env;
  const response = await request(
    `/members/${target.uid}`,
    "PATCH",
    { role: "member" },
    admin.cookie,
    bindings,
  );
  expect(promoted).toBe(true);
  expect(response.status).toBe(403);
  expect(
    (
      await sql(
        "SELECT role FROM members WHERE org_id=? AND user_id=?",
        org,
        target.uid,
      ).first<Row>()
    )?.role,
  ).toBe("owner");
});

it("does not overwrite a completed recovery with a request authenticated by the old password", async () => {
  const { owner } = await workspace();
  const raw = await recoveryLink(owner.uid);
  const bindings = beforeBatch(async () => {
    expect(
      (
        await request("/auth/reset-password", "POST", {
          token: raw,
          password: "synthetic-recovered-password",
        })
      ).status,
    ).toBe(200);
  });
  const response = await request(
    "/auth/password",
    "POST",
    {
      current: password,
      password: "synthetic-stale-current-password",
    },
    owner.cookie,
    bindings,
  );
  expect(response.status).toBe(400);
  expect(
    (
      await request("/auth/login", "POST", {
        email: owner.email,
        password: "synthetic-recovered-password",
      })
    ).status,
  ).toBe(200);
});

it("does not grant Google signup membership after the invitation is revoked", async () => {
  const { org, owner } = await workspace();
  const email = `${id()}@example.invalid`;
  const issued = await request(
    "/members/invite",
    "POST",
    { email },
    owner.cookie,
  );
  const invitation = (await issued.json()) as Row;
  const bindings = {
    ...beforeBatch(async () => {
      expect(
        (
          await request(
            `/invitations/${invitation.id}`,
            "DELETE",
            undefined,
            owner.cookie,
          )
        ).status,
      ).toBe(200);
    }),
    GOOGLE_CLIENT_ID: "synthetic-google-client",
    GOOGLE_CLIENT_SECRET: "synthetic-google-secret",
  } as Env;
  const response = await googleCallback(email, bindings);
  expect(response.status).toBe(400);
  expect(
    await sql(
      "SELECT 1 FROM members m JOIN users u ON u.id=m.user_id WHERE m.org_id=? AND u.email=?",
      org,
      email,
    ).first(),
  ).toBeNull();
});

it("keeps valid owner and administrator role changes available", async () => {
  const { org, owner } = await workspace();
  const admin = await account(org, "admin"),
    teammate = await account(org, "member");
  expect(
    (
      await request(
        `/members/${teammate.uid}`,
        "PATCH",
        { role: "admin" },
        admin.cookie,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await request(
        `/members/${teammate.uid}`,
        "PATCH",
        { role: "owner" },
        owner.cookie,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await request(
        `/members/${teammate.uid}`,
        "PATCH",
        { role: "admin" },
        owner.cookie,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await request(
        `/members/${owner.uid}`,
        "PATCH",
        { role: "member" },
        owner.cookie,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await sql(
        "SELECT COUNT(*) n FROM members WHERE org_id=? AND role='owner'",
        org,
      ).first<Row>()
    )?.n,
  ).toBe(1);
});

it("accepts a valid invitation once and verifies an existing account's password", async () => {
  const first = await workspace(),
    second = await workspace();
  const issued = await request(
    "/members/invite",
    "POST",
    { email: first.owner.email, role: "admin" },
    second.owner.cookie,
  );
  const invitation = (await issued.json()) as Row;
  const raw = String(invitation.url).split("#invite=")[1];
  expect(
    (
      await request("/auth/invitation", "POST", {
        token: raw,
        password: "incorrect-existing-password",
      })
    ).status,
  ).toBe(401);
  const response = await request("/auth/invitation", "POST", {
    token: raw,
    password,
  });
  expect(response.status).toBe(200);
  const status = await request(
    "/auth/status",
    "GET",
    undefined,
    response.headers.get("set-cookie")!.split(";")[0],
  );
  expect(((await status.json()) as Row).user).toMatchObject({
    id: first.owner.uid,
    org_id: second.org,
    role: "admin",
  });
  expect(
    (await request("/auth/invitation", "POST", { token: raw, password }))
      .status,
  ).toBe(400);
});

it("retains normal invitation-only Google signup with a verified session", async () => {
  const { org, owner } = await workspace();
  const email = `${id()}@example.invalid`;
  expect(
    (await request("/members/invite", "POST", { email }, owner.cookie)).status,
  ).toBe(201);
  const bindings = {
    ...env,
    GOOGLE_CLIENT_ID: "synthetic-google-client",
    GOOGLE_CLIENT_SECRET: "synthetic-google-secret",
  } as Env;
  const response = await googleCallback(email, bindings);
  expect(response.status).toBe(302);
  const cookie = response.headers
    .get("set-cookie")!
    .split(",")
    .find((part) => part.trim().startsWith("sdr_session="))!
    .trim()
    .split(";")[0];
  const status = await request("/auth/status", "GET", undefined, cookie);
  expect(((await status.json()) as Row).user).toMatchObject({
    email,
    org_id: org,
    role: "member",
  });
  expect(
    (
      await sql(
        "SELECT email_verified FROM users WHERE email=?",
        email,
      ).first<Row>()
    )?.email_verified,
  ).toBe(1);
});

it("denies member changes to workspace, team and membership settings", async () => {
  const { org, owner } = await workspace();
  const member = await account(org, "member");
  const teamResponse = await request(
    "/teams",
    "POST",
    { name: "Synthetic team" },
    owner.cookie,
  );
  const team = (await teamResponse.json()) as Row;
  for (const [path, method, body] of [
    ["/settings", "PATCH", { name: "Changed" }],
    [`/organizations/${org}`, "PATCH", { name: "Changed" }],
    ["/members/invite", "POST", { email: "new@example.invalid" }],
    [`/members/${owner.uid}`, "PATCH", { role: "member" }],
    [`/teams/${team.id}`, "PATCH", { members: [member.uid] }],
    [`/teams/${team.id}`, "DELETE", undefined],
  ] as const)
    expect((await request(path, method, body, member.cookie)).status).toBe(403);
});

it("keeps private file and recording capabilities scoped to their workspace", async () => {
  const first = await workspace(),
    second = await workspace();
  const fileId = id(),
    personId = id(),
    callId = id(),
    key = `${first.org}/${fileId}`;
  await env.MEDIA.put(key, "synthetic private media");
  await sql(
    "INSERT INTO files(id,org_id,name,object_key,content_type,size) VALUES(?,?,?,?,?,?)",
    fileId,
    first.org,
    "fixture.txt",
    key,
    "text/plain",
    23,
  ).run();
  await sql(
    "INSERT INTO people(id,org_id,name) VALUES(?,?,?)",
    personId,
    first.org,
    "Synthetic lead",
  ).run();
  await sql(
    "INSERT INTO calls(id,org_id,person_id,phone,recorder_token_hash,token_expires_at,recording_key) VALUES(?,?,?,?,?,?,?)",
    callId,
    first.org,
    personId,
    "+12025550100",
    await digest("synthetic-recorder-token"),
    new Date(Date.now() + 600000).toISOString(),
    key,
  ).run();
  expect(
    (await request(`/files/${fileId}`, "GET", undefined, first.owner.cookie))
      .status,
  ).toBe(200);
  expect(
    (await request(`/files/${fileId}`, "GET", undefined, second.owner.cookie))
      .status,
  ).toBe(404);
  expect(
    (
      await request(
        `/files/${fileId}`,
        "DELETE",
        undefined,
        second.owner.cookie,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await request(
        `/calls/${callId}/recording`,
        "GET",
        undefined,
        second.owner.cookie,
      )
    ).status,
  ).toBe(404);
  expect((await request(`/recordings/${callId}`, "GET")).status).toBe(403);
  expect(await (await env.MEDIA.get(key))?.text()).toBe(
    "synthetic private media",
  );
});

it("rejects stale approval if another operator edits the draft before it is queued", async () => {
  const { org, owner } = await workspace();
  const personId = id(),
    draftId = id();
  await sql(
    "INSERT INTO people(id,org_id,name,email) VALUES(?,?,?,?)",
    personId,
    org,
    "Synthetic lead",
    `${id()}@example.invalid`,
  ).run();
  await sql(
    "INSERT INTO drafts(id,org_id,person_id,channel,body) VALUES(?,?,?,'email','Content initially approved')",
    draftId,
    org,
    personId,
  ).run();
  const bindings = beforeBatch(async () => {
    expect(
      (
        await request(
          `/drafts/${draftId}`,
          "PATCH",
          { body: "Content changed by another operator" },
          owner.cookie,
        )
      ).status,
    ).toBe(200);
  });
  const response = await request(
    `/drafts/${draftId}/send`,
    "POST",
    {},
    owner.cookie,
    bindings,
  );
  expect(response.status).toBe(409);
  expect(
    (await sql("SELECT status FROM drafts WHERE id=?", draftId).first<Row>())
      ?.status,
  ).toBe("pending");
  expect(
    await sql("SELECT id FROM jobs WHERE id=?", `draft:${draftId}`).first(),
  ).toBeNull();
});

it("does not restore a removed workspace member through an overlapping team edit", async () => {
  const { org, owner } = await workspace();
  const teammate = await account(org, "member");
  const created = await request(
    "/teams",
    "POST",
    { name: "Synthetic team removal race" },
    owner.cookie,
  );
  const team = (await created.json()) as Row;
  const bindings = beforeBatch(async () => {
    expect(
      (
        await request(
          `/members/${teammate.uid}`,
          "DELETE",
          undefined,
          owner.cookie,
        )
      ).status,
    ).toBe(200);
  });
  await request(
    `/teams/${team.id}`,
    "PATCH",
    { members: [teammate.uid] },
    owner.cookie,
    bindings,
  );
  expect(
    await sql(
      "SELECT 1 FROM members WHERE org_id=? AND user_id=?",
      org,
      teammate.uid,
    ).first(),
  ).toBeNull();
  expect(
    await sql(
      "SELECT 1 FROM team_members WHERE team_id=? AND user_id=?",
      team.id,
      teammate.uid,
    ).first(),
  ).toBeNull();
});

it("does not create a login session from old credentials after password recovery completes", async () => {
  const { owner } = await workspace();
  const raw = await recoveryLink(owner.uid);
  let recovered = false;
  const bindings = beforeSessionInsert(async () => {
    recovered = true;
    expect(
      (
        await request("/auth/reset-password", "POST", {
          token: raw,
          password: "synthetic-recovered-login-password",
        })
      ).status,
    ).toBe(200);
  });
  const response = await request(
    "/auth/login",
    "POST",
    { email: owner.email, password },
    "",
    bindings,
  );
  expect(recovered).toBe(true);
  expect(response.status).toBe(401);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(
    await sql(
      "SELECT token_hash FROM sessions WHERE user_id=?",
      owner.uid,
    ).first(),
  ).toBeNull();
});

it("does not revive a revoked session through an overlapping workspace switch", async () => {
  const first = await workspace(),
    second = await workspace();
  await sql(
    "INSERT INTO members(org_id,user_id,role) VALUES(?,?,'member')",
    second.org,
    first.owner.uid,
  ).run();
  const raw = await recoveryLink(first.owner.uid);
  let recovered = false;
  const bindings = beforeSessionInsert(async () => {
    recovered = true;
    expect(
      (
        await request("/auth/reset-password", "POST", {
          token: raw,
          password: "synthetic-recovered-switch-password",
        })
      ).status,
    ).toBe(200);
  });
  const response = await request(
    `/organizations/${second.org}/switch`,
    "POST",
    {},
    first.owner.cookie,
    bindings,
  );
  expect(recovered).toBe(true);
  expect(response.status).toBe(401);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(
    await sql(
      "SELECT token_hash FROM sessions WHERE user_id=?",
      first.owner.uid,
    ).first(),
  ).toBeNull();
});
