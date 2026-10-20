import { purgePersonMedia } from "./features/shared";
import { receive } from "./inbound";
import { publicFeatures, featureRoutes } from "./features/runtime";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv, Row, Column, Env } from "./types";
import { authRoutes, requireAdmin, requireUser, limit } from "./auth";
import {
  constantEqual,
  decrypt,
  digest,
  emailValid,
  encrypt,
  escapeHtml,
  id,
  json,
  now,
  sign,
  text,
  token,
} from "./core";
import { enqueue, event } from "./jobs";
import { integration, ProviderError, validateIntegration } from "./providers";

export const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  const method = c.req.method,
    path = new URL(c.req.url).pathname;
  if (
    !["GET", "HEAD", "OPTIONS"].includes(method) &&
    !path.startsWith("/api/webhooks/") &&
    !path.startsWith("/api/channel-webhooks/") &&
    !path.startsWith("/api/outreach/webhooks/gmail-watch") &&
    !path.startsWith("/api/call-recorder/") &&
    !path.startsWith("/u/")
  ) {
    const origin = c.req.header("Origin");
    if (
      (origin && origin !== new URL(c.req.url).origin) ||
      c.req.header("Sec-Fetch-Site") === "cross-site"
    )
      throw new HTTPException(403, {
        message: "Request origin is not allowed",
      });
    if (
      ["POST", "PUT", "PATCH"].includes(method) &&
      path.startsWith("/api/") &&
      !c.req.header("Content-Type")?.startsWith("application/json") &&
      !path.startsWith("/api/files") &&
      !/^\/api\/calling\/contacts\/[^/]+\/photo$/.test(path)
    )
      throw new HTTPException(415, { message: "Use JSON requests" });
  }
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Robots-Tag", "noindex, nofollow");
  if (path.startsWith("/api/")) c.header("Cache-Control", "no-store");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
});
app.use(
  "/api/*",
  bodyLimit({
    maxSize: 22 * 1024 * 1024,
    onError: (c) => c.json({ error: "Request is too large" }, 413),
  }),
);
app.onError((error, c) => {
  if (error instanceof HTTPException)
    return c.json({ error: error.message }, error.status);
  if (error instanceof ProviderError)
    return c.json({ error: error.message }, error.status === 429 ? 429 : 502);
  console.error(
    "API failure",
    error.name,
    error.message.replace(/(?:Bearer |api_key=)[^\s&]+/g, "[redacted]"),
  );
  return c.json(
    { error: "The request could not be completed. Please try again." },
    500,
  );
});
app.get("/api/health", async (c) => {
  await c.env.DB.prepare("SELECT 1").first();
  return c.json({
    ok: true,
    app: "AgentSDR",
    edition: "cloudflare-native",
    release: c.env.RELEASE || "development",
  });
});
app.route("/api", publicFeatures);
app.route("/api/auth", authRoutes);

