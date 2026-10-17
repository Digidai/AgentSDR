import { Hono } from "hono";
import type { AppEnv, Row } from "../types";
import {
  id,
  json,
  now,
  text,
  encrypt,
  decrypt,
  publicUrl,
  token,
  digest,
} from "../core";
import { requireAdmin, limit } from "../auth";
import { requestJson } from "../providers";
import { enqueue } from "../jobs";
import { receive } from "../inbound";
import {
  ensure,
  record,
  orgId,
  pref,
  savePref,
  batches,
  convertField,
} from "./shared";
import { authMail } from "./identity";
import { renderAiInstructions } from "../ported/crm-instructions";
import { normalizePhone } from "./phone";
export const completeness = new Hono<AppEnv>();
completeness.get("/apps", (c) =>
  c.json({
    items: [
      { key: "leads", name: "Leads" },
      { key: "tables", name: "Enrichment" },
      { key: "campaigns", name: "Outreach" },
      { key: "inbox", name: "Inbox" },
      { key: "crm", name: "CRM" },
      { key: "calling", name: "Calling" },
      { key: "prospecting", name: "Company qualification" },
    ],
  }),
);
completeness.get("/nav/badges", async (c) => {
  const queries = [
    [
      "inbox",
      "SELECT COUNT(*) n FROM messages WHERE org_id=? AND direction='inbound' AND read_at IS NULL",
    ],
    [
      "drafts",
      "SELECT COUNT(*) n FROM drafts WHERE org_id=? AND status='pending'",
    ],
    [
      "tasks",
      "SELECT COUNT(*) n FROM lead_tasks WHERE org_id=? AND status='open'",
    ],
    [
      "exceptions",
      "SELECT COUNT(*) n FROM identity_exceptions WHERE org_id=? AND status='open'",
    ],
  ];
  const items: Row = {};
  for (const [key, sql] of queries)
    items[key] =
      (await c.env.DB.prepare(sql).bind(orgId(c)).first<Row>())?.n || 0;
  return c.json(items);
});
completeness.get("/crm/identity-exceptions", async (c) =>
  c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT id,channel,external_id,status,created_at FROM identity_exceptions WHERE org_id=? AND status=? ORDER BY created_at DESC LIMIT 300",
      )
        .bind(orgId(c), c.req.query("status") || "open")
        .all()
    ).results,
  }),
);
completeness.get("/crm/identity-exceptions/:id", async (c) => {
  const r = await record(
    c.env,
    orgId(c),
    "identity_exceptions",
    c.req.param("id"),
  );
  return c.json({ ...r, payload: json(r.payload, {}) });
});
completeness.patch("/crm/identity-exceptions/:id", async (c) => {
  const r = await record(
      c.env,
      orgId(c),
      "identity_exceptions",
      c.req.param("id"),
    ),
    b = await c.req.json<Row>();
  ensure(
    ["resolved", "ignored"].includes(b.status),
    "Choose resolved or ignored",
  );
  if (b.status === "resolved") {
    await record(c.env, orgId(c), "people", b.person_id);
    await receive(c.env, orgId(c), r.channel, {
      ...json<Row>(r.payload, {}),
      person_id: b.person_id,
    });
  }
  await c.env.DB.prepare(
    "UPDATE identity_exceptions SET status=?,person_id=? WHERE id=? AND org_id=?",
  )
    .bind(b.status, b.person_id || null, r.id, orgId(c))
    .run();
  return c.json({ ok: true });
});
completeness.get("/lead-fields/:id/type-preview", async (c) => {
  const f = await record(c.env, orgId(c), "lead_fields", c.req.param("id")),
    type = c.req.query("type");
  ensure(
    [
      "text",
      "number",
      "currency",
      "boolean",
      "date",
      "select",
      "url",
      "email",
      "image",
      "multiselect",
      "json",
    ].includes(type || ""),
    "Unsupported type",
  );
  const rows = await c.env.DB.prepare(
    `SELECT custom FROM ${f.entity === "company" ? "companies" : "people"} WHERE org_id=? LIMIT 20000`,
  )
    .bind(orgId(c))
    .all<Row>();
  let populated = 0,
    incompatible = 0;
  for (const r of rows.results) {
    const v = json<Row>(r.custom, {})[f.key];
    if (v === undefined || v === null || v === "") continue;
    populated++;
    if (!convertField(v, type!).compatible) incompatible++;
  }
  return c.json({ populated, incompatible, type });
});
completeness.get("/ai/connections", async (c) =>
  c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT id,name,provider,verified_at FROM provider_connections WHERE org_id=? AND provider='openrouter'",
      )
        .bind(orgId(c))
        .all()
    ).results,
  }),
);
completeness.post("/ai/connections", async (c) => {
  requireAdmin(c);
  const b = await c.req.json<Row>();
  ensure(text(b.api_key, 4096), "API key required");
  await requestJson("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${b.api_key}` },
  });
  const aid = id();
  await c.env.DB.prepare(
    "INSERT INTO provider_connections(id,org_id,provider,name,encrypted,verified_at) VALUES(?,?,'openrouter',?,?,?)",
  )
    .bind(
      aid,
      orgId(c),
      text(b.name, 100) || "OpenRouter",
      await encrypt(
        { api_key: b.api_key, management_key: text(b.management_key, 4096) },
        c.env.ENCRYPTION_KEY,
      ),
      now(),
    )
    .run();
  return c.json({ id: aid }, 201);
});
completeness.delete("/ai/connections/:id", async (c) => {
  requireAdmin(c);
  const r = await record(
    c.env,
    orgId(c),
    "provider_connections",
    c.req.param("id"),
  );
  ensure(r.provider === "openrouter", "Not an AI connection");
  await c.env.DB.prepare(
    "DELETE FROM provider_connections WHERE id=? AND org_id=?",
  )
    .bind(r.id, orgId(c))
    .run();
  return c.json({ ok: true });
});
completeness.get("/http-secrets", async (c) =>
  c.json({
    keys: Object.keys(await pref(c.env, orgId(c), "http-secrets", {})),
  }),
);
completeness.put("/http-secrets/:key", async (c) => {
  requireAdmin(c);
  const key = c.req.param("key"),
    b = await c.req.json<Row>();
  ensure(
    /^GRID_HTTP_SECRET_[A-Z0-9_]{1,80}$/.test(key),
    "Use GRID_HTTP_SECRET_NAME",
  );
  ensure(text(b.value, 4096), "Secret required");
  const v = await pref<Row>(c.env, orgId(c), "http-secrets", {});
  v[key] = await encrypt(text(b.value, 4096), c.env.ENCRYPTION_KEY);
  await savePref(c.env, orgId(c), "http-secrets", v);
  return c.json({ ok: true });
});
completeness.delete("/http-secrets/:key", async (c) => {
  requireAdmin(c);
  const v = await pref<Row>(c.env, orgId(c), "http-secrets", {});
  delete v[c.req.param("key")];
  await savePref(c.env, orgId(c), "http-secrets", v);
  return c.json({ ok: true });
});
completeness.post("/workbooks/:id/reorder", async (c) => {
  const w = await record(c.env, orgId(c), "workbooks", c.req.param("id")),
    b = await c.req.json<Row>();
  ensure(
    Array.isArray(b.ids) &&
      b.ids.length <= 500 &&
      new Set(b.ids).size === b.ids.length,
    "Choose unique table IDs",
  );
  for (const tid of b.ids) {
    const t = await record(c.env, orgId(c), "enrichment_tables", tid);
    ensure(t.workbook_id === w.id, "Table belongs to another workbook");
  }
  await batches(
    c.env,
    b.ids.map((tid: string, i: number) =>
      c.env.DB.prepare(
        "UPDATE enrichment_tables SET position=? WHERE id=? AND org_id=?",
      ).bind(i, tid, orgId(c)),
    ),
  );
  return c.json({ ok: true });
});
completeness.get("/calling/contacts/:id", async (c) => {
  const r = await record(c.env, orgId(c), "call_contacts", c.req.param("id")),
    p = await record(c.env, orgId(c), "people", r.person_id);
  return c.json({
    ...r,
    person: p,
    calls: (
      await c.env.DB.prepare(
        "SELECT * FROM calls WHERE org_id=? AND contact_id=? ORDER BY created_at DESC",
      )
        .bind(orgId(c), r.id)
        .all()
    ).results,
    messages: (
      await c.env.DB.prepare(
        "SELECT * FROM messages WHERE org_id=? AND person_id=? ORDER BY created_at DESC LIMIT 100",
      )
        .bind(orgId(c), p.id)
        .all()
    ).results,
  });
});
completeness.patch("/calling/contacts/:id/person", async (c) => {
  const r = await record(c.env, orgId(c), "call_contacts", c.req.param("id")),
    p = await record(c.env, orgId(c), "people", r.person_id),
    b = await c.req.json<Row>();
  await c.env.DB.prepare(
    "UPDATE people SET name=?,title=?,company=?,phone=?,custom=? WHERE id=? AND org_id=?",
  )
    .bind(
      text(b.name, 200) || p.name,
      b.title === undefined ? p.title : text(b.title, 300),
      b.company === undefined ? p.company : text(b.company, 300),
      b.phone === undefined ? p.phone : text(b.phone, 50),
      JSON.stringify({ ...json<Row>(p.custom, {}), ...b.custom }),
      p.id,
      orgId(c),
    )
    .run();
  return c.json({ ok: true });
});
completeness.post("/calling/campaigns/:id/import", async (c) => {
  const camp = await record(
      c.env,
      orgId(c),
      "call_campaigns",
      c.req.param("id"),
    ),
    b = await c.req.json<Row>();
  ensure(
    Array.isArray(b.rows) && b.rows.length <= 1000,
    "Import up to 1000 contacts",
  );
  let added = 0;
  for (const row of b.rows) {
    const phone = await normalizePhone(c.env, orgId(c), row.phone);
    ensure(/^\+[1-9]\d{6,14}$/.test(phone), "International phone required");
    let p = await c.env.DB.prepare(
      "SELECT id FROM people WHERE org_id=? AND phone=?",
    )
      .bind(orgId(c), phone)
      .first<Row>();
    if (!p) {
      p = { id: id() };
      await c.env.DB.prepare(
        "INSERT INTO people(id,org_id,name,email,phone,company,title) VALUES(?,?,?,?,?,?,?)",
      )
        .bind(
          p.id,
          orgId(c),
          text(row.name, 200) || phone,
          text(row.email, 254).toLowerCase() || null,
          phone,
          text(row.company, 300),
          text(row.title, 300),
        )
        .run();
    }
    const r = await c.env.DB.prepare(
      "INSERT OR IGNORE INTO call_contacts(id,org_id,campaign_id,person_id) VALUES(?,?,?,?)",
    )
      .bind(id(), orgId(c), camp.id, p.id)
      .run();
    added += r.meta.changes;
  }
  return c.json({ added });
});
completeness.post("/calling/contacts/:id/photo", async (c) => {
  const r = await record(c.env, orgId(c), "call_contacts", c.req.param("id")),
    b = await c.req.parseBody(),
    file = b.file;
  ensure(
    file instanceof File &&
      /^image\/(png|jpeg|webp)$/.test(file.type) &&
      file.size <= 5 * 1024 * 1024,
    "Upload PNG, JPEG or WebP up to 5 MB",
  );
  const p = await record(c.env, orgId(c), "people", r.person_id),
    custom = json<Row>(p.custom, {}),
    key = `${orgId(c)}/photos/${id()}`;
  await c.env.MEDIA.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
  });
  if (custom.photo_key) await c.env.MEDIA.delete(custom.photo_key);
  custom.photo_key = key;
  await c.env.DB.prepare("UPDATE people SET custom=? WHERE id=? AND org_id=?")
    .bind(JSON.stringify(custom), p.id, orgId(c))
    .run();
  return c.json({ url: `/api/people/${p.id}/photo` });
});
completeness.get("/people/:id/photo", async (c) => {
  const p = await record(c.env, orgId(c), "people", c.req.param("id")),
    key = json<Row>(p.custom, {}).photo_key;
  ensure(key, "No photo", 404);
  const r = await c.env.MEDIA.get(key);
  ensure(r, "No photo", 404);
  return new Response(r.body, {
    headers: {
      "Content-Type": r.httpMetadata?.contentType || "image/jpeg",
      "Cache-Control": "private, max-age=300",
    },
  });
});
completeness.patch("/prospecting/:id/prospects/:prospect", async (c) => {
  const p = await record(c.env, orgId(c), "prospects", c.req.param("prospect"));
  ensure(p.campaign_id === c.req.param("id"), "Wrong campaign");
  const b = await c.req.json<Row>(),
    result = json<Row>(p.result, {});
  if (b.parentCompany !== undefined)
    result.parentCompany = text(b.parentCompany, 300);
  if (b.qualified !== undefined) result.qualified = !!b.qualified;
  result.reviewedAt = now();
  await c.env.DB.prepare(
    "UPDATE prospects SET result=? WHERE id=? AND org_id=?",
  )
    .bind(JSON.stringify(result), p.id, orgId(c))
    .run();
  return c.json({ ok: true });
});
completeness.get("/prospecting/:id/export", async (c) => {
  await record(c.env, orgId(c), "prospecting_campaigns", c.req.param("id"));
  const rows = await c.env.DB.prepare(
    "SELECT * FROM prospects WHERE org_id=? AND campaign_id=?",
  )
    .bind(orgId(c), c.req.param("id"))
    .all<Row>();
  return c.json({
    items: rows.results.map((r) => ({
      domain: r.domain,
      status: r.status,
      ...json<Row>(r.result, {}),
    })),
  });
});
completeness.post("/auth/send-verification", async (c) => {
  await limit(c.env, `verify:${c.get("user").id}`, 3, 3600);
  const raw = token(),
    u = c.get("user");
  await c.env.DB.prepare(
    "INSERT INTO auth_tokens(id,user_id,email,kind,token_hash,expires_at) VALUES(?,?,?,'verify',?,?)",
  )
    .bind(
      id(),
      u.id,
      u.email,
      await digest(raw),
      new Date(Date.now() + 86400000).toISOString(),
    )
    .run();
  await authMail(
    c.env,
    orgId(c),
    u.email,
    "Verify your email",
    `${c.env.APP_URL}/api/auth/verify-email?token=${raw}`,
  );
  return c.json({ ok: true });
});

