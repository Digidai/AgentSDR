import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, Ctx, Env, Identity, Row } from "./types";
import {
  constantEqual,
  digest,
  emailValid,
  hashPassword,
  id,
  now,
  text,
  token,
  verifyPassword,
} from "./core";

export async function limit(env: Env, key: string, max: number, seconds = 900) {
  const period = Math.floor(Date.now() / 1000 / seconds);
  const k = `${key}:${period}`;
  const row = await env.DB.prepare(
    "INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count",
  )
    .bind(k, (period + 1) * seconds)
    .first<{ count: number }>();
  if ((row?.count || 0) > max)
    throw new HTTPException(429, {
      message: "Too many attempts. Please try again later.",
    });
}
export async function identity(c: Ctx) {
  const raw = getCookie(c, "sdr_session");
  if (!raw) return null;
  return c.env.DB.prepare(
    "SELECT u.id,u.name,u.email,s.org_id,m.role,o.name org_name FROM sessions s JOIN organizations o ON o.id=s.org_id JOIN users u ON u.id=s.user_id JOIN members m ON m.user_id=u.id AND m.org_id=s.org_id WHERE s.token_hash=? AND s.expires_at>?",
  )
    .bind(await digest(raw), now())
    .first<Identity>();
}
export async function requireUser(c: Ctx, next: () => Promise<void>) {
  const user = await identity(c);
  if (!user)
    throw new HTTPException(401, { message: "Please sign in to continue" });
  c.set("user", user);
  await next();
}
export function requireAdmin(c: Ctx) {
  if (!["owner", "admin"].includes(c.get("user").role))
    throw new HTTPException(403, {
      message: "An administrator account is required",
    });
}
export async function session(
  c: Ctx,
  user: Identity | Row,
  authentication: { passwordHash?: string; sourceSessionHash?: string } = {},
) {
  const raw = token(),
    tokenHash = await digest(raw);
  const conditions = [
    "EXISTS(SELECT 1 FROM members WHERE user_id=? AND org_id=?)",
  ];
  const args = [user.id, user.org_id];
  if (authentication.passwordHash) {
    conditions.push(
      "EXISTS(SELECT 1 FROM users WHERE id=? AND password_hash=?)",
    );
    args.push(user.id, authentication.passwordHash);
  }
  if (authentication.sourceSessionHash) {
    conditions.push(
      "EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?)",
    );
    args.push(authentication.sourceSessionHash, user.id, now());
  }
  const statement = c.env.DB.prepare(
    `INSERT INTO sessions(token_hash,user_id,org_id,expires_at) SELECT ?,?,?,? WHERE ${conditions.join(" AND ")}`,
  ).bind(
    tokenHash,
    user.id,
    user.org_id,
    new Date(Date.now() + 7 * 86400000).toISOString(),
    ...args,
  );
  const result = authentication.sourceSessionHash
    ? (
        await c.env.DB.batch([
          statement,
          c.env.DB.prepare(
            "DELETE FROM sessions WHERE token_hash=? AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=?)",
          ).bind(authentication.sourceSessionHash, tokenHash),
        ])
      )[0]
    : await statement.run();
  if (!result.meta.changes)
    throw new HTTPException(401, { message: "Please sign in again" });
  setCookie(c, "sdr_session", raw, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: 7 * 86400,
  });
}
export async function acceptInvitation(
  env: Env,
  invitation: Row,
  uid: string,
  newUser?: { name: string; passwordHash: string; emailVerified?: boolean },
  expectedPasswordHash?: string,
) {
  const at = now();
  const credentials = expectedPasswordHash
    ? " AND EXISTS(SELECT 1 FROM users WHERE id=? AND password_hash=?)"
    : "";
  const credentialArgs = expectedPasswordHash
    ? [uid, expectedPasswordHash]
    : [];
  const available =
    "EXISTS(SELECT 1 FROM invitations WHERE id=? AND token_hash=? AND used_at IS NULL AND expires_at>?)" +
    credentials;
  const claim = [invitation.id, invitation.token_hash, at, ...credentialArgs];
  const statements: D1PreparedStatement[] = [];
  // D1 batches are atomic. Recheck the invitation inside every grant statement,
  // then consume it in the same batch so a revoked or competing claim grants nothing.
  if (newUser)
    statements.push(
      env.DB.prepare(
        `INSERT INTO users(id,email,name,password_hash,email_verified) SELECT ?,?,?,?,? WHERE ${available}`,
      ).bind(
        uid,
        invitation.email,
        newUser.name,
        newUser.passwordHash,
        newUser.emailVerified ? 1 : 0,
        ...claim,
      ),
    );
  statements.push(
    env.DB.prepare(
      `INSERT OR IGNORE INTO members(org_id,user_id,role) SELECT ?,?,? WHERE ${available}`,
    ).bind(invitation.org_id, uid, invitation.role, ...claim),
    env.DB.prepare(
      "UPDATE invitations SET used_at=? WHERE id=? AND token_hash=? AND used_at IS NULL AND expires_at>?" +
        credentials,
    ).bind(at, ...claim),
  );
  const result = await env.DB.batch(statements);
  if (!result[result.length - 1].meta.changes) {
    if (
      expectedPasswordHash &&
      !(await env.DB.prepare(
        "SELECT id FROM users WHERE id=? AND password_hash=?",
      )
        .bind(uid, expectedPasswordHash)
        .first())
    )
      throw new HTTPException(401, {
        message: "Use your existing account password",
      });
    throw new HTTPException(400, {
      message: "This invitation is invalid or has expired",
    });
  }
}
function validCredentials(body: Row) {
  if (
    !emailValid(text(body.email)) ||
    String(body.password || "").length < 12 ||
    String(body.password).length > 128
  )
    throw new HTTPException(400, {
      message: "Use a valid email and a password between 12 and 128 characters",
    });
}
export const authRoutes = new Hono<AppEnv>();
authRoutes.get("/status", async (c) => {
  const user = await identity(c);
  const initialized = !!(await c.env.DB.prepare(
    "SELECT id FROM setup_claim WHERE id=1",
  ).first());
  return c.json({ initialized, user, version: c.env.RELEASE || "development" });
});
authRoutes.post("/setup", async (c) => {
  await limit(c.env, `setup:${c.req.header("CF-Connecting-IP") || "local"}`, 5);
  const body = await c.req.json<Row>();
  if (
    !c.env.BOOTSTRAP_TOKEN ||
    !constantEqual(String(body.token || ""), c.env.BOOTSTRAP_TOKEN)
  )
    throw new HTTPException(403, {
      message: "Open the private setup link provided with this deployment",
    });
  if (await c.env.DB.prepare("SELECT id FROM setup_claim WHERE id=1").first())
    throw new HTTPException(409, {
      message: "Workspace is already set up. Sign in to continue.",
    });
  validCredentials(body);
  if (!text(body.name, 100) || !text(body.organization, 100))
    throw new HTTPException(400, {
      message: "Your name and workspace name are required",
    });
  const uid = id(),
    oid = id(),
    password = await hashPassword(body.password);
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO setup_claim(id,user_id) VALUES(1,?)").bind(
      uid,
    ),
    c.env.DB.prepare(
      "INSERT INTO users(id,email,name,password_hash) VALUES(?,?,?,?)",
    ).bind(uid, text(body.email).toLowerCase(), text(body.name, 100), password),
    c.env.DB.prepare("INSERT INTO organizations(id,name) VALUES(?,?)").bind(
      oid,
      text(body.organization, 100),
    ),
    c.env.DB.prepare(
      "INSERT INTO members(org_id,user_id,role) VALUES(?,?,'owner')",
    ).bind(oid, uid),
  ]);
  await session(c, { id: uid, org_id: oid });
  return c.json({ ok: true }, 201);
});
authRoutes.post("/login", async (c) => {
  await limit(
    c.env,
    `login:${c.req.header("CF-Connecting-IP") || "local"}`,
    12,
  );
  const body = await c.req.json<Row>();
  const email = text(body.email, 254).toLowerCase();
  if (String(body.password || "").length > 128)
    throw new HTTPException(400, { message: "Invalid credentials" });
  const user = await c.env.DB.prepare(
    "SELECT u.*,m.org_id,m.role FROM users u JOIN members m ON m.user_id=u.id WHERE u.email=? ORDER BY m.rowid LIMIT 1",
  )
    .bind(email)
    .first<Row>();
  const dummy =
    "pbkdf2:100000:AAAAAAAAAAAAAAAAAAAAAA==:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const valid = await verifyPassword(
    String(body.password || ""),
    user?.password_hash || dummy,
  );
  if (!user || !valid)
    throw new HTTPException(401, { message: "Email or password is incorrect" });
  await session(c, user, { passwordHash: user.password_hash });
  return c.json({ ok: true });
});
authRoutes.post("/logout", async (c) => {
  const raw = getCookie(c, "sdr_session");
  if (raw)
    await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash=?")
      .bind(await digest(raw))
      .run();
  deleteCookie(c, "sdr_session", { path: "/" });
  return c.json({ ok: true });
});
authRoutes.post("/password", requireUser, async (c) => {
  const b = await c.req.json<Row>();
  validCredentials({ email: c.get("user").email, password: b.password });
  const user = await c.env.DB.prepare(
    "SELECT password_hash FROM users WHERE id=?",
  )
    .bind(c.get("user").id)
    .first<{ password_hash: string }>();
  if (
    !user ||
    !(await verifyPassword(String(b.current || ""), user.password_hash))
  )
    throw new HTTPException(400, { message: "Current password is incorrect" });
  const password = await hashPassword(b.password);
  const result = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE users SET password_hash=? WHERE id=? AND password_hash=?",
    ).bind(password, c.get("user").id, user.password_hash),
    c.env.DB.prepare(
      "DELETE FROM sessions WHERE user_id=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND password_hash=?)",
    ).bind(c.get("user").id, c.get("user").id, password),
    c.env.DB.prepare(
      "UPDATE auth_tokens SET used_at=? WHERE user_id=? AND kind='reset' AND used_at IS NULL AND EXISTS(SELECT 1 FROM users WHERE id=? AND password_hash=?)",
    ).bind(now(), c.get("user").id, c.get("user").id, password),
  ]);
  if (!result[0].meta.changes)
    throw new HTTPException(400, { message: "Current password is incorrect" });
  await session(c, c.get("user"), { passwordHash: password });
  return c.json({ ok: true });
});
authRoutes.post("/invitation", async (c) => {
  await limit(
    c.env,
    `invite:${c.req.header("CF-Connecting-IP") || "local"}`,
    8,
  );
  const b = await c.req.json<Row>();
  const invitation = await c.env.DB.prepare(
    "SELECT * FROM invitations WHERE token_hash=? AND used_at IS NULL AND expires_at>?",
  )
    .bind(await digest(String(b.token || "")), now())
    .first<Row>();
  if (!invitation)
    throw new HTTPException(400, {
      message: "This invitation is invalid or has expired",
    });
  validCredentials({ email: invitation.email, password: b.password });
  let user = await c.env.DB.prepare("SELECT * FROM users WHERE email=?")
    .bind(invitation.email)
    .first<Row>();
  if (user && !(await verifyPassword(b.password, user.password_hash)))
    throw new HTTPException(401, {
      message: "Use your existing account password",
    });
  const uid = user?.id || id(),
    passwordHash = user?.password_hash || (await hashPassword(b.password));
  await acceptInvitation(
    c.env,
    invitation,
    uid,
    user
      ? undefined
      : {
          name: text(b.name, 100) || invitation.email,
          passwordHash,
        },
    user?.password_hash,
  );
  await session(c, { id: uid, org_id: invitation.org_id }, { passwordHash });
  return c.json({ ok: true });
});
