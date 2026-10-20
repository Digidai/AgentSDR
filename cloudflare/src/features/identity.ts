import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv, Ctx, Env, Row } from "../types";
import {
  constantEqual,
  digest,
  emailValid,
  hashPassword,
  id,
  json,
  now,
  text,
  token,
} from "../core";
import {
  acceptInvitation,
  identity,
  limit,
  requireAdmin,
  session,
} from "../auth";
import { integration, requestJson } from "../providers";
import { base64url, decodeBase64url } from "./google";
import { ensure, orgId, record } from "./shared";
export const publicIdentity = new Hono<AppEnv>();
export const identityFeatures = new Hono<AppEnv>();
async function firstOrg(env: Env) {
  const row = await env.DB.prepare(
    "SELECT m.org_id FROM setup_claim c JOIN members m ON m.user_id=c.user_id WHERE c.id=1 ORDER BY m.rowid LIMIT 1",
  ).first<{ org_id: string }>();
  return row?.org_id;
}
export async function authMail(
  env: Env,
  org: string,
  to: string,
  subject: string,
  body: string,
  requestId = id(),
) {
  const config = await integration(env, org, "resend");
  const key = config?.api_key || env.RESEND_API_KEY,
    from = config?.from_address || env.AUTH_EMAIL_FROM;
  ensure(key && from, "Configure an authentication email sender first");
  await requestJson(
    "https://api.resend.com/emails",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "Idempotency-Key": requestId,
      },
      body: JSON.stringify({ from, to: [to], subject, text: body }),
    },
    true,
  );
}
async function googleConfig(env: Env) {
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
    return {
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
    };
  const org = await firstOrg(env);
  return org ? await integration(env, org, "google-signin") : null;
}
publicIdentity.get("/auth/options", async (c) => {
  const org = await firstOrg(c.env),
    sender = org ? await integration(c.env, org, "resend") : null;
  return c.json({
    google: !!(await googleConfig(c.env)),
    email: !!(sender || c.env.RESEND_API_KEY),
  });
});
publicIdentity.post("/auth/forgot-password", async (c) => {
  await limit(c.env, `reset:${c.req.header("CF-Connecting-IP") || "local"}`, 5);
  const b = await c.req.json<Row>(),
    email = text(b.email, 254).toLowerCase();
  ensure(emailValid(email), "Enter a valid email address");
  const user = await c.env.DB.prepare(
    "SELECT u.id,m.org_id FROM users u JOIN members m ON m.user_id=u.id WHERE u.email=? ORDER BY EXISTS(SELECT 1 FROM integrations i WHERE i.org_id=m.org_id AND i.kind='resend') DESC,m.rowid LIMIT 1",
  )
    .bind(email)
    .first<Row>();
  if (user) {
    const raw = token();
    await c.env.DB.prepare(
      "INSERT INTO auth_tokens(id,user_id,email,kind,token_hash,expires_at) VALUES(?,?,?,?,?,?)",
    )
      .bind(
        id(),
        user.id,
        email,
        "reset",
        await digest(raw),
        new Date(Date.now() + 3600000).toISOString(),
      )
      .run();
    try {
      await authMail(
        c.env,
        user.org_id,
        email,
        "Reset your AgentSDR password",
        `Use this private link within one hour: ${c.env.APP_URL}/reset-password#token=${raw}`,
      );
    } catch {
      console.error("Authentication email could not be delivered");
    }
  }
  return c.json({
    ok: true,
    message: "If this address has an account, a reset email will be sent.",
  });
});
publicIdentity.post("/auth/reset-password", async (c) => {
  await limit(
    c.env,
    `reset-confirm:${c.req.header("CF-Connecting-IP") || "local"}`,
    8,
  );
  const b = await c.req.json<Row>();
  ensure(
    typeof b.password === "string" &&
      b.password.length >= 12 &&
      b.password.length <= 128,
    "Use a password between 12 and 128 characters",
  );
  const tokenHash = await digest(String(b.token || ""));
  const row = await c.env.DB.prepare(
    "SELECT user_id FROM auth_tokens WHERE token_hash=? AND kind='reset' AND used_at IS NULL AND expires_at>?",
  )
    .bind(tokenHash, now())
    .first<{ user_id: string }>();
  ensure(row, "Reset link is invalid or expired");
  const password = await hashPassword(b.password);
  // A token is consumed only with its password change and session revocation.
  // The fresh salted hash identifies this batch if a competing reset won first.
  const result = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE users SET password_hash=? WHERE id=? AND EXISTS(SELECT 1 FROM auth_tokens WHERE token_hash=? AND kind='reset' AND used_at IS NULL AND expires_at>?)",
    ).bind(password, row.user_id, tokenHash, now()),
    c.env.DB.prepare(
      "DELETE FROM sessions WHERE user_id=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND password_hash=?)",
    ).bind(row.user_id, row.user_id, password),
    c.env.DB.prepare(
      "UPDATE auth_tokens SET used_at=? WHERE user_id=? AND kind='reset' AND used_at IS NULL AND EXISTS(SELECT 1 FROM users WHERE id=? AND password_hash=?)",
    ).bind(now(), row.user_id, row.user_id, password),
  ]);
  ensure(result[0].meta.changes, "Reset link is invalid or expired");
  return c.json({ ok: true });
});
publicIdentity.get("/auth/verify-email", async (c) => {
  const row = await c.env.DB.prepare(
    "UPDATE auth_tokens SET used_at=? WHERE token_hash=? AND kind='verify' AND used_at IS NULL AND expires_at>? RETURNING user_id",
  )
    .bind(now(), await digest(c.req.query("token") || ""), now())
    .first<{ user_id: string }>();
  ensure(row, "Verification link is invalid or expired");
  await c.env.DB.prepare("UPDATE users SET email_verified=1 WHERE id=?")
    .bind(row.user_id)
    .run();
  return c.redirect("/?verified=1");
});
publicIdentity.get("/auth/google", async (c) => {
  const config = await googleConfig(c.env);
  ensure(config, "Google sign-in is not configured");
  const state = token(),
    verifier = token(),
    nonce = token();
  await c.env.DB.prepare(
    "INSERT INTO auth_tokens(id,kind,token_hash,expires_at,payload) VALUES(?,?,?,?,?)",
  )
    .bind(
      id(),
      "oauth",
      await digest(state),
      new Date(Date.now() + 600000).toISOString(),
      JSON.stringify({ verifier, nonce }),
    )
    .run();
  setCookie(c, "sdr_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/api/auth",
    maxAge: 600,
  });
  const params = new URLSearchParams({
    client_id: config.client_id,
    redirect_uri: `${c.env.APP_URL}/api/auth/callback/google`,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: base64url(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier),
        ),
      ),
    ),
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return c.redirect("https://accounts.google.com/o/oauth2/v2/auth?" + params);
});
publicIdentity.get("/auth/callback/google", async (c) => {
  const state = c.req.query("state") || "",
    cookie = getCookie(c, "sdr_oauth_state") || "";
  ensure(state && constantEqual(state, cookie), "Invalid OAuth state");
  deleteCookie(c, "sdr_oauth_state", { path: "/api/auth" });
  const raw = await c.env.DB.prepare(
    "UPDATE auth_tokens SET used_at=? WHERE token_hash=? AND kind='oauth' AND used_at IS NULL AND expires_at>? RETURNING payload",
  )
    .bind(now(), await digest(state), now())
    .first<{ payload: string }>();
  ensure(raw, "OAuth request expired");
  const { verifier, nonce } = json<Row>(raw.payload, {}),
    config = await googleConfig(c.env);
  ensure(config, "Google sign-in is not configured");
  const result = await requestJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: c.req.query("code") || "",
      client_id: config.client_id,
      client_secret: config.client_secret,
      redirect_uri: `${c.env.APP_URL}/api/auth/callback/google`,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  const parts = String(result.id_token || "").split(".");
  ensure(parts.length === 3, "Missing Google identity token");
  const head = JSON.parse(new TextDecoder().decode(decodeBase64url(parts[0]))),
    claims = JSON.parse(new TextDecoder().decode(decodeBase64url(parts[1])));
  ensure(
    head.alg === "RS256" &&
      claims.nonce === nonce &&
      claims.aud === config.client_id &&
      ["https://accounts.google.com", "accounts.google.com"].includes(
        claims.iss,
      ) &&
      claims.exp * 1000 > Date.now() &&
      claims.email_verified === true,
    "Invalid Google identity",
  );
  const keys = await requestJson("https://www.googleapis.com/oauth2/v3/certs");
  const jwk = keys.keys.find((k: Row) => k.kid === head.kid);
  ensure(jwk, "Google identity signing key is unavailable");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  ensure(
    await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decodeBase64url(parts[2]),
      new TextEncoder().encode(parts[0] + "." + parts[1]),
    ),
    "Invalid identity signature",
  );
  const email = String(claims.email).toLowerCase();
  let user = await c.env.DB.prepare(
    "SELECT u.*,m.org_id FROM users u JOIN members m ON m.user_id=u.id WHERE u.email=? ORDER BY m.rowid LIMIT 1",
  )
    .bind(email)
    .first<Row>();
  if (!user) {
    const invite = await c.env.DB.prepare(
      "SELECT * FROM invitations WHERE email=? AND used_at IS NULL AND expires_at>? ORDER BY expires_at LIMIT 1",
    )
      .bind(email, now())
      .first<Row>();
    ensure(invite, "This workspace is invitation only", 403);
    const uid = id();
    await acceptInvitation(c.env, invite, uid, {
      name: text(claims.name, 100) || email,
      passwordHash: await hashPassword(token()),
      emailVerified: true,
    });
    user = { id: uid, org_id: invite.org_id };
  }
  await session(c, user);
  return c.redirect("/");
});
identityFeatures.get("/organizations", async (c) => {
  const items = await c.env.DB.prepare(
    "SELECT o.*,m.role FROM organizations o JOIN members m ON m.org_id=o.id WHERE m.user_id=? ORDER BY o.created_at",
  )
    .bind(c.get("user").id)
    .all();
  return c.json({ items: items.results, active: orgId(c) });
});
identityFeatures.post("/organizations", async (c) => {
  const initial = await firstOrg(c.env);
  const allowed =
    initial &&
    (await c.env.DB.prepare(
      "SELECT role FROM members WHERE org_id=? AND user_id=? AND role IN ('owner','admin')",
    )
      .bind(initial, c.get("user").id)
      .first());
  ensure(
    allowed,
    "An administrator of the initial workspace must create organizations",
    403,
  );
  const b = await c.req.json<Row>();
  ensure(text(b.name, 100), "Workspace name is required");
  const oid = id(),
    slug = text(b.slug, 100) || oid;
  ensure(
    /^[a-z0-9-]+$/.test(slug),
    "Use lowercase letters, numbers and dashes",
  );
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO organizations(id,name,slug,logo) VALUES(?,?,?,?)",
    ).bind(oid, text(b.name, 100), slug, text(b.logo, 1000)),
    c.env.DB.prepare(
      "INSERT INTO members(org_id,user_id,role) VALUES(?,?,'owner')",
    ).bind(oid, c.get("user").id),
  ]);
  return c.json({ id: oid }, 201);
});
identityFeatures.post("/organizations/:id/switch", async (c) => {
  const member = await c.env.DB.prepare(
    "SELECT role FROM members WHERE user_id=? AND org_id=?",
  )
    .bind(c.get("user").id, c.req.param("id"))
    .first();
  ensure(member, "Workspace not found", 404);
  const existing = getCookie(c, "sdr_session");
  ensure(existing, "Please sign in again", 403);
  await session(
    c,
    { ...c.get("user"), org_id: c.req.param("id") },
    { sourceSessionHash: await digest(existing) },
  );
  return c.json({ ok: true });
});
identityFeatures.patch("/organizations/:id", async (c) => {
  ensure(c.req.param("id") === orgId(c), "Workspace not found", 404);
  requireAdmin(c);
  const b = await c.req.json<Row>();
  if (b.slug)
    ensure(/^[a-z0-9-]{1,100}$/.test(b.slug), "Invalid workspace URL name");
  await c.env.DB.prepare(
    "UPDATE organizations SET name=COALESCE(?,name),slug=COALESCE(?,slug),logo=COALESCE(?,logo) WHERE id=?",
  )
    .bind(
      b.name ? text(b.name, 100) : null,
      b.slug || null,
      b.logo === undefined ? null : text(b.logo, 1000),
      orgId(c),
    )
    .run();
  return c.json({ ok: true });
});
identityFeatures.get("/teams", async (c) => {
  const teams = await c.env.DB.prepare(
    "SELECT * FROM teams WHERE org_id=? ORDER BY name",
  )
    .bind(orgId(c))
    .all<Row>();
  for (const t of teams.results) {
    const members = await c.env.DB.prepare(
      "SELECT u.id,u.name,u.email FROM team_members tm JOIN users u ON u.id=tm.user_id WHERE tm.team_id=?",
    )
      .bind(t.id)
      .all();
    t.members = members.results;
  }
  return c.json({ items: teams.results });
});
identityFeatures.post("/teams", async (c) => {
  requireAdmin(c);
  const b = await c.req.json<Row>();
  ensure(text(b.name, 100), "Team name is required");
  const tid = id();
  await c.env.DB.prepare("INSERT INTO teams(id,org_id,name) VALUES(?,?,?)")
    .bind(tid, orgId(c), text(b.name, 100))
    .run();
  return c.json({ id: tid }, 201);
});
identityFeatures.patch("/teams/:id", async (c) => {
  requireAdmin(c);
  const team = await record(c.env, orgId(c), "teams", c.req.param("id")),
    b = await c.req.json<Row>();
  if (b.name)
    await c.env.DB.prepare("UPDATE teams SET name=? WHERE id=? AND org_id=?")
      .bind(text(b.name, 100), team.id, orgId(c))
      .run();
  if (Array.isArray(b.members)) {
    for (const uid of b.members)
      ensure(
        await c.env.DB.prepare(
          "SELECT 1 FROM members WHERE org_id=? AND user_id=?",
        )
          .bind(orgId(c), uid)
          .first(),
        "Team members must belong to the workspace",
      );
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM team_members WHERE team_id=?").bind(
        team.id,
      ),
      ...b.members.map((uid: string) =>
        c.env.DB.prepare(
          "INSERT INTO team_members(team_id,user_id) SELECT ?,user_id FROM members WHERE org_id=? AND user_id=?",
        ).bind(team.id, orgId(c), uid),
      ),
    ]);
  }
  return c.json({ ok: true });
});
identityFeatures.delete("/teams/:id", async (c) => {
  requireAdmin(c);
  await record(c.env, orgId(c), "teams", c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM teams WHERE id=? AND org_id=?")
    .bind(c.req.param("id"), orgId(c))
    .run();
  return c.json({ ok: true });
});
identityFeatures.patch("/members/:id", async (c) => {
  requireAdmin(c);
  const b = await c.req.json<Row>();
  ensure(["owner", "admin", "member"].includes(b.role), "Invalid role");
  const current = await c.env.DB.prepare(
    "SELECT role FROM members WHERE org_id=? AND user_id=?",
  )
    .bind(orgId(c), c.req.param("id"))
    .first<Row>();
  ensure(current, "Member not found", 404);
  ensure(
    (current.role !== "owner" && b.role !== "owner") ||
      c.get("user").role === "owner",
    "Only owners can manage owners",
    403,
  );
  // Keep the owner invariant in the same SQLite statement as the mutation.
  // Checking COUNT before UPDATE lets two concurrent demotions remove both.
  const updated = await c.env.DB.prepare(
    "UPDATE members SET role=? WHERE org_id=? AND user_id=? AND (role<>'owner' OR ?='owner') AND (role<>'owner' OR ?='owner' OR (SELECT COUNT(*) FROM members WHERE org_id=? AND role='owner')>1) RETURNING user_id",
  )
    .bind(
      b.role,
      orgId(c),
      c.req.param("id"),
      c.get("user").role,
      b.role,
      orgId(c),
    )
    .first();
  ensure(
    updated,
    c.get("user").role === "owner"
      ? "Keep at least one workspace owner"
      : "Only owners can manage owners",
    c.get("user").role === "owner" ? 400 : 403,
  );
  return c.json({ ok: true });
});
identityFeatures.get("/invitations", async (c) => {
  requireAdmin(c);
  const rows = await c.env.DB.prepare(
    "SELECT id,email,role,expires_at,used_at FROM invitations WHERE org_id=? ORDER BY expires_at DESC",
  )
    .bind(orgId(c))
    .all();
  return c.json({ items: rows.results });
});
identityFeatures.delete("/invitations/:id", async (c) => {
  requireAdmin(c);
  await c.env.DB.prepare("DELETE FROM invitations WHERE id=? AND org_id=?")
    .bind(c.req.param("id"), orgId(c))
    .run();
  return c.json({ ok: true });
});
identityFeatures.post("/members/invite", async (c) => {
  requireAdmin(c);
  const b = await c.req.json<Row>();
  ensure(emailValid(text(b.email, 254)), "Enter a valid email");
  const raw = token(),
    iid = id(),
    email = text(b.email, 254).toLowerCase();
  await c.env.DB.prepare(
    "INSERT INTO invitations(id,org_id,email,role,token_hash,expires_at) VALUES(?,?,?,?,?,?)",
  )
    .bind(
      iid,
      orgId(c),
      email,
      b.role === "admin" ? "admin" : "member",
      await digest(raw),
      new Date(Date.now() + 7 * 86400000).toISOString(),
    )
    .run();
  const url = `${c.env.APP_URL}/#invite=${raw}`;
  if (b.sendEmail === true)
    await authMail(
      c.env,
      orgId(c),
      email,
      "You are invited to AgentSDR",
      `${c.get("user").name} invited you to a workspace. Accept within 7 days: ${url}`,
      iid,
    );
  return c.json({ id: iid, url, emailSent: b.sendEmail === true }, 201);
});