// An organization may load its own domain catalog; upstream ships no dataset.
completeness.post("/domains/import", async (c) => {
  requireAdmin(c);
  const b = await c.req.json<Row>();
  ensure(
    Array.isArray(b.rows) && b.rows.length <= 1000,
    "Import up to 1000 domains per request",
  );
  await batches(
    c.env,
    b.rows.map((r: Row) => {
      const u = publicUrl(
        "https://" +
          String(r.domain || "")
            .replace(/^https?:\/\//, "")
            .split("/")[0],
      );
      return c.env.DB.prepare(
        "INSERT INTO domain_catalog(org_id,domain,country,c1,c2,c3,platform,revenue,apps,metadata) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(org_id,domain) DO UPDATE SET country=excluded.country,c1=excluded.c1,c2=excluded.c2,c3=excluded.c3,platform=excluded.platform,revenue=excluded.revenue,apps=excluded.apps,metadata=excluded.metadata",
      ).bind(
        orgId(c),
        u.hostname.replace(/^www\./, ""),
        text(r.country || r.countryCode, 2).toUpperCase(),
        text(r.c1, 200),
        text(r.c2, 200),
        text(r.c3, 200),
        text(r.platform, 100),
        Number(r.revenue) || 0,
        JSON.stringify(
          Array.isArray(r.apps)
            ? r.apps
            : String(r.apps || "")
                .split(",")
                .filter(Boolean),
        ),
        JSON.stringify(r),
      );
    }),
  );
  return c.json({ imported: b.rows.length });
});
completeness.get("/domains", async (c) => {
  const values: any[] = [orgId(c)],
    where = ["org_id=?"];
  for (const [field, param] of [
    ["country", "countryCode"],
    ["c1", "c1"],
    ["c2", "c2"],
    ["c3", "c3"],
    ["platform", "platform"],
  ]) {
    const v = c.req.query(param);
    if (v) {
      where.push(field + "=?");
      values.push(v);
    }
  }
  for (const [param, op] of [
    ["minRevenue", ">="],
    ["maxRevenue", "<="],
  ]) {
    const v = c.req.query(param);
    if (v) {
      ensure(Number.isFinite(Number(v)), "Invalid revenue filter");
      where.push("revenue" + op + "?");
      values.push(Number(v));
    }
  }
  if (c.req.query("app")) {
    where.push("EXISTS (SELECT 1 FROM json_each(apps) WHERE value=?)");
    values.push(c.req.query("app"));
  }
  const limit = Math.max(
      1,
      Math.min(1000, Number(c.req.query("limit")) || 100),
    ),
    offset = Math.max(0, Number(c.req.query("offset")) || 0),
    clause = where.join(" AND ");
  const count = await c.env.DB.prepare(
    "SELECT COUNT(*) total FROM domain_catalog WHERE " + clause,
  )
    .bind(...values)
    .first();
  return c.json({
    ...count,
    items: (
      await c.env.DB.prepare(
        "SELECT * FROM domain_catalog WHERE " +
          clause +
          " ORDER BY revenue DESC,domain LIMIT ? OFFSET ?",
      )
        .bind(...values, limit, offset)
        .all()
    ).results,
  });
});
completeness.get("/domains/categories", async (c) => {
  const level = c.req.query("level") || "c1";
  ensure(["c1", "c2", "c3"].includes(level), "Invalid category level");
  return c.json({
    items: (
      await c.env.DB.prepare(
        `SELECT ${level} name,COUNT(*) count FROM domain_catalog WHERE org_id=? AND (?='' OR country=?) GROUP BY ${level} ORDER BY ${level}`,
      )
        .bind(
          orgId(c),
          c.req.query("countryCode") || "",
          c.req.query("countryCode") || "",
        )
        .all()
    ).results,
  });
});
completeness.get("/parent-pending", async (c) =>
  c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT p.*,c.name campaign FROM prospects p JOIN prospecting_campaigns c ON c.id=p.campaign_id AND c.org_id=p.org_id WHERE p.org_id=? AND json_extract(p.result,'$.parentPending')=1",
      )
        .bind(orgId(c))
        .all()
    ).results,
  }),
);
completeness.put("/targeted-domains/:domain/parent", async (c) => {
  const b = await c.req.json<Row>(),
    parent = publicUrl(
      "https://" + String(b.parent_domain || ""),
    ).hostname.replace(/^www\./, ""),
    rows = await c.env.DB.prepare(
      "SELECT * FROM prospects WHERE org_id=? AND domain=?",
    )
      .bind(orgId(c), c.req.param("domain"))
      .all<Row>();
  ensure(rows.results.length, "No targeted domain", 404);
  for (const r of rows.results) {
    const result = {
      ...json<Row>(r.result, {}),
      parentDomain: parent,
      parentPending: false,
      parentReviewedAt: now(),
    };
    await c.env.DB.prepare(
      "UPDATE prospects SET result=? WHERE id=? AND org_id=?",
    )
      .bind(JSON.stringify(result), r.id, orgId(c))
      .run();
    if (parent !== r.domain) {
      const pid = id();
      await c.env.DB.prepare(
        "INSERT OR IGNORE INTO prospects(id,org_id,campaign_id,domain,result) VALUES(?,?,?,?,?)",
      )
        .bind(
          pid,
          orgId(c),
          r.campaign_id,
          parent,
          JSON.stringify({ isParentCompany: true, childDomain: r.domain }),
        )
        .run();
      const p = await c.env.DB.prepare(
        "SELECT id FROM prospects WHERE org_id=? AND campaign_id=? AND domain=?",
      )
        .bind(orgId(c), r.campaign_id, parent)
        .first<Row>();
      await enqueue(c.env, orgId(c), "prospect", { prospect_id: p!.id });
    }
  }
  return c.json({ ok: true });
});
completeness.post("/tables/:id/campaigns", async (c) => {
  const t = await record(
      c.env,
      orgId(c),
      "enrichment_tables",
      c.req.param("id"),
    ),
    b = await c.req.json<Row>();
  ensure(
    ["email", "linkedin", "whatsapp"].includes(b.channel) && text(b.name, 200),
    "Name and channel required",
  );
  ensure(
    Array.isArray(b.row_ids) &&
      b.row_ids.length > 0 &&
      b.row_ids.length <= 1000,
    "Choose 1 to 1000 rows",
  );
  const rows: Row[] = [];
  for (const rid of new Set<string>(b.row_ids)) {
    const r = await record(c.env, orgId(c), "table_rows", rid);
    ensure(r.table_id === t.id, "Row belongs to another table");
    rows.push(r);
  }
  const cid = id();
  await c.env.DB.prepare(
    "INSERT INTO campaigns(id,org_id,name,channel,provider) VALUES(?,?,?,?,?)",
  )
    .bind(
      cid,
      orgId(c),
      text(b.name, 200),
      b.channel,
      b.provider === "gmail"
        ? "gmail"
        : b.channel === "email"
          ? "resend"
          : "unipile",
    )
    .run();
  const steps =
    Array.isArray(b.steps) && b.steps.length
      ? b.steps
      : [{ body: "Hi {{first_name}},", subject: "Hello", action: "message" }];
  ensure(steps.length <= 20, "Use at most 20 steps");
  await batches(
    c.env,
    steps.map((s: Row, i: number) =>
      c.env.DB.prepare(
        "INSERT INTO steps(id,campaign_id,position,delay_minutes,subject,body,action) VALUES(?,?,?,?,?,?,?)",
      ).bind(
        id(),
        cid,
        i,
        Math.max(0, Number(s.delay_minutes) || 0),
        text(s.subject, 300),
        text(s.body, 10000),
        s.action === "invite" && b.channel === "linkedin"
          ? "invite"
          : "message",
      ),
    ),
  );
  let enrolled = 0;
  for (const row of rows) {
    const cells = json<Row>(row.cells, {}),
      mapping = b.mapping || {},
      get = (key: string) => text(cells[mapping[key] || key], 500),
      email = get("email").toLowerCase(),
      linkedin = get("linkedin"),
      phone = get("phone"),
      name = get("name") || email || linkedin || phone;
    ensure(name, "Map a name or identity column");
    let person = await c.env.DB.prepare(
      "SELECT * FROM people WHERE org_id=? AND ((? IS NOT NULL AND email=?) OR (?<>'' AND linkedin=?) OR (?<>'' AND phone=?)) LIMIT 1",
    )
      .bind(orgId(c), email || null, email, linkedin, linkedin, phone, phone)
      .first<Row>();
    if (!person) {
      person = { id: id(), dnc: 0 };
      await c.env.DB.prepare(
        "INSERT INTO people(id,org_id,name,email,linkedin,phone,company,title,custom) VALUES(?,?,?,?,?,?,?,?,?)",
      )
        .bind(
          person.id,
          orgId(c),
          name,
          email || null,
          linkedin,
          phone,
          get("company"),
          get("title"),
          JSON.stringify(cells),
        )
        .run();
    }
    if (person.dnc) continue;
    await c.env.DB.prepare(
      "INSERT OR IGNORE INTO enrollments(id,org_id,campaign_id,person_id,next_run) VALUES(?,?,?,?,?)",
    )
      .bind(id(), orgId(c), cid, person.id, now())
      .run();
    enrolled++;
  }
  return c.json({ id: cid, enrolled }, 201);
});
completeness.get("/domains/apps", async (c) =>
  c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT j.value name,COUNT(*) count FROM domain_catalog d,json_each(d.apps) j WHERE d.org_id=? GROUP BY j.value ORDER BY count DESC",
      )
        .bind(orgId(c))
        .all()
    ).results,
  }),
);
completeness.get("/prospecting/:id/apollo-link", async (c) => {
  const campaign = await record(
      c.env,
      orgId(c),
      "prospecting_campaigns",
      c.req.param("id"),
    ),
    domains = await c.env.DB.prepare(
      "SELECT DISTINCT domain FROM prospects WHERE org_id=? AND campaign_id=? AND json_extract(result,'$.qualified')=1",
    )
      .bind(orgId(c), campaign.id)
      .all<Row>(),
    settings = json<Row>(campaign.settings, {}),
    params = new URLSearchParams({ page: "1" });
  for (const d of domains.results)
    params.append("qOrganizationDomains[]", d.domain);
  for (const title of settings.jobTitles || [])
    params.append("personTitles[]", title);
  return c.json({
    url: "https://app.apollo.io/#/people?" + params,
    domains: domains.results.length,
  });
});