const stages = [
  "new",
  "contacted",
  "interested",
  "meeting",
  "customer",
  "lost",
];
const channels = ["email", "linkedin", "whatsapp"];
const api = new Hono<AppEnv>();
api.use("*", requireUser);
const check = (condition: unknown, message: string) => {
  if (!condition) throw new HTTPException(400, { message });
};
async function scoped(c: any, table: string, item: string) {
  const row = await c.env.DB.prepare(
    `SELECT * FROM ${table} WHERE id=? AND org_id=?`,
  )
    .bind(item, c.get("user").org_id)
    .first();
  if (!row) throw new HTTPException(404, { message: "Record not found" });
  return row as Row;
}
api.get("/overview", async (c) => {
  const org = c.get("user").org_id;
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      "SELECT COUNT(*) total,SUM(dnc) dnc,SUM(stage='interested') interested,SUM(stage='meeting') meetings,SUM(stage='customer') customers FROM people WHERE org_id=?",
    ).bind(org),
    c.env.DB.prepare(
      "SELECT COUNT(*) total,SUM(status='active') active FROM campaigns WHERE org_id=?",
    ).bind(org),
    c.env.DB.prepare(
      "SELECT COUNT(*) total,SUM(direction='outbound') sent,SUM(direction='inbound') replies FROM messages WHERE org_id=?",
    ).bind(org),
    c.env.DB.prepare(
      "SELECT COUNT(*) count FROM drafts WHERE org_id=? AND status='pending'",
    ).bind(org),
    c.env.DB.prepare(
      "SELECT * FROM events WHERE org_id=? ORDER BY created_at DESC LIMIT 12",
    ).bind(org),
    c.env.DB.prepare(
      "SELECT stage,COUNT(*) count FROM people WHERE org_id=? GROUP BY stage",
    ).bind(org),
    c.env.DB.prepare(
      "SELECT substr(created_at,1,10) day,SUM(direction='outbound') sent,SUM(direction='inbound') replies FROM messages WHERE org_id=? AND created_at>=? GROUP BY day ORDER BY day",
    ).bind(org, new Date(Date.now() - 29 * 86400000).toISOString()),
    c.env.DB.prepare(
      "SELECT channel,SUM(direction='outbound') sent,SUM(direction='inbound') replies FROM messages WHERE org_id=? GROUP BY channel",
    ).bind(org),
    c.env.DB.prepare(
      "SELECT COUNT(*) count FROM jobs WHERE org_id=? AND status IN ('failed','uncertain')",
    ).bind(org),
  ]);
  return c.json({
    people: results[0].results[0],
    campaigns: results[1].results[0],
    messages: results[2].results[0],
    drafts: (results[3].results[0] as Row)?.count || 0,
    activity: results[4].results,
    pipeline: results[5].results,
    trend: results[6].results,
    channels: results[7].results,
    failedJobs: (results[8].results[0] as Row)?.count || 0,
  });
});
api.get("/people", async (c) => {
  const page = Math.max(1, Math.min(10000, Number(c.req.query("page")) || 1)),
    q = text(c.req.query("q"), 200),
    stage = c.req.query("stage");
  let where = "org_id=?";
  const values: any[] = [c.get("user").org_id];
  if (q) {
    where +=
      " AND (instr(lower(name),lower(?))>0 OR instr(lower(email),lower(?))>0 OR instr(lower(company),lower(?))>0 OR instr(lower(title),lower(?))>0)";
    values.push(...Array(4).fill(q));
  }
  if (stage && stages.includes(stage)) {
    where += " AND stage=?";
    values.push(stage);
  }
  const [rows, total] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT * FROM people WHERE ${where} ORDER BY created_at DESC LIMIT 100 OFFSET ?`,
    ).bind(...values, (page - 1) * 100),
    c.env.DB.prepare(`SELECT COUNT(*) count FROM people WHERE ${where}`).bind(
      ...values,
    ),
  ]);
  return c.json({
    items: rows.results,
    total: (total.results[0] as Row)?.count || 0,
    page,
  });
});
function personValues(b: Row) {
  const email = text(b.email, 254).toLowerCase();
  check(!email || emailValid(email), "Email address is invalid");
  check(text(b.name, 200), "A lead name is required");
  return [
    text(b.name, 200),
    email || null,
    text(b.company, 300),
    text(b.title, 300),
    text(b.phone, 50),
    text(b.linkedin, 500),
    text(b.website, 500),
    stages.includes(b.stage) ? b.stage : "new",
    b.dnc ? 1 : 0,
    text(b.notes, 10000),
    JSON.stringify(
      Array.isArray(b.tags)
        ? b.tags.slice(0, 30).map((x: any) => text(x, 40))
        : [],
    ),
    JSON.stringify(b.custom && typeof b.custom === "object" ? b.custom : {}),
  ];
}
api.post("/people", async (c) => {
  const b = await c.req.json<Row>(),
    pid = id();
  const values = personValues(b);
  if (
    values[1] &&
    (await c.env.DB.prepare("SELECT id FROM people WHERE org_id=? AND email=?")
      .bind(c.get("user").org_id, values[1])
      .first())
  )
    throw new HTTPException(409, {
      message: "This email already exists in your leads",
    });
  await c.env.DB.prepare(
    "INSERT INTO people(id,org_id,name,email,company,title,phone,linkedin,website,stage,dnc,notes,tags,custom) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(pid, c.get("user").org_id, ...values)
    .run();
  await event(
    c.env,
    c.get("user").org_id,
    "lead.created",
    `Added ${values[0]}`,
    pid,
  );
  return c.json({ id: pid }, 201);
});
api.post("/people/import", async (c) => {
  const b = await c.req.json<Row>();
  check(
    Array.isArray(b.rows) && b.rows.length > 0 && b.rows.length <= 1000,
    "Import between 1 and 1,000 rows per request",
  );
  if (b.mode === "merge") {
    let created = 0,
      updated = 0;
    const failed: Row[] = [];
    for (const [index, row] of b.rows.entries())
      try {
        const v = personValues(row);
        let old = await c.env.DB.prepare(
          "SELECT * FROM people WHERE org_id=? AND ((? IS NOT NULL AND email=?) OR (?<>'' AND linkedin=?)) LIMIT 1",
        )
          .bind(c.get("user").org_id, v[1], v[1], v[5], v[5])
          .first<Row>();
        if (old) {
          const merge = personValues({
            ...old,
            ...Object.fromEntries(
              Object.entries(row).filter(
                ([, v]) => v !== "" && v !== null && v !== undefined,
              ),
            ),
            dnc: old.dnc || row.dnc,
            tags: json(old.tags, []),
            custom: { ...json<Row>(old.custom, {}), ...row.custom },
          });
          await c.env.DB.prepare(
            "UPDATE people SET name=?,email=?,company=?,title=?,phone=?,linkedin=?,website=?,stage=?,dnc=?,notes=?,tags=?,custom=?,updated_at=? WHERE id=? AND org_id=?",
          )
            .bind(...merge, now(), old.id, c.get("user").org_id)
            .run();
          updated++;
        } else {
          await c.env.DB.prepare(
            "INSERT INTO people(id,org_id,name,email,company,title,phone,linkedin,website,stage,dnc,notes,tags,custom) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          )
            .bind(id(), c.get("user").org_id, ...v)
            .run();
          created++;
        }
      } catch (error) {
        failed.push({
          row: index + 2,
          error: text((error as Error).message, 200),
        });
      }
    return c.json({ created, updated, failed, total: b.rows.length });
  }
  const rows = b.rows.map((x: Row) => ({ id: id(), values: personValues(x) }));
  let imported = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows
      .slice(i, i + 50)
      .map((row: any) =>
        c.env.DB.prepare(
          "INSERT OR IGNORE INTO people(id,org_id,name,email,company,title,phone,linkedin,website,stage,dnc,notes,tags,custom) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).bind(row.id, c.get("user").org_id, ...row.values),
      );
    const result = await c.env.DB.batch(batch);
    imported += result.reduce((a, r) => a + r.meta.changes, 0);
  }
  await event(
    c.env,
    c.get("user").org_id,
    "leads.imported",
    `Imported ${imported} leads; skipped ${rows.length - imported} duplicate emails`,
  );
  return c.json({ imported, skipped: rows.length - imported });
});
api.get("/people/export", async (c) => {
  const result = await c.env.DB.prepare(
    "SELECT name,email,company,title,phone,linkedin,website,stage,dnc,notes,custom FROM people WHERE org_id=? ORDER BY created_at LIMIT 20000",
  )
    .bind(c.get("user").org_id)
    .all();
  return c.json({
    items: result.results.map(({ custom, ...r }) => ({
      ...json<Row>(custom as string, {}),
      ...r,
    })),
  });
});
api.get("/people/:id", async (c) => {
  const p = await scoped(c, "people", c.req.param("id"));
  const [messages, drafts, files, enrollments] = await c.env.DB.batch([
    c.env.DB.prepare(
      "SELECT * FROM messages WHERE org_id=? AND person_id=? ORDER BY created_at DESC LIMIT 100",
    ).bind(p.org_id, p.id),
    c.env.DB.prepare(
      "SELECT * FROM drafts WHERE org_id=? AND person_id=? AND status!='sent' ORDER BY created_at DESC",
    ).bind(p.org_id, p.id),
    c.env.DB.prepare(
      "SELECT id,name,size,content_type,transcript,created_at FROM files WHERE org_id=? AND person_id=? ORDER BY created_at DESC",
    ).bind(p.org_id, p.id),
    c.env.DB.prepare(
      "SELECT e.*,c.name FROM enrollments e JOIN campaigns c ON c.id=e.campaign_id AND c.org_id=e.org_id WHERE e.org_id=? AND e.person_id=?",
    ).bind(p.org_id, p.id),
  ]);
  return c.json({
    ...p,
    messages: messages.results,
    drafts: drafts.results,
    files: files.results,
    enrollments: enrollments.results,
  });
});
api.patch("/people/:id", async (c) => {
  const old = await scoped(c, "people", c.req.param("id")),
    b = await c.req.json<Row>(),
    v = personValues({
      ...old,
      ...b,
      tags: b.tags ?? json(old.tags, []),
      custom: b.custom ?? json(old.custom, {}),
    });
  await c.env.DB.prepare(
    "UPDATE people SET name=?,email=?,company=?,title=?,phone=?,linkedin=?,website=?,stage=?,dnc=?,notes=?,tags=?,custom=?,updated_at=? WHERE id=? AND org_id=?",
  )
    .bind(...v, now(), old.id, old.org_id)
    .run();
  if (v[8]) {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE crm_enrollments SET status='stopped' WHERE org_id=? AND person_id=? AND status IN ('active','paused')",
      ).bind(old.org_id, old.id),
      c.env.DB.prepare(
        "UPDATE drafts SET status='discarded' WHERE org_id=? AND person_id=? AND status='pending'",
      ).bind(old.org_id, old.id),
    ]);
    await c.env.DB.prepare(
      "UPDATE enrollments SET status='stopped' WHERE org_id=? AND person_id=? AND status='active'",
    )
      .bind(old.org_id, old.id)
      .run();
  }
  await event(c.env, old.org_id, "lead.updated", `Updated ${v[0]}`, old.id);
  return c.json({ ok: true });
});
api.delete("/people/:id", async (c) => {
  await scoped(c, "people", c.req.param("id"));
  await purgePersonMedia(c.env, c.get("user").org_id, c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM people WHERE id=? AND org_id=?")
    .bind(c.req.param("id"), c.get("user").org_id)
    .run();
  return c.json({ ok: true });
});
api.get("/companies", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT company name,website domain,COUNT(*) people FROM people WHERE org_id=? AND company!='' GROUP BY company ORDER BY people DESC LIMIT 1000",
  )
    .bind(c.get("user").org_id)
    .all();
  return c.json({ items: rows.results });
});
api.get("/campaigns", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT c.*,(SELECT COUNT(*) FROM enrollments e WHERE e.campaign_id=c.id AND e.org_id=c.org_id) leads,(SELECT COUNT(*) FROM messages m WHERE m.campaign_id=c.id AND m.org_id=c.org_id AND m.direction='outbound') sent FROM campaigns c WHERE c.org_id=? ORDER BY c.created_at DESC",
  )
    .bind(c.get("user").org_id)
    .all();
  return c.json({ items: rows.results });
});
function validateSteps(input: unknown, channel?: string) {
  check(
    Array.isArray(input) && input.length > 0 && input.length <= 20,
    "Add between 1 and 20 sequence steps",
  );
  return (input as Row[]).map((s, i) => {
    check(
      text(s.body, 10000) || (channel === "linkedin" && s.action === "invite"),
      "Each step needs a message",
    );
    const delay = Number(s.delay_minutes) || 0;
    check(delay >= 0 && delay <= 525600, "Invalid sequence delay");
    return {
      id: id(),
      position: i,
      delay_minutes: Math.floor(delay),
      subject: text(s.subject, 300),
      body: text(s.body, 10000),
      action: s.action === "invite" ? "invite" : "message",
    };
  });
}
api.post("/campaigns", async (c) => {
  const b = await c.req.json<Row>();
  check(text(b.name, 200), "Campaign name is required");
  check(channels.includes(b.channel), "Choose a channel");
  const steps = validateSteps(b.steps, b.channel),
    cid = id(),
    org = c.get("user").org_id;
  check(
    !steps.some((s) => s.action === "invite") || b.channel === "linkedin",
    "Only LinkedIn supports invitations",
  );
  if (b.account_id) {
    const a = await c.env.DB.prepare(
      "SELECT id FROM channel_accounts WHERE org_id=? AND channel=? AND (id=? OR external_id=?)",
    )
      .bind(c.get("user").org_id, b.channel, b.account_id, b.account_id)
      .first<Row>();
    check(a, "Connect the sending account to this workspace first");
    b.account_id = a!.id;
  }
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO campaigns(id,org_id,name,channel,provider,account_id,from_address,daily_limit) VALUES(?,?,?,?,?,?,?,?)",
    ).bind(
      cid,
      org,
      text(b.name, 200),
      b.channel,
      b.provider === "gmail" ? "gmail" : "resend",
      text(b.account_id, 200),
      text(b.from_address, 300),
      Math.max(1, Math.min(500, Number(b.daily_limit) || 30)),
    ),
    ...steps.map((s) =>
      c.env.DB.prepare(
        "INSERT INTO steps(id,campaign_id,position,delay_minutes,subject,body,action) VALUES(?,?,?,?,?,?,?)",
      ).bind(
        s.id,
        cid,
        s.position,
        s.delay_minutes,
        s.subject,
        s.body,
        s.action,
      ),
    ),
  ]);
  await event(c.env, org, "campaign.created", `Created ${b.name}`);
  return c.json({ id: cid }, 201);
});
api.get("/campaigns/:id", async (c) => {
  const campaign = await scoped(c, "campaigns", c.req.param("id"));
  const [steps, enrollments] = await c.env.DB.batch([
    c.env.DB.prepare(
      "SELECT * FROM steps WHERE campaign_id=? ORDER BY position",
    ).bind(campaign.id),
    c.env.DB.prepare(
      "SELECT e.*,p.name,p.email,p.dnc FROM enrollments e JOIN people p ON p.id=e.person_id AND p.org_id=e.org_id WHERE e.org_id=? AND e.campaign_id=? ORDER BY e.next_run LIMIT 1000",
    ).bind(campaign.org_id, campaign.id),
  ]);
  return c.json({
    ...campaign,
    steps: steps.results,
    enrollments: enrollments.results,
    accounts: (
      await c.env.DB.prepare(
        "SELECT account_id FROM campaign_accounts WHERE campaign_id=?",
      )
        .bind(campaign.id)
        .all<Row>()
    ).results.map((a) => a.account_id),
  });
});
api.patch("/campaigns/:id", async (c) => {
  const campaign = await scoped(c, "campaigns", c.req.param("id")),
    b = await c.req.json<Row>();
  check(
    ["active", "paused", "completed", "draft"].includes(b.status),
    "Choose a valid campaign state",
  );
  if (b.status === "active") {
    const kind = campaign.channel === "email" ? campaign.provider : "unipile";
    check(
      await integration(c.env, campaign.org_id, kind),
      `Connect ${kind} in Settings first`,
    );
    const count = await c.env.DB.prepare(
      "SELECT COUNT(*) n FROM enrollments WHERE org_id=? AND campaign_id=? AND status='active'",
    )
      .bind(campaign.org_id, campaign.id)
      .first<{ n: number }>();
    check(count?.n, "Enroll at least one lead first");
  }
  await c.env.DB.prepare(
    "UPDATE campaigns SET status=? WHERE id=? AND org_id=?",
  )
    .bind(b.status, campaign.id, campaign.org_id)
    .run();
  await event(
    c.env,
    campaign.org_id,
    `campaign.${b.status}`,
    `${campaign.name}: ${b.status}`,
  );
  return c.json({ ok: true });
});
api.post("/campaigns/:id/enroll", async (c) => {
  const campaign = await scoped(c, "campaigns", c.req.param("id")),
    b = await c.req.json<Row>();
  check(
    Array.isArray(b.people) && b.people.length > 0 && b.people.length <= 500,
    "Select between 1 and 500 leads",
  );
  let added = 0;
  for (const pid of [...new Set<string>(b.people)]) {
    const p = await scoped(c, "people", pid);
    if (p.dnc) continue;
    const step = await c.env.DB.prepare(
      "SELECT delay_minutes FROM steps WHERE campaign_id=? AND position=0",
    )
      .bind(campaign.id)
      .first<{ delay_minutes: number }>();
    const r = await c.env.DB.prepare(
      "INSERT OR IGNORE INTO enrollments(id,org_id,campaign_id,person_id,next_run) VALUES(?,?,?,?,?)",
    )
      .bind(
        id(),
        campaign.org_id,
        campaign.id,
        pid,
        new Date(Date.now() + (step?.delay_minutes || 0) * 60000).toISOString(),
      )
      .run();
    added += r.meta.changes;
  }
  return c.json({ added });
});
api.delete("/campaigns/:id", async (c) => {
  const campaign = await scoped(c, "campaigns", c.req.param("id"));
  check(campaign.status !== "active", "Pause the campaign before deleting it");
  await c.env.DB.prepare("DELETE FROM campaigns WHERE id=? AND org_id=?")
    .bind(campaign.id, campaign.org_id)
    .run();
  return c.json({ ok: true });
});
api.get("/inbox", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT m.*,p.name,p.email,p.company FROM messages m JOIN people p ON p.id=m.person_id AND p.org_id=m.org_id WHERE m.org_id=? ORDER BY m.created_at DESC LIMIT 300",
  )
    .bind(c.get("user").org_id)
    .all();
  const drafts = await c.env.DB.prepare(
    "SELECT d.*,p.name,p.company FROM drafts d JOIN people p ON p.id=d.person_id AND p.org_id=d.org_id WHERE d.org_id=? AND d.status IN ('pending','queued') ORDER BY d.created_at DESC",
  )
    .bind(c.get("user").org_id)
    .all();
  return c.json({ messages: rows.results, drafts: drafts.results });
});
api.post("/messages", async (c) => {
  const b = await c.req.json<Row>();
  const p = await scoped(c, "people", String(b.person_id));
  check(channels.includes(b.channel), "Choose a channel");
  check(text(b.body), "Enter a reply");
  const result = await receive(c.env, p.org_id, b.channel, {
    person_id: p.id,
    external_id: `manual:${id()}`,
    subject: b.subject,
    body: b.body,
  });
  return c.json({ id: result.id, job: result.job }, 201);
});
api.post("/ai/draft", async (c) => {
  await limit(c.env, `ai:${c.get("user").org_id}`, 40, 3600);
  const b = await c.req.json<Row>(),
    p = await scoped(c, "people", String(b.person_id));
  check(!p.dnc, "This lead is on Do Not Contact");
  if (b.message_id) {
    const m = await scoped(c, "messages", b.message_id);
    check(m.person_id === p.id, "Message belongs to another lead");
  }
  const job = await enqueue(c.env, p.org_id, "crm", {
    person_id: p.id,
    message_id: b.message_id || null,
    channel: channels.includes(b.channel) ? b.channel : "email",
    prompt: text(b.prompt, 2000),
  });
  return c.json({ job }, 202);
});
api.patch("/drafts/:id", async (c) => {
  const draft = await scoped(c, "drafts", c.req.param("id")),
    b = await c.req.json<Row>();
  check(draft.status === "pending", "Only pending drafts can be edited");
  check(text(b.body), "Draft cannot be empty");
  await c.env.DB.prepare(
    "UPDATE drafts SET subject=?,body=? WHERE id=? AND org_id=?",
  )
    .bind(text(b.subject, 300), text(b.body), draft.id, draft.org_id)
    .run();
  return c.json({ ok: true });
});
api.delete("/drafts/:id", async (c) => {
  const draft = await scoped(c, "drafts", c.req.param("id"));
  check(draft.status === "pending", "This draft is already queued");
  await c.env.DB.prepare("DELETE FROM drafts WHERE id=? AND org_id=?")
    .bind(draft.id, draft.org_id)
    .run();
  return c.json({ ok: true });
});
api.post("/drafts/:id/send", async (c) => {
  const draft = await scoped(c, "drafts", c.req.param("id"));
  check(draft.status === "pending", "This draft has already been queued");
  const p = await scoped(c, "people", draft.person_id);
  check(!p.dnc, "This lead is on Do Not Contact");
  const provider = draft.channel === "email" ? "resend" : "unipile";
  check(
    await integration(c.env, draft.org_id, provider),
    `Connect ${provider} in Settings first`,
  );
  const updated = await c.env.DB.prepare(
    "UPDATE drafts SET status='queued' WHERE id=? AND org_id=? AND status='pending' RETURNING id",
  )
    .bind(draft.id, draft.org_id)
    .first();
  if (!updated)
    throw new HTTPException(409, { message: "Draft already queued" });
  await c.env.DB.prepare(
    "UPDATE jobs SET status='pending',error='',available_at=?,updated_at=? WHERE id=? AND org_id=? AND status='failed'",
  )
    .bind(now(), now(), `draft:${draft.id}`, draft.org_id)
    .run();
  const job = await enqueue(
    c.env,
    draft.org_id,
    "send",
    { draft_id: draft.id, person_id: draft.person_id },
    `draft:${draft.id}`,
  );
  return c.json({ job }, 202);
});
api.get("/tables", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT t.*,(SELECT COUNT(*) FROM table_rows r WHERE r.table_id=t.id AND r.org_id=t.org_id) row_count FROM enrichment_tables t WHERE org_id=? ORDER BY created_at DESC",
  )
    .bind(c.get("user").org_id)
    .all();
  return c.json({ items: rows.results });
});
api.post("/tables", async (c) => {
  const b = await c.req.json<Row>();
  check(text(b.name, 200), "Table name is required");
  const tid = id(),
    columns = [
      { key: "name", name: "Name", type: "text" },
      { key: "company", name: "Company", type: "text" },
      { key: "email", name: "Email", type: "text" },
    ];
  await c.env.DB.prepare(
    "INSERT INTO enrichment_tables(id,org_id,name,columns) VALUES(?,?,?,?)",
  )
    .bind(tid, c.get("user").org_id, text(b.name, 200), JSON.stringify(columns))
    .run();
  return c.json({ id: tid }, 201);
});
api.get("/tables/:id", async (c) => {
  const table = await scoped(c, "enrichment_tables", c.req.param("id"));
  const rows = await c.env.DB.prepare(
    "SELECT * FROM table_rows WHERE org_id=? AND table_id=? ORDER BY created_at LIMIT 1000",
  )
    .bind(table.org_id, table.id)
    .all();
  return c.json({
    ...table,
    columns: json(table.columns, []),
    rows: rows.results.map((r) => ({
      ...r,
      cell_meta: json(r.cell_meta as string, {}),
      cells: json(r.cells as string, {}),
    })),
  });
});
api.patch("/tables/:id", async (c) => {
  const table = await scoped(c, "enrichment_tables", c.req.param("id")),
    b = await c.req.json<Row>();
  check(
    Array.isArray(b.columns) && b.columns.length <= 30,
    "Use at most 30 columns",
  );
  const keys = new Set();
  for (const col of b.columns as Column[]) {
    check(
      /^[a-zA-Z][a-zA-Z0-9_]{0,49}$/.test(col.key) && !keys.has(col.key),
      "Column keys must be unique identifiers",
    );
    keys.add(col.key);
    check(
      ["text", "ai", "http", "hunter", "apollo"].includes(col.type),
      "Unknown column type",
    );
    check(text(col.name, 100), "Column name is required");
  }
  await c.env.DB.prepare(
    "UPDATE enrichment_tables SET name=?,columns=? WHERE id=? AND org_id=?",
  )
    .bind(
      text(b.name, 200) || table.name,
      JSON.stringify(b.columns),
      table.id,
      table.org_id,
    )
    .run();
  return c.json({ ok: true });
});
api.post("/tables/:id/rows", async (c) => {
  const table = await scoped(c, "enrichment_tables", c.req.param("id")),
    b = await c.req.json<Row>();
  check(
    Array.isArray(b.rows) && b.rows.length > 0 && b.rows.length <= 500,
    "Add between 1 and 500 rows",
  );
  const inserted = b.rows.map((cells: Row) => ({ rid: id(), cells }));
  for (let i = 0; i < inserted.length; i += 50) {
    await c.env.DB.batch(
      inserted
        .slice(i, i + 50)
        .map((row: Row) =>
          c.env.DB.prepare(
            "INSERT INTO table_rows(id,org_id,table_id,cells) VALUES(?,?,?,?)",
          ).bind(row.rid, table.org_id, table.id, JSON.stringify(row.cells)),
        ),
    );
  }
  if (table.auto_run)
    for (const r of inserted)
      await enqueue(c.env, table.org_id, "table-row", {
        table_id: table.id,
        row_id: r.rid,
      });
  return c.json({ ok: true });
});
api.post("/tables/:id/run", async (c) => {
  await limit(c.env, `enrichment:${c.get("user").org_id}`, 10, 3600);
  const table = await scoped(c, "enrichment_tables", c.req.param("id"));
  check(
    json<Column[]>(table.columns, []).some((x) => x.type !== "text"),
    "Add an enrichment or AI column first",
  );
  const rows = await c.env.DB.prepare(
    "SELECT id FROM table_rows WHERE org_id=? AND table_id=? AND status IN ('ready','failed') LIMIT 100",
  )
    .bind(table.org_id, table.id)
    .all<{ id: string }>();
  for (const row of rows.results) {
    await c.env.DB.prepare(
      "UPDATE table_rows SET status='queued' WHERE id=? AND org_id=?",
    )
      .bind(row.id, table.org_id)
      .run();
    await enqueue(c.env, table.org_id, "enrich", {
      table_id: table.id,
      row_id: row.id,
    });
  }
  return c.json({ queued: rows.results.length });
});
api.post("/tables/:id/promote", async (c) => {
  const table = await scoped(c, "enrichment_tables", c.req.param("id"));
  const rows = await c.env.DB.prepare(
    "SELECT cells FROM table_rows WHERE org_id=? AND table_id=? LIMIT 1000",
  )
    .bind(table.org_id, table.id)
    .all<{ cells: string }>();
  let imported = 0;
  for (const row of rows.results) {
    const cells = json<Row>(row.cells, {});
    if (!cells.name) continue;
    const v = personValues(cells);
    const r = await c.env.DB.prepare(
      "INSERT OR IGNORE INTO people(id,org_id,name,email,company,title,phone,linkedin,website,stage,dnc,notes,tags,custom) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(id(), table.org_id, ...v)
      .run();
    imported += r.meta.changes;
  }
  return c.json({ imported });
});
api.delete("/tables/:id", async (c) => {
  const t = await scoped(c, "enrichment_tables", c.req.param("id"));
  await c.env.DB.prepare(
    "DELETE FROM enrichment_tables WHERE id=? AND org_id=?",
  )
    .bind(t.id, t.org_id)
    .run();
  return c.json({ ok: true });
});
api.get("/settings", async (c) => {
  const org = c.get("user").org_id;
  const [workspace, integrations, members, knowledge] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT * FROM organizations WHERE id=?").bind(org),
    c.env.DB.prepare(
      "SELECT kind,label,updated_at FROM integrations WHERE org_id=?",
    ).bind(org),
    c.env.DB.prepare(
      "SELECT u.id,u.name,u.email,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.org_id=?",
    ).bind(org),
    c.env.DB.prepare(
      "SELECT * FROM knowledge WHERE org_id=? ORDER BY created_at DESC",
    ).bind(org),
  ]);
  return c.json({
    workspace: workspace.results[0],
    integrations: integrations.results,
    members: members.results,
    knowledge: knowledge.results,
    ai: { provider: "Workers AI", model: c.env.AI_MODEL },
    webhooks: {
      email: `${c.env.APP_URL}/api/webhooks/${org}/email`,
      linkedin: `${c.env.APP_URL}/api/webhooks/${org}/linkedin`,
      whatsapp: `${c.env.APP_URL}/api/webhooks/${org}/whatsapp`,
    },
  });
});
api.patch("/settings", async (c) => {
  requireAdmin(c);
  const b = await c.req.json<Row>();
  check(text(b.name, 100), "Workspace name is required");
  try {
    new Intl.DateTimeFormat("en", { timeZone: b.timezone }).format();
  } catch {
    throw new HTTPException(400, {
      message: "Use a valid time zone, such as Asia/Shanghai",
    });
  }
  check(
    Number.isInteger(Number(b.start_hour)) &&
      Number(b.start_hour) >= 0 &&
      Number(b.start_hour) < 24 &&
      Number.isInteger(Number(b.end_hour)) &&
      Number(b.end_hour) > Number(b.start_hour) &&
      Number(b.end_hour) <= 24,
    "Sending hours must be within one day, with end after start",
  );
  await c.env.DB.prepare(
    "UPDATE organizations SET name=?,product=?,website=?,description=?,target_audience=?,timezone=?,start_hour=?,end_hour=?,daily_limit=? WHERE id=?",
  )
    .bind(
      text(b.name, 100),
      text(b.product, 200),
      text(b.website, 500),
      text(b.description, 10000),
      text(b.target_audience, 4000),
      text(b.timezone, 100),
      Number(b.start_hour),
      Number(b.end_hour),
      Math.max(1, Math.min(500, Number(b.daily_limit) || 30)),
      c.get("user").org_id,
    )
    .run();
  return c.json({ ok: true });
});
api.post("/integrations/:kind", async (c) => {
  requireAdmin(c);
  const b = await c.req.json<Row>(),
    kind = c.req.param("kind");
  await limit(c.env, `integration:${c.get("user").org_id}`, 20, 3600);
  try {
    await validateIntegration(kind, b);
  } catch (e) {
    throw new HTTPException(400, {
      message: e instanceof Error ? e.message : "Integration validation failed",
    });
  }
  await c.env.DB.prepare(
    "INSERT INTO integrations(org_id,kind,encrypted,label) VALUES(?,?,?,?) ON CONFLICT(org_id,kind) DO UPDATE SET encrypted=excluded.encrypted,label=excluded.label,updated_at=?",
  )
    .bind(
      c.get("user").org_id,
      kind,
      await encrypt(b, c.env.ENCRYPTION_KEY),
      text(b.label, 100) || kind,
      now(),
    )
    .run();
  return c.json({ ok: true });
});
api.delete("/integrations/:kind", async (c) => {
  requireAdmin(c);
  await c.env.DB.prepare("DELETE FROM integrations WHERE org_id=? AND kind=?")
    .bind(c.get("user").org_id, c.req.param("kind"))
    .run();
  return c.json({ ok: true });
});
api.post("/members/invite", async (c) => {
  requireAdmin(c);
  const b = await c.req.json<Row>();
  check(emailValid(text(b.email, 254)), "Use a valid email");
  const raw = token();
  await c.env.DB.prepare(
    "INSERT INTO invitations(id,org_id,email,role,token_hash,expires_at) VALUES(?,?,?,?,?,?)",
  )
    .bind(
      id(),
      c.get("user").org_id,
      text(b.email, 254).toLowerCase(),
      b.role === "admin" ? "admin" : "member",
      await digest(raw),
      new Date(Date.now() + 7 * 86400000).toISOString(),
    )
    .run();
  return c.json(
    {
      url: `${c.env.APP_URL}/#invite=${raw}`,
      message:
        "Share this private invitation link with your teammate. Expires in 7 days.",
    },
    201,
  );
});
api.delete("/members/:id", async (c) => {
  requireAdmin(c);
  check(c.req.param("id") !== c.get("user").id, "You cannot remove yourself");
  const row = await c.env.DB.prepare(
    "SELECT role FROM members WHERE org_id=? AND user_id=?",
  )
    .bind(c.get("user").org_id, c.req.param("id"))
    .first<{ role: string }>();
  check(row && row.role !== "owner", "The workspace owner cannot be removed");
  const result = await c.env.DB.batch([
    c.env.DB.prepare(
      "DELETE FROM members WHERE org_id=? AND user_id=? AND role<>'owner'",
    ).bind(c.get("user").org_id, c.req.param("id")),
    c.env.DB.prepare(
      "DELETE FROM team_members WHERE user_id=? AND team_id IN (SELECT id FROM teams WHERE org_id=?) AND NOT EXISTS(SELECT 1 FROM members WHERE org_id=? AND user_id=?)",
    ).bind(
      c.req.param("id"),
      c.get("user").org_id,
      c.get("user").org_id,
      c.req.param("id"),
    ),
    c.env.DB.prepare(
      "DELETE FROM sessions WHERE org_id=? AND user_id=? AND NOT EXISTS(SELECT 1 FROM members WHERE org_id=? AND user_id=?)",
    ).bind(
      c.get("user").org_id,
      c.req.param("id"),
      c.get("user").org_id,
      c.req.param("id"),
    ),
  ]);
  check(result[0].meta.changes, "The workspace owner cannot be removed");
  return c.json({ ok: true });
});
api.post("/knowledge", async (c) => {
  requireAdmin(c);
  const b = await c.req.json<Row>();
  check(
    text(b.title, 200) && text(b.content, 20000),
    "Title and content are required",
  );
  const kid = id();
  await c.env.DB.prepare(
    "INSERT INTO knowledge(id,org_id,title,content) VALUES(?,?,?,?)",
  )
    .bind(kid, c.get("user").org_id, text(b.title, 200), text(b.content, 20000))
    .run();
  return c.json({ id: kid }, 201);
});
api.delete("/knowledge/:id", async (c) => {
  requireAdmin(c);
  await scoped(c, "knowledge", c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM knowledge WHERE id=? AND org_id=?")
    .bind(c.req.param("id"), c.get("user").org_id)
    .run();
  return c.json({ ok: true });
});
api.get("/jobs", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id,kind,status,attempts,error,created_at,updated_at FROM jobs WHERE org_id=? ORDER BY created_at DESC LIMIT 200",
  )
    .bind(c.get("user").org_id)
    .all();
  return c.json({ items: rows.results });
});
api.post("/jobs/:id/retry", async (c) => {
  const job = await scoped(c, "jobs", c.req.param("id"));
  check(
    job.status === "failed",
    "Only failed tasks can be retried; inspect uncertain sends in your provider dashboard",
  );
  const payload = json<Row>(job.payload, {});
  if (payload.draft_id)
    await c.env.DB.prepare(
      "UPDATE drafts SET status='queued' WHERE id=? AND org_id=? AND status='pending'",
    )
      .bind(payload.draft_id, job.org_id)
      .run();
  await c.env.DB.prepare(
    "UPDATE jobs SET status='pending',error='',available_at=?,updated_at=? WHERE id=? AND org_id=?",
  )
    .bind(now(), now(), job.id, job.org_id)
    .run();
  return c.json({ ok: true });
});
api.post("/files", async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File))
    throw new HTTPException(400, { message: "Choose a file" });
  check(
    file.size > 0 && file.size <= 20 * 1024 * 1024,
    "Files must be between 1 byte and 20 MB",
  );
  const pid = typeof body.person_id === "string" ? body.person_id : null;
  if (pid) await scoped(c, "people", pid);
  const fid = id(),
    key = `${c.get("user").org_id}/${fid}`;
  await c.env.MEDIA.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });
  await c.env.DB.prepare(
    "INSERT INTO files(id,org_id,person_id,name,object_key,content_type,size) VALUES(?,?,?,?,?,?,?)",
  )
    .bind(
      fid,
      c.get("user").org_id,
      pid,
      text(file.name, 255),
      key,
      file.type || "application/octet-stream",
      file.size,
    )
    .run();
  return c.json({ id: fid }, 201);
});
api.get("/files/:id", async (c) => {
  const file = await scoped(c, "files", c.req.param("id")),
    object = await c.env.MEDIA.get(file.object_key);
  if (!object) throw new HTTPException(404, { message: "File not found" });
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "Cache-Control": "private,no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
api.post("/files/:id/transcribe", async (c) => {
  await limit(c.env, `transcribe:${c.get("user").org_id}`, 15, 3600);
  const file = await scoped(c, "files", c.req.param("id"));
  check(file.content_type.startsWith("audio/"), "Choose an audio recording");
  check(
    file.size <= 10 * 1024 * 1024,
    "Transcription supports recordings up to 10 MB",
  );
  const job = await enqueue(c.env, file.org_id, "transcribe", {
    file_id: file.id,
  });
  return c.json({ job }, 202);
});
api.delete("/files/:id", async (c) => {
  const file = await scoped(c, "files", c.req.param("id"));
  await c.env.MEDIA.delete(file.object_key);
  await c.env.DB.prepare("DELETE FROM files WHERE id=? AND org_id=?")
    .bind(file.id, file.org_id)
    .run();
  return c.json({ ok: true });
});

app.post("/api/webhooks/:org/:channel", async (c) => {
  const org = c.req.param("org"),
    channel = c.req.param("channel");
  check(channels.includes(channel), "Invalid channel");
  const config = await integration(c.env, org, "webhook");
  if (
    !config?.secret ||
    !constantEqual(c.req.header("X-Webhook-Secret") || "", config.secret)
  )
    throw new HTTPException(401, { message: "Invalid webhook authentication" });
  await limit(c.env, `webhook:${org}`, 200, 60);
  return c.json(await receive(c.env, org, channel, await c.req.json<Row>()));
});
async function unsubscribe(c: any) {
  const org = c.req.param("org"),
    person = c.req.param("person"),
    signature = c.req.query("s") || "";
  if (
    !constantEqual(
      signature,
      await sign(`${org}:${person}`, c.env.UNSUBSCRIBE_SECRET),
    )
  )
    throw new HTTPException(400, { message: "Invalid unsubscribe link" });
  const p = await c.env.DB.prepare(
    "SELECT email FROM people WHERE id=? AND org_id=?",
  )
    .bind(person, org)
    .first();
  if (p) {
    const statements = [
      c.env.DB.prepare("UPDATE people SET dnc=1 WHERE id=? AND org_id=?").bind(
        person,
        org,
      ),
      c.env.DB.prepare(
        "UPDATE enrollments SET status='stopped' WHERE org_id=? AND person_id=? AND status='active'",
      ).bind(org, person),
      c.env.DB.prepare(
        "UPDATE crm_enrollments SET status='stopped' WHERE org_id=? AND person_id=? AND status IN ('active','paused')",
      ).bind(org, person),
      c.env.DB.prepare(
        "UPDATE drafts SET status='discarded' WHERE org_id=? AND person_id=? AND status IN ('pending','queued')",
      ).bind(org, person),
    ];
    if (p.email)
      statements.push(
        c.env.DB.prepare(
          "INSERT OR IGNORE INTO suppressions(org_id,email,reason) VALUES(?,?,?)",
        ).bind(org, p.email, "unsubscribe"),
      );
    await c.env.DB.batch(statements);
  }
  return c.html(
    '<!doctype html><html><meta name="viewport" content="width=device-width"><title>Unsubscribed</title><body style="font-family:system-ui;padding:12vh 8vw;color:#163e32"><h1>You are unsubscribed.</h1><p>You will no longer receive outreach from this workspace.</p></body></html>',
  );
}
// GET renders a confirmation. Link scanners cannot unsubscribe a recipient.
app.get("/u/:org/:person", async (c) => {
  const signature = c.req.query("s") || "";
  if (
    !constantEqual(
      signature,
      await sign(
        `${c.req.param("org")}:${c.req.param("person")}`,
        c.env.UNSUBSCRIBE_SECRET,
      ),
    )
  )
    throw new HTTPException(400, { message: "Invalid unsubscribe link" });
  return c.html(
    `<!doctype html><html><meta name="viewport" content="width=device-width"><title>Unsubscribe</title><body style="font-family:system-ui;padding:12vh 8vw;color:#163e32"><h1>Stop receiving outreach?</h1><form method="post"><button style="padding:14px 24px;background:#163e32;color:white;border:0;border-radius:8px">Unsubscribe</button></form></body></html>`,
  );
});
app.post("/u/:org/:person", unsubscribe);
app.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /\n"));
app.get("/downloads/call-recorder", requireUser, (c) =>
  c.env.ASSETS.fetch(
    new Request(new URL("/recorder.zip", c.req.url), c.req.raw),
  ),
);
app.get("/recorder.zip", requireUser, (c) => c.env.ASSETS.fetch(c.req.raw));
app.route("/api", featureRoutes);
app.route("/api", api);
app.all("/api/*", (c) => c.json({ error: "Endpoint not found" }, 404));
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));