completeness.get("/crm/settings/ai-instructions", async (c) =>
  c.json(
    await pref(c.env, orgId(c), "crm-instructions", {
      draftInstructions: [],
      classificationInstructions: [],
    }),
  ),
);
completeness.put("/crm/settings/ai-instructions", async (c) => {
  requireAdmin(c);
  const b = await c.req.json<Row>(),
    old = await pref<Row>(c.env, orgId(c), "crm-instructions", {});
  for (const key of ["draftInstructions", "classificationInstructions"])
    if (b[key] !== undefined) {
      ensure(
        Array.isArray(b[key]) && b[key].length <= 50,
        "Use up to 50 blocks",
      );
      for (const block of b[key])
        ensure(
          typeof block.title === "string" &&
            block.title.length <= 200 &&
            typeof block.content === "string" &&
            block.content.length <= 8000,
          "Invalid instruction block",
        );
      ensure(
        (renderAiInstructions(b[key])?.length || 0) <= 20000,
        "Instructions exceed 20000 characters",
      );
      old[key] = b[key];
    }
  await savePref(c.env, orgId(c), "crm-instructions", old);
  return c.json({ ok: true });
});
completeness.get("/tables/:id/selection", async (c) => {
  await record(c.env, orgId(c), "enrichment_tables", c.req.param("id"));
  return c.json(
    await pref(
      c.env,
      orgId(c),
      `selection:${c.get("user").id}:${c.req.param("id")}`,
      { ids: [] },
    ),
  );
});
completeness.put("/tables/:id/selection", async (c) => {
  await record(c.env, orgId(c), "enrichment_tables", c.req.param("id"));
  const b = await c.req.json<Row>();
  ensure(
    Array.isArray(b.ids) && b.ids.length <= 1000,
    "Select at most 1000 rows",
  );
  for (const rid of b.ids) {
    const r = await record(c.env, orgId(c), "table_rows", rid);
    ensure(r.table_id === c.req.param("id"), "Wrong table");
  }
  await savePref(
    c.env,
    orgId(c),
    `selection:${c.get("user").id}:${c.req.param("id")}`,
    { ids: b.ids },
  );
  return c.json({ ok: true });
});
completeness.post("/accounts/:id/reset-limits", async (c) => {
  requireAdmin(c);
  const a = await record(
    c.env,
    orgId(c),
    "channel_accounts",
    c.req.param("id"),
  );
  await c.env.DB.batch([
    c.env.DB.prepare(
      "DELETE FROM daily_usage WHERE org_id=? AND (channel LIKE ? OR channel LIKE ? OR channel=?)",
    ).bind(orgId(c), `account:${a.id}:%`, `lookup:${a.id}:%`, `search:${a.id}`),
    c.env.DB.prepare(
      "UPDATE channel_accounts SET status=CASE WHEN status='limit_reached' THEN 'connected' ELSE status END,next_send_at=NULL,error='' WHERE org_id=? AND id=?",
    ).bind(orgId(c), a.id),
  ]);
  return c.json({ ok: true });
});
completeness.post("/search/batches/:id/queries", async (c) => {
  const batch = await record(
      c.env,
      orgId(c),
      "search_batches",
      c.req.param("id"),
    ),
    b = await c.req.json<Row>();
  ensure(
    Array.isArray(b.queries) && b.queries.length <= 200,
    "Add up to 200 queries",
  );
  await batches(
    c.env,
    b.queries.map((q: unknown) =>
      c.env.DB.prepare(
        "INSERT INTO search_queries(id,org_id,batch_id,query) VALUES(?,?,?,?)",
      ).bind(
        id(),
        orgId(c),
        batch.id,
        typeof q === "string" ? q : JSON.stringify(q),
      ),
    ),
  );
  return c.json({ added: b.queries.length });
});
completeness.post("/search/queries/:id/rerun", async (c) => {
  const q = await record(c.env, orgId(c), "search_queries", c.req.param("id"));
  await c.env.DB.prepare(
    "UPDATE search_queries SET status='pending',cursor=NULL,results='[]',error='' WHERE org_id=? AND id=?",
  )
    .bind(orgId(c), q.id)
    .run();
  return c.json({
    job: await enqueue(c.env, orgId(c), "linkedin-search", { query_id: q.id }),
  });
});
