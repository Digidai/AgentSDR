import { Hono } from "hono";
import type { AppEnv, Env, Row } from "../types";
import {
  emailValid,
  encrypt,
  extractJson,
  id,
  json,
  now,
  render,
  text,
} from "../core";
import { limit, requireAdmin } from "../auth";
import { enqueue } from "../jobs";
import { generate, integration } from "../providers";
import {
  ensure,
  orgId,
  pref,
  savePref,
  record,
  batches,
  addAudit,
  convertField,
} from "./shared";
import { DEFAULT_SUBCATEGORIES } from "../ported/crm-defaults";
import { googleToken } from "./google";
import { PacingWait } from "./channels";
import { classificationApplicationDecision } from "../ported/crm-policy";
export const crmFeatures = new Hono<AppEnv>();
const categories = ["interested", "customer", "not_interested", "other"];
export async function ensureTaxonomy(env: Env, org: string) {
  if (await pref(env, org, "taxonomy-seeded", false)) return;
  await env.DB.batch([
    ...DEFAULT_SUBCATEGORIES.map((s, i) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO crm_subcategories(id,org_id,category,name,description,guidance,position,stage_rank) VALUES(?,?,?,?,?,?,?,?)",
      ).bind(
        `taxonomy:${org}:${i}`,
        org,
        s.categoryKey,
        s.name,
        s.description,
        s.classificationGuidance,
        s.sortOrder,
        s.stageRank,
      ),
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO preferences(org_id,key,value) VALUES(?,'taxonomy-seeded','true')",
    ).bind(org),
  ]);
}
crmFeatures.get("/crm/categories", async (c) => {
  await ensureTaxonomy(c.env, orgId(c));
  const sub = await c.env.DB.prepare(
    "SELECT * FROM crm_subcategories WHERE org_id=? ORDER BY position,name",
  )
    .bind(orgId(c))
    .all<Row>();
  return c.json({
    items: categories.map((key) => ({
      key,
      subcategories: sub.results.filter((s) => s.category === key),
    })),
  });
});
crmFeatures.post("/crm/subcategories", async (c) => {
  requireAdmin(c);
  const b = await c.req.json<Row>();
  ensure(
    categories.includes(b.category) && text(b.name, 100),
    "Choose a category and a name",
  );
  if (b.sequence_id)
    await record(c.env, orgId(c), "crm_sequences", b.sequence_id);
  const sid = id();
  await c.env.DB.prepare(
    "INSERT INTO crm_subcategories(id,org_id,category,name,description,sequence_id,guidance) VALUES(?,?,?,?,?,?,?)",
  )
    .bind(
      sid,
      orgId(c),
      b.category,
      text(b.name, 100),
      text(b.description, 3000),
      b.sequence_id || null,
      text(b.guidance, 3000),
    )
    .run();
  return c.json({ id: sid }, 201);
});
crmFeatures.patch("/crm/subcategories/:id", async (c) => {
  requireAdmin(c);
  const s = await record(
      c.env,
      orgId(c),
      "crm_subcategories",
      c.req.param("id"),
    ),
    b = await c.req.json<Row>();
  if (b.sequence_id)
    await record(c.env, orgId(c), "crm_sequences", b.sequence_id);
  await c.env.DB.prepare(
    "UPDATE crm_subcategories SET name=?,description=?,sequence_id=?,guidance=? WHERE id=? AND org_id=?",
  )
    .bind(
      text(b.name, 100) || s.name,
      b.description === undefined ? s.description : text(b.description, 3000),
      b.sequence_id === undefined ? s.sequence_id : b.sequence_id,
      b.guidance === undefined ? s.guidance : text(b.guidance, 3000),
      s.id,
      orgId(c),
    )
    .run();
  return c.json({ ok: true });
});
crmFeatures.delete("/crm/subcategories/:id", async (c) => {
  requireAdmin(c);
  await record(c.env, orgId(c), "crm_subcategories", c.req.param("id"));
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE people SET subcategory_id=NULL WHERE org_id=? AND subcategory_id=?",
    ).bind(orgId(c), c.req.param("id")),
    c.env.DB.prepare(
      "DELETE FROM crm_subcategories WHERE org_id=? AND id=?",
    ).bind(orgId(c), c.req.param("id")),
  ]);
  return c.json({ ok: true });
});
crmFeatures.get("/crm/sequences", async (c) =>
  c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT * FROM crm_sequences WHERE org_id=? ORDER BY created_at DESC",
      )
        .bind(orgId(c))
        .all()
    ).results.map((r) => ({ ...r, steps: json(r.steps as string, []) })),
  }),
);
function sequenceSteps(value: unknown) {
  ensure(
    Array.isArray(value) && value.length > 0 && value.length <= 20,
    "Use between 1 and 20 sequence steps",
  );
  return value.map((s: Row) => {
    ensure(
      ["email", "linkedin", "whatsapp"].includes(s.channel) &&
        text(s.body || s.prompt, 10000),
      "Each step needs a channel and message or AI prompt",
    );
    ensure(
      Number(s.delay_minutes || 0) >= 0 &&
        Number(s.delay_minutes || 0) <= 525600,
      "Invalid sequence delay",
    );
    return {
      channel: s.channel,
      subject: text(s.subject, 300),
      body: text(s.body, 10000),
      prompt: text(s.prompt, 3000),
      delay_minutes: Math.floor(Number(s.delay_minutes) || 0),
    };
  });
}
crmFeatures.post("/crm/sequences", async (c) => {
  requireAdmin(c);
  const b = await c.req.json<Row>();
  ensure(text(b.name, 200), "Name is required");
  const sid = id();
  await c.env.DB.prepare(
    "INSERT INTO crm_sequences(id,org_id,name,steps) VALUES(?,?,?,?)",
  )
    .bind(
      sid,
      orgId(c),
      text(b.name, 200),
      JSON.stringify(sequenceSteps(b.steps)),
    )
    .run();
  return c.json({ id: sid }, 201);
});
crmFeatures.patch("/crm/sequences/:id", async (c) => {
  requireAdmin(c);
  const s = await record(c.env, orgId(c), "crm_sequences", c.req.param("id")),
    b = await c.req.json<Row>();
  await c.env.DB.prepare(
    "UPDATE crm_sequences SET name=?,steps=? WHERE id=? AND org_id=?",
  )
    .bind(
      text(b.name, 200) || s.name,
      b.steps ? JSON.stringify(sequenceSteps(b.steps)) : s.steps,
      s.id,
      orgId(c),
    )
    .run();
  return c.json({ ok: true });
});
crmFeatures.post("/crm/sequences/:id/publish", async (c) => {
  requireAdmin(c);
  const s = await record(c.env, orgId(c), "crm_sequences", c.req.param("id"));
  sequenceSteps(json(s.steps, []));
  const next = s.published_version + 1;
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO crm_sequence_versions(sequence_id,version,steps) VALUES(?,?,?)",
    ).bind(s.id, next, s.steps),
    c.env.DB.prepare(
      "UPDATE crm_sequences SET published_version=? WHERE id=? AND org_id=?",
    ).bind(next, s.id, orgId(c)),
  ]);
  return c.json({ version: next });
});
crmFeatures.delete("/crm/sequences/:id", async (c) => {
  requireAdmin(c);
  await record(c.env, orgId(c), "crm_sequences", c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM crm_sequences WHERE id=? AND org_id=?")
    .bind(c.req.param("id"), orgId(c))
    .run();
  return c.json({ ok: true });
});
export async function attachSequence(
  env: Env,
  org: string,
  personId: string,
  sequenceId: string,
  expectedContext?: number,
) {
  const p = await record(env, org, "people", personId);
  ensure(!p.dnc, "Lead is on Do Not Contact");
  const context = expectedContext ?? p.crm_context;
  if (p.crm_context !== context) return;
  const s = await record(env, org, "crm_sequences", sequenceId);
  ensure(s.published_version > 0, "Publish the sequence first");
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE drafts SET status='discarded' WHERE org_id=? AND status IN ('pending','queued') AND id IN (SELECT draft_id FROM crm_enrollments WHERE org_id=? AND person_id=? AND status IN ('active','paused')) AND EXISTS(SELECT 1 FROM people WHERE id=? AND org_id=? AND crm_context=? AND dnc=0)",
    ).bind(org, org, personId, personId, org, context),
    env.DB.prepare(
      "UPDATE crm_enrollments SET status='stopped' WHERE org_id=? AND person_id=? AND status IN ('active','paused') AND EXISTS(SELECT 1 FROM people WHERE id=? AND org_id=? AND crm_context=? AND dnc=0)",
    ).bind(org, personId, personId, org, context),
    env.DB.prepare(
      "INSERT INTO crm_enrollments(id,org_id,person_id,sequence_id,version,next_run) SELECT ?,?,?,?,?,? FROM people WHERE id=? AND org_id=? AND crm_context=? AND dnc=0",
    ).bind(
      id(),
      org,
      personId,
      s.id,
      s.published_version,
      now(),
      personId,
      org,
      context,
    ),
  ]);
}
crmFeatures.post("/crm/people/:id/sequence", async (c) => {
  const b = await c.req.json<Row>();
  await attachSequence(c.env, orgId(c), c.req.param("id"), b.sequence_id);
  return c.json({ ok: true });
});
crmFeatures.post("/crm/people/:id/action", async (c) => {
  const p = await record(c.env, orgId(c), "people", c.req.param("id")),
    b = await c.req.json<Row>();
  ensure(
    ["pause", "resume", "stop", "snooze", "dnc", "reopen"].includes(b.action),
    "Unknown action",
  );
  if (b.action === "snooze") {
    ensure(
      Number.isFinite(Date.parse(b.until)) && Date.parse(b.until) > Date.now(),
      "Choose a future date",
    );
    await c.env.DB.prepare(
      "UPDATE people SET snoozed_until=? WHERE id=? AND org_id=?",
    )
      .bind(b.until, p.id, orgId(c))
      .run();
  } else if (b.action === "dnc") {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE people SET dnc=1 WHERE id=? AND org_id=?").bind(
        p.id,
        orgId(c),
      ),
      c.env.DB.prepare(
        "UPDATE enrollments SET status='stopped' WHERE org_id=? AND person_id=? AND status='active'",
      ).bind(orgId(c), p.id),
      c.env.DB.prepare(
        "UPDATE crm_enrollments SET status='stopped' WHERE org_id=? AND person_id=? AND status IN ('active','paused')",
      ).bind(orgId(c), p.id),
    ]);
  } else {
    await c.env.DB.prepare(
      "UPDATE crm_enrollments SET status=? WHERE org_id=? AND person_id=? AND status IN ('active','paused')",
    )
      .bind(
        b.action === "pause"
          ? "paused"
          : b.action === "resume"
            ? "active"
            : "stopped",
        orgId(c),
        p.id,
      )
      .run();
    if (b.action === "reopen")
      await c.env.DB.prepare(
        "UPDATE people SET snoozed_until=NULL WHERE id=? AND org_id=?",
      )
        .bind(p.id, orgId(c))
        .run();
  }
  if (["dnc", "stop"].includes(b.action))
    await c.env.DB.prepare(
      "UPDATE drafts SET status='discarded' WHERE org_id=? AND person_id=? AND status IN ('pending','queued')",
    )
      .bind(orgId(c), p.id)
      .run();
  return c.json({ ok: true });
});
export async function setCategory(
  env: Env,
  org: string,
  pid: string,
  category: string,
  subcategory: string | null,
  source = "human",
  reason = "Manually categorized",
  confidence = 1,
  messageId: string | null = null,
  expectedContext?: number,
) {
  const p = await record(env, org, "people", pid),
    context = expectedContext ?? p.crm_context;
  if (p.crm_context !== context) return;
  ensure(categories.includes(category), "Invalid category");
  const sub = subcategory
    ? await record(env, org, "crm_subcategories", subcategory)
    : null;
  if (sub)
    ensure(
      sub.category === category,
      "Subcategory belongs to another category",
    );
  const oldSub = p.subcategory_id
    ? await env.DB.prepare(
        "SELECT stage_rank FROM crm_subcategories WHERE id=? AND org_id=?",
      )
        .bind(p.subcategory_id, org)
        .first<Row>()
    : null;
  const isDnc = !!sub && /^do not contact$/i.test(sub.name);
  const policy = await pref<Row>(env, org, "crm-policy", {
    autoApplyConfidence: 0.8,
    reviewOther: true,
    customerRequiresReview: true,
  });
  const decision =
    source === "human" || isDnc
      ? "auto_apply"
      : classificationApplicationDecision({
          currentCategoryKey: p.category,
          currentCategoryLocked: !!p.category_locked || p.stage === "customer",
          proposedCategoryKey: category,
          confidence,
          autoApplyConfidence: policy.autoApplyConfidence,
          reviewOther: policy.reviewOther,
          customerRequiresReview: policy.customerRequiresReview,
          subcategoryReviewRequired: false,
          currentStageRank:
            oldSub?.stage_rank ??
            (p.stage === "customer" ? 6 : p.stage === "meeting" ? 2 : null),
          proposedStageRank: sub?.stage_rank ?? null,
          proposedSubcategoryKey: isDnc ? "do_not_contact" : subcategory,
        });
  const cid = id(),
    applied = decision === "auto_apply",
    stage =
      source === "ai" && ["meeting", "customer"].includes(p.stage)
        ? p.stage
        : category === "interested"
          ? Number(sub?.stage_rank) >= 2
            ? "meeting"
            : "interested"
          : category === "customer"
            ? "customer"
            : category === "not_interested"
              ? "lost"
              : p.stage;
  const statements = [
    env.DB.prepare(
      "INSERT INTO classifications(id,org_id,person_id,message_id,category,subcategory_id,reason,confidence,previous,decision,applied_at) SELECT ?,?,?,?,?,?,?,?,?,?,? FROM people WHERE id=? AND org_id=? AND crm_context=? AND category IS ? AND subcategory_id IS ? AND stage=?",
    ).bind(
      cid,
      org,
      pid,
      messageId,
      category,
      subcategory,
      text(reason, 1000),
      confidence,
      JSON.stringify({
        category: p.category,
        subcategory_id: p.subcategory_id,
        stage: p.stage,
        source,
        context,
      }),
      decision,
      applied ? now() : null,
      pid,
      org,
      context,
      p.category,
      p.subcategory_id,
      p.stage,
    ),
  ];
  if (applied)
    statements.push(
      env.DB.prepare(
        "UPDATE people SET category=?,subcategory_id=?,stage=?,dnc=CASE WHEN ?=1 THEN 1 ELSE dnc END,crm_context=crm_context+?,updated_at=? WHERE id=? AND org_id=? AND EXISTS(SELECT 1 FROM classifications WHERE id=?)",
      ).bind(
        category,
        subcategory,
        stage,
        isDnc ? 1 : 0,
        source === "human" ? 1 : 0,
        now(),
        pid,
        org,
        cid,
      ),
    );
  if (applied && isDnc) {
    for (const query of [
      "UPDATE enrollments SET status='stopped' WHERE org_id=? AND person_id=? AND status='active'",
      "UPDATE crm_enrollments SET status='stopped' WHERE org_id=? AND person_id=? AND status IN ('active','paused')",
      "UPDATE drafts SET status='discarded' WHERE org_id=? AND person_id=? AND status IN ('pending','queued')",
    ])
      statements.push(
        env.DB.prepare(
          query + " AND EXISTS(SELECT 1 FROM classifications WHERE id=?)",
        ).bind(org, pid, cid),
      );
  }
  const result = await env.DB.batch(statements);
  if (!result[0].meta.changes) return;
  if (applied && !isDnc && sub?.sequence_id && !p.dnc)
    await attachSequence(
      env,
      org,
      pid,
      sub.sequence_id,
      context + (source === "human" ? 1 : 0),
    );
  return cid;
}
crmFeatures.post("/crm/people/:id/category", async (c) => {
  const b = await c.req.json<Row>();
  return c.json({
    id: await setCategory(
      c.env,
      orgId(c),
      c.req.param("id"),
      b.category,
      b.subcategory_id || null,
    ),
  });
});
crmFeatures.get("/crm/classifications", async (c) =>
  c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT c.*,p.name FROM classifications c JOIN people p ON p.id=c.person_id AND p.org_id=c.org_id WHERE c.org_id=? ORDER BY c.created_at DESC LIMIT 200",
      )
        .bind(orgId(c))
        .all()
    ).results,
  }),
);
crmFeatures.post("/crm/classifications/:id/acknowledge", async (c) => {
  await record(c.env, orgId(c), "classifications", c.req.param("id"));
  await c.env.DB.prepare(
    "UPDATE classifications SET acknowledged_at=? WHERE id=? AND org_id=?",
  )
    .bind(now(), c.req.param("id"), orgId(c))
    .run();
  return c.json({ ok: true });
});
crmFeatures.post("/crm/classifications/:id/undo", async (c) => {
  const cl = await record(
    c.env,
    orgId(c),
    "classifications",
    c.req.param("id"),
  );
  ensure(!cl.undone_at, "Classification has already been undone");
  if (cl.decision !== "auto_apply" && !cl.applied_at) {
    await c.env.DB.prepare(
      "UPDATE classifications SET undone_at=? WHERE id=? AND org_id=?",
    )
      .bind(now(), cl.id, orgId(c))
      .run();
    return c.json({ ok: true });
  }
  const p = await record(c.env, orgId(c), "people", cl.person_id);
  ensure(
    p.category === cl.category && p.subcategory_id === cl.subcategory_id,
    "A newer stage change exists",
  );
  const previous = json<Row>(cl.previous, {}),
    claim = id(),
    org = orgId(c);
  // Store a unique claim on this history row so every write in the batch is
  // fenced against concurrent undo and newer classifications/replies.
  const guard =
    "EXISTS(SELECT 1 FROM classifications WHERE id=? AND org_id=? AND json_extract(previous,'$.undo_claim')=?)";
  const result = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE classifications SET undone_at=?,previous=json_set(previous,'$.undo_claim',?) WHERE id=? AND org_id=? AND undone_at IS NULL AND NOT EXISTS(SELECT 1 FROM classifications newer WHERE newer.org_id=classifications.org_id AND newer.person_id=classifications.person_id AND newer.rowid>classifications.rowid AND newer.applied_at IS NOT NULL AND newer.undone_at IS NULL) AND EXISTS(SELECT 1 FROM people WHERE id=? AND org_id=? AND crm_context=? AND category IS ? AND subcategory_id IS ? AND stage=?)",
    ).bind(
      now(),
      claim,
      cl.id,
      org,
      p.id,
      org,
      p.crm_context,
      p.category,
      p.subcategory_id,
      p.stage,
    ),
    c.env.DB.prepare(
      `UPDATE people SET category=?,subcategory_id=?,stage=?,crm_context=crm_context+1 WHERE id=? AND org_id=? AND ${guard}`,
    ).bind(
      previous.category || null,
      previous.subcategory_id || null,
      previous.stage || "new",
      cl.person_id,
      org,
      cl.id,
      org,
      claim,
    ),
    c.env.DB.prepare(
      `UPDATE drafts SET status='discarded' WHERE org_id=? AND status IN ('pending','queued') AND id IN (SELECT draft_id FROM crm_enrollments WHERE org_id=? AND person_id=? AND status IN ('active','paused')) AND ${guard}`,
    ).bind(org, org, cl.person_id, cl.id, org, claim),
    c.env.DB.prepare(
      `UPDATE crm_enrollments SET status='stopped' WHERE org_id=? AND person_id=? AND status IN ('active','paused') AND ${guard}`,
    ).bind(org, cl.person_id, cl.id, org, claim),
  ]);
  ensure(result[0].meta.changes, "A newer stage change exists", 409);
  return c.json({ ok: true });
});
crmFeatures.get("/crm/actions", async (c) => {
  const items = await c.env.DB.prepare(
    "SELECT p.*,e.id sequence_enrollment_id,e.status sequence_status,e.next_run,e.step,s.name sequence_name FROM people p LEFT JOIN crm_enrollments e ON e.person_id=p.id AND e.org_id=p.org_id AND e.status IN ('active','paused') LEFT JOIN crm_sequences s ON s.id=e.sequence_id AND s.org_id=e.org_id WHERE p.org_id=? AND p.dnc=0 AND (p.snoozed_until IS NULL OR p.snoozed_until<=?) ORDER BY e.next_run LIMIT 1000",
  )
    .bind(orgId(c), now())
    .all();
  return c.json({ items: items.results });
});
crmFeatures.post("/drafts/:id/regenerate", async (c) => {
  const d = await record(c.env, orgId(c), "drafts", c.req.param("id"));
  ensure(d.status === "pending", "Only pending drafts can be regenerated");
  const sequence = await c.env.DB.prepare(
    "SELECT id FROM crm_enrollments WHERE org_id=? AND draft_id=? AND status='active'",
  )
    .bind(orgId(c), d.id)
    .first<Row>();
  if (sequence) {
    const regenerated = await generate(
      c.env,
      orgId(c),
      "Rewrite this human-reviewed follow-up using supplied facts. Preserve its intent, do not invent facts.",
      d.body,
    );
    await c.env.DB.prepare(
      "UPDATE drafts SET body=? WHERE id=? AND org_id=? AND status='pending'",
    )
      .bind(text(regenerated, 10000), d.id, orgId(c))
      .run();
    return c.json({ ok: true });
  }
  await c.env.DB.prepare(
    "UPDATE drafts SET body=? WHERE id=? AND org_id=? AND status='pending'",
  )
    .bind(
      text(
        await generate(
          c.env,
          orgId(c),
          "Rewrite this human-reviewed sales reply. Use only supplied facts.",
          d.body,
        ),
        10000,
      ),
      d.id,
      orgId(c),
    )
    .run();
  return c.json({ ok: true });
});
crmFeatures.get("/send-attempts", async (c) =>
  c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT * FROM send_attempts WHERE org_id=? ORDER BY created_at DESC LIMIT 200",
      )
        .bind(orgId(c))
        .all()
    ).results,
  }),
);
crmFeatures.post("/send-attempts/:id/reconcile", async (c) => {
  requireAdmin(c);
  const org = orgId(c),
    a = await record(c.env, org, "send_attempts", c.req.param("id")),
    b = await c.req.json<Row>();
  ensure(
    ["sent", "not_sent"].includes(b.outcome),
    "Choose the verified provider outcome",
  );
  ensure(
    a.status === "uncertain",
    "Only uncertain attempts need reconciliation",
    409,
  );
  const externalId = text(b.external_id, 300);
  if (b.outcome === "sent") {
    ensure(externalId, "Provider message ID required");
    ensure(
      !a.external_id || a.external_id === externalId,
      "Provider message ID does not match the recorded receipt",
    );
  }
  const job = await record(c.env, org, "jobs", a.job_id),
    payload = json<Row>(job.payload, {});
  const draft = payload.draft_id
    ? await record(c.env, org, "drafts", payload.draft_id)
    : null;
  const en = payload.enrollment_id
    ? await record(c.env, org, "enrollments", payload.enrollment_id)
    : null;
  const campaign = en
    ? await record(c.env, org, "campaigns", en.campaign_id)
    : null;
  const step = campaign
    ? await c.env.DB.prepare(
        "SELECT * FROM steps WHERE campaign_id=? AND position=?",
      )
        .bind(campaign.id, payload.step)
        .first<Row>()
    : null;
  const person = await record(c.env, org, "people", a.person_id),
    snapshot = json<Row>(job.result, {}).dispatch;
  const guard =
    "EXISTS(SELECT 1 FROM send_attempts WHERE id=? AND org_id=? AND status='uncertain')";
  const statements: D1PreparedStatement[] = [];
  if (b.outcome === "sent") {
    const channel = snapshot?.channel || draft?.channel || campaign?.channel;
    ensure(channel, "Cannot identify the original send channel");
    statements.push(
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO messages(id,org_id,person_id,campaign_id,channel,direction,subject,body,status,external_id,account_id,metadata) SELECT ?,?,?,?,?,'outbound',?,?,'sent',?,?,? WHERE ${guard}`,
      ).bind(
        `receipt:${a.id}`,
        org,
        person.id,
        snapshot?.campaign_id || campaign?.id || null,
        channel,
        snapshot?.subject ??
          render(draft?.subject || step?.subject || "", person),
        snapshot?.body ?? render(draft?.body || step?.body || "", person),
        externalId,
        a.account_id,
        JSON.stringify({ reconciled: true, reconstructed: true }),
        a.id,
        org,
      ),
    );
    if (draft) {
      statements.push(
        c.env.DB.prepare(
          `UPDATE drafts SET status='sent' WHERE id=? AND org_id=? AND ${guard}`,
        ).bind(draft.id, org, a.id, org),
      );
      const advance = await crmDraftAdvance(c.env, org, draft.id, a.id);
      if (advance) statements.push(advance);
    }
    if (en) {
      const next = await c.env.DB.prepare(
        "SELECT delay_minutes FROM steps WHERE campaign_id=? AND position=?",
      )
        .bind(campaign!.id, payload.step + 1)
        .first<Row>();
      statements.push(
        c.env.DB.prepare(
          `UPDATE enrollments SET step=step+1,status=?,account_id=COALESCE(?,account_id),gate=?,next_run=? WHERE id=? AND org_id=? AND step=? AND status='active' AND ${guard}`,
        ).bind(
          next ? "active" : "completed",
          a.account_id,
          step?.action === "invite" ? "acceptance" : "",
          new Date(
            Date.now() + (next?.delay_minutes || 0) * 60000,
          ).toISOString(),
          en.id,
          org,
          payload.step,
          a.id,
          org,
        ),
      );
    }
  } else if (draft) {
    statements.push(
      c.env.DB.prepare(
        `UPDATE drafts SET status='pending' WHERE id=? AND org_id=? AND status='queued' AND ${guard}`,
      ).bind(draft.id, org, a.id, org),
    );
  }
  statements.push(
    c.env.DB.prepare(
      `UPDATE jobs SET status=?,error=? WHERE id=? AND org_id=? AND ${guard}`,
    ).bind(
      b.outcome === "sent" ? "done" : "failed",
      b.outcome === "sent"
        ? "Manually reconciled as sent"
        : "Confirmed not sent; explicit retry is available",
      a.job_id,
      org,
      a.id,
      org,
    ),
  );
  statements.push(
    c.env.DB.prepare(
      `INSERT INTO events(id,org_id,type,detail,person_id) SELECT ?,?,'send.reconciled',?,? WHERE ${guard}`,
    ).bind(
      id(),
      org,
      `Provider outcome reconciled: ${b.outcome}`,
      a.person_id,
      a.id,
      org,
    ),
  );
  statements.push(
    c.env.DB.prepare(
      "UPDATE send_attempts SET status=?,external_id=? WHERE id=? AND org_id=? AND status='uncertain' RETURNING id",
    ).bind(b.outcome, externalId || null, a.id, org),
  );
  const result = await c.env.DB.batch(statements);
  ensure(
    result.at(-1)?.meta.changes,
    "This attempt was already reconciled; refresh its outcome",
    409,
  );
  return c.json({ ok: true });
});
crmFeatures.get("/ai/settings", async (c) =>
  c.json(
    await pref(c.env, orgId(c), "ai", {
      defaultModel: "",
      allowedModels: [],
      provider: "",
      transcriptionModel: "",
      instructions: "",
    }),
  ),
);
crmFeatures.put("/ai/settings", async (c) => {
  requireAdmin(c);
  const b = await c.req.json<Row>();
  ensure(
    Array.isArray(b.allowedModels || []) &&
      (b.allowedModels || []).length <= 100,
    "Choose at most 100 allowed models",
  );
  if (b.defaultModel)
    ensure(
      b.allowedModels.includes(b.defaultModel),
      "Default model must be enabled",
    );
  if (b.transcriptionModel)
    ensure(
      b.allowedModels.includes(b.transcriptionModel),
      "Transcription model must be enabled",
    );
  await savePref(c.env, orgId(c), "ai", {
    defaultModel: text(b.defaultModel, 200),
    allowedModels: b.allowedModels || [],
    provider: text(b.provider, 200),
    transcriptionModel: text(b.transcriptionModel, 200),
    instructions: text(b.instructions, 10000),
    byokOnly: b.byokOnly !== false,
  });
  return c.json({ ok: true });
});
crmFeatures.get("/ai/models", async (c) => {
  const cfg = await integration(c.env, orgId(c), "openrouter");
  ensure(cfg, "Connect OpenRouter first");
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${cfg.api_key}` },
  });
  ensure(response.ok, "Model catalog is unavailable");
  return c.json(await response.json());
});
crmFeatures.post("/integrations/:kind", async (c, next) => {
  const kind = c.req.param("kind");
  // Shared providers must retain the base route's validation errors and limits.
  if (!["google-workspace", "google-signin"].includes(kind)) return next();
  requireAdmin(c);
  const b = await c.req.json<Row>();
  await limit(c.env, `integration:${orgId(c)}`, 20, 3600);
  if (kind === "google-workspace") {
    ensure(
      b.client_email && b.private_key && emailValid(String(b.test_email || "")),
      "Service account email, private key and test mailbox are required",
    );
    const access = await googleToken(c.env, orgId(c), b.test_email, b);
    const r = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      { headers: { Authorization: `Bearer ${access}` } },
    );
    ensure(r.ok, "Google could not access the delegated mailbox");
    if (b.pubsub_topic)
      ensure(
        /^projects\/[^/]+\/topics\/[^/]+$/.test(b.pubsub_topic),
        "Invalid Pub/Sub topic",
      );
    b.webhook_secret =
      b.webhook_secret || crypto.randomUUID() + crypto.randomUUID();
  } else if (kind === "google-signin") {
    ensure(b.client_id && b.client_secret, "Client ID and secret are required");
  }
  await c.env.DB.prepare(
    "INSERT INTO integrations(org_id,kind,encrypted,label) VALUES(?,?,?,?) ON CONFLICT(org_id,kind) DO UPDATE SET encrypted=excluded.encrypted,label=excluded.label,updated_at=?",
  )
    .bind(
      orgId(c),
      kind,
      await encrypt(b, c.env.ENCRYPTION_KEY),
      text(b.label, 100) || kind,
      now(),
    )
    .run();
  return c.json({ ok: true });
});
crmFeatures.get("/mailbox-webhook", async (c) => {
  requireAdmin(c);
  const cfg = await integration(c.env, orgId(c), "google-workspace");
  ensure(cfg, "Connect Google Workspace first");
  return c.json({
    url: `${c.env.APP_URL}/api/outreach/webhooks/gmail-watch?token=${cfg.webhook_secret}`,
  });
});
crmFeatures.get("/lead-fields", async (c) =>
  c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT * FROM lead_fields WHERE org_id=? AND entity=? ORDER BY position,name",
      )
        .bind(
          orgId(c),
          c.req.query("entity") === "company" ? "company" : "person",
        )
        .all()
    ).results,
  }),
);
crmFeatures.post("/lead-fields", async (c) => {
  requireAdmin(c);
  const b = await c.req.json<Row>();
  ensure(
    /^[a-zA-Z][a-zA-Z0-9_]{0,49}$/.test(b.key) && text(b.name, 100),
    "Use a unique field key and name",
  );
  ensure(
    [
      "text",
      "number",
      "currency",
      "image",
      "boolean",
      "date",
      "url",
      "email",
      "select",
      "multiselect",
      "json",
    ].includes(b.type),
    "Invalid field type",
  );
  const fid = id();
  await c.env.DB.prepare(
    "INSERT INTO lead_fields(id,org_id,key,name,type,options,entity) VALUES(?,?,?,?,?,?,?)",
  )
    .bind(
      fid,
      orgId(c),
      b.key,
      text(b.name, 100),
      b.type,
      JSON.stringify(b.options || []),
      b.entity === "company" ? "company" : "person",
    )
    .run();
  return c.json({ id: fid }, 201);
});
crmFeatures.patch("/lead-fields/:id", async (c) => {
  requireAdmin(c);
  const f = await record(c.env, orgId(c), "lead_fields", c.req.param("id")),
    b = await c.req.json<Row>();
  if (b.type && b.type !== f.type) {
    ensure(
      [
        "text",
        "number",
        "currency",
        "boolean",
        "date",
        "url",
        "email",
        "image",
        "select",
        "multiselect",
        "json",
      ].includes(b.type),
      "Unsupported field type",
    );
    const table = f.entity === "company" ? "companies" : "people",
      rows = await c.env.DB.prepare(
        `SELECT id,custom FROM ${table} WHERE org_id=?`,
      )
        .bind(orgId(c))
        .all<Row>();
    const converted = rows.results.map((r) => ({
      id: r.id,
      ...convertField(json<Row>(r.custom, {})[f.key], b.type),
    }));
    const incompatible = converted.filter((r) => !r.compatible).length;
    ensure(
      !incompatible || b.acknowledge_incompatible === incompatible,
      `${incompatible} incompatible values would become empty; preview and acknowledge this count first`,
    );
    await batches(
      c.env,
      converted.map((r) =>
        c.env.DB.prepare(
          `UPDATE ${table} SET custom=json_set(custom,?,json(?)) WHERE id=? AND org_id=?`,
        ).bind('$."' + f.key + '"', JSON.stringify(r.value), r.id, orgId(c)),
      ),
    );
    await c.env.DB.prepare(
      "UPDATE lead_fields SET type=? WHERE id=? AND org_id=?",
    )
      .bind(b.type, f.id, orgId(c))
      .run();
  }
  await c.env.DB.prepare(
    "UPDATE lead_fields SET name=?,options=?,position=? WHERE id=? AND org_id=?",
  )
    .bind(
      text(b.name, 100) || f.name,
      JSON.stringify(b.options || json(f.options, [])),
      Number(b.position) || f.position,
      f.id,
      orgId(c),
    )
    .run();
  return c.json({ ok: true });
});
crmFeatures.delete("/lead-fields/:id", async (c) => {
  requireAdmin(c);
  await record(c.env, orgId(c), "lead_fields", c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM lead_fields WHERE id=? AND org_id=?")
    .bind(c.req.param("id"), orgId(c))
    .run();
  return c.json({ ok: true });
});
for (const [path, table] of [
  ["notes", "lead_notes"],
  ["tasks", "lead_tasks"],
] as const) {
  crmFeatures.get("/" + path, async (c) => {
    const pid = c.req.query("person_id");
    if (pid) await record(c.env, orgId(c), "people", pid);
    const items = await c.env.DB.prepare(
      `SELECT * FROM ${table} WHERE org_id=? AND (? IS NULL OR person_id=?) ORDER BY created_at DESC LIMIT 500`,
    )
      .bind(orgId(c), pid || null, pid || null)
      .all();
    return c.json({ items: items.results });
  });
  crmFeatures.post("/" + path, async (c) => {
    const b = await c.req.json<Row>();
    if (b.person_id) await record(c.env, orgId(c), "people", b.person_id);
    const nid = id();
    if (path === "notes") {
      ensure(b.person_id && text(b.body), "Lead and note are required");
      await c.env.DB.prepare(
        "INSERT INTO lead_notes(id,org_id,person_id,body,created_by) VALUES(?,?,?,?,?)",
      )
        .bind(nid, orgId(c), b.person_id, text(b.body), c.get("user").id)
        .run();
    } else {
      ensure(text(b.title, 300), "Task title is required");
      if (b.assigned_to)
        ensure(
          await c.env.DB.prepare(
            "SELECT 1 FROM members WHERE org_id=? AND user_id=?",
          )
            .bind(orgId(c), b.assigned_to)
            .first(),
          "Assignee must belong to this workspace",
        );
      await c.env.DB.prepare(
        "INSERT INTO lead_tasks(id,org_id,person_id,title,due_at,assigned_to) VALUES(?,?,?,?,?,?)",
      )
        .bind(
          nid,
          orgId(c),
          b.person_id || null,
          text(b.title, 300),
          b.due_at || null,
          b.assigned_to || null,
        )
        .run();
    }
    return c.json({ id: nid }, 201);
  });
  crmFeatures.patch("/" + path + "/:id", async (c) => {
    const r = await record(c.env, orgId(c), table, c.req.param("id")),
      b = await c.req.json<Row>();
    if (path === "notes")
      await c.env.DB.prepare(
        "UPDATE lead_notes SET body=? WHERE id=? AND org_id=?",
      )
        .bind(text(b.body) || r.body, r.id, orgId(c))
        .run();
    else
      await c.env.DB.prepare(
        "UPDATE lead_tasks SET title=?,due_at=?,status=? WHERE id=? AND org_id=?",
      )
        .bind(
          text(b.title, 300) || r.title,
          b.due_at || r.due_at,
          ["open", "done"].includes(b.status) ? b.status : r.status,
          r.id,
          orgId(c),
        )
        .run();
    return c.json({ ok: true });
  });
  crmFeatures.delete("/" + path + "/:id", async (c) => {
    await record(c.env, orgId(c), table, c.req.param("id"));
    await c.env.DB.prepare(`DELETE FROM ${table} WHERE id=? AND org_id=?`)
      .bind(c.req.param("id"), orgId(c))
      .run();
    return c.json({ ok: true });
  });
}
crmFeatures.patch("/messages/:id", async (c) => {
  const r = await record(c.env, orgId(c), "messages", c.req.param("id")),
    b = await c.req.json<Row>();
  await c.env.DB.prepare(
    "UPDATE messages SET important=?,read_at=? WHERE id=? AND org_id=?",
  )
    .bind(
      b.important === undefined ? r.important : b.important ? 1 : 0,
      b.read === undefined ? r.read_at : b.read ? now() : null,
      r.id,
      orgId(c),
    )
    .run();
  return c.json({ ok: true });
});
crmFeatures.patch("/knowledge/:id", async (c) => {
  requireAdmin(c);
  const r = await record(c.env, orgId(c), "knowledge", c.req.param("id")),
    b = await c.req.json<Row>();
  await c.env.DB.prepare(
    "UPDATE knowledge SET title=?,content=? WHERE id=? AND org_id=?",
  )
    .bind(
      text(b.title, 200) || r.title,
      text(b.content, 20000) || r.content,
      r.id,
      orgId(c),
    )
    .run();
  return c.json({ ok: true });
});
crmFeatures.post("/drafts/:id/send", async (c) => {
  const d = await record(c.env, orgId(c), "drafts", c.req.param("id")),
    b = await c.req.json<Row>(),
    p = await record(c.env, orgId(c), "people", d.person_id);
  ensure(!p.dnc, "Lead is on Do Not Contact");
  ensure(d.status === "pending", "Draft is already queued");
  let account: Row | null = null;
  if (b.account_id)
    account = await record(c.env, orgId(c), "channel_accounts", b.account_id);
  else if (d.message_id) {
    const m = await record(c.env, orgId(c), "messages", d.message_id);
    if (m.account_id)
      account = await record(c.env, orgId(c), "channel_accounts", m.account_id);
  }
  if (!account)
    account = await c.env.DB.prepare(
      "SELECT * FROM channel_accounts WHERE org_id=? AND channel=? AND status='connected' ORDER BY is_default DESC,rowid LIMIT 1",
    )
      .bind(orgId(c), d.channel)
      .first<Row>();
  const provider =
    d.channel === "email"
      ? account && json<Row>(account.settings, {}).provider === "gmail"
        ? "google-workspace"
        : "resend"
      : "unipile";
  ensure(
    await integration(c.env, orgId(c), provider),
    `Connect ${provider} first`,
  );
  if (account)
    ensure(
      account.channel === d.channel && account.status === "connected",
      "Choose a connected account for this channel",
    );
  const jid = `draft:${d.id}`,
    payload = {
      draft_id: d.id,
      person_id: d.person_id,
      account_id: account?.id || "",
      provider: provider === "google-workspace" ? "gmail" : "resend",
    };
  // Persist approval and its outbox in one transaction. A worker interruption
  // cannot strand a queued draft without a durable job for Cron to publish.
  const result = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE drafts SET status='queued' WHERE id=? AND org_id=? AND status='pending' AND NOT EXISTS(SELECT 1 FROM crm_enrollments WHERE org_id=? AND draft_id=? AND status<>'active') AND NOT EXISTS(SELECT 1 FROM jobs WHERE id=? AND status IN ('uncertain','done','running')) AND EXISTS(SELECT 1 FROM people WHERE id=? AND org_id=? AND dnc=0 AND crm_context=?) RETURNING id",
    ).bind(d.id, orgId(c), orgId(c), d.id, jid, p.id, orgId(c), p.crm_context),
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO jobs(id,org_id,kind,payload) SELECT ?,?,'send',? WHERE EXISTS(SELECT 1 FROM drafts WHERE id=? AND org_id=? AND status='queued')",
    ).bind(jid, orgId(c), JSON.stringify(payload), d.id, orgId(c)),
    c.env.DB.prepare(
      "UPDATE jobs SET status='pending',available_at=?,error='',payload=? WHERE id=? AND org_id=? AND status='failed' AND EXISTS(SELECT 1 FROM drafts WHERE id=? AND status='queued')",
    ).bind(now(), JSON.stringify(payload), jid, orgId(c), d.id),
  ]);
  ensure(
    result[0].meta.changes,
    "Draft changed or its sequence is paused/stopped; refresh before sending",
    409,
  );
  return c.json(
    { job: await enqueue(c.env, orgId(c), "send", payload, jid) },
    202,
  );
});
export async function advanceCrmDraft(env: Env, org: string, draftId: string) {
  const statement = await crmDraftAdvance(env, org, draftId);
  if (statement) await statement.run();
}
export async function crmDraftAdvance(
  env: Env,
  org: string,
  draftId: string,
  attemptId?: string,
) {
  const enrollment = await env.DB.prepare(
    "SELECT * FROM crm_enrollments WHERE org_id=? AND draft_id=? AND status='active'",
  )
    .bind(org, draftId)
    .first<Row>();
  if (!enrollment) return;
  const version = await env.DB.prepare(
      "SELECT steps FROM crm_sequence_versions WHERE sequence_id=? AND version=?",
    )
      .bind(enrollment.sequence_id, enrollment.version)
      .first<{ steps: string }>(),
    steps = json<Row[]>(version?.steps, []),
    next = steps[enrollment.step + 1];
  return env.DB.prepare(
    "UPDATE crm_enrollments SET step=step+1,status=?,draft_id=NULL,next_run=? WHERE id=? AND org_id=? AND draft_id=? AND step=? AND status='active' AND (? IS NULL OR EXISTS(SELECT 1 FROM send_attempts WHERE id=? AND org_id=? AND status='uncertain'))",
  ).bind(
    next ? "active" : "completed",
    next
      ? new Date(
          Date.now() + Number(next.delay_minutes || 0) * 60000,
        ).toISOString()
      : now(),
    enrollment.id,
    org,
    draftId,
    enrollment.step,
    attemptId || null,
    attemptId || null,
    org,
  );
}
export async function crmSequenceTick(env: Env) {
  const enrollments = await env.DB.prepare(
    "SELECT e.* FROM crm_enrollments e JOIN people p ON p.id=e.person_id AND p.org_id=e.org_id WHERE e.status='active' AND e.draft_id IS NULL AND e.next_run<=? AND p.dnc=0 AND (p.snoozed_until IS NULL OR p.snoozed_until<=?) LIMIT 100",
  )
    .bind(now(), now())
    .all<Row>();
  for (const e of enrollments.results)
    await enqueue(
      env,
      e.org_id,
      "crm-sequence",
      { enrollment_id: e.id },
      `crm-sequence:${e.id}:${e.step}`,
    );
}
export async function createSequenceDraft(
  env: Env,
  org: string,
  enrollmentId: string,
) {
  const e = await record(env, org, "crm_enrollments", enrollmentId);
  const person = await record(env, org, "people", e.person_id);
  if (
    e.draft_id ||
    person.dnc ||
    e.status === "stopped" ||
    e.status === "completed"
  )
    return;
  if (
    e.status === "paused" ||
    (person.snoozed_until && person.snoozed_until > now())
  )
    throw new PacingWait("Follow-up sequence is paused or snoozed", 900);
  if (e.next_run > now())
    throw new PacingWait(
      "Waiting for the next follow-up time",
      Math.max(1, Math.ceil((Date.parse(e.next_run) - Date.now()) / 1000)),
    );
  {
    const version = await env.DB.prepare(
        "SELECT steps FROM crm_sequence_versions WHERE sequence_id=? AND version=?",
      )
        .bind(e.sequence_id, e.version)
        .first<{ steps: string }>(),
      step = json<Row[]>(version?.steps, [])[e.step];
    if (!step) {
      await env.DB.prepare(
        "UPDATE crm_enrollments SET status='completed' WHERE id=?",
      )
        .bind(e.id)
        .run();
      return;
    }
    const p = await record(env, e.org_id, "people", e.person_id),
      did = `sequence-draft:${e.id}:${e.step}`;
    let body = render(step.body || "", p);
    if (step.prompt)
      body = await generate(
        env,
        e.org_id,
        "Draft a concise human-reviewed sales follow-up. Use only supplied facts.",
        render(step.prompt, p),
      );
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO drafts(id,org_id,person_id,channel,subject,body) SELECT ?,?,?,?,?,? FROM crm_enrollments e JOIN people p ON p.id=e.person_id AND p.org_id=e.org_id WHERE e.id=? AND e.org_id=? AND e.status='active' AND e.step=? AND e.draft_id IS NULL AND p.dnc=0 AND p.crm_context=? AND (p.snoozed_until IS NULL OR p.snoozed_until<=?)",
      ).bind(
        did,
        e.org_id,
        p.id,
        step.channel,
        render(step.subject || "", p),
        body,
        e.id,
        org,
        e.step,
        person.crm_context,
        now(),
      ),
      env.DB.prepare(
        "UPDATE crm_enrollments SET draft_id=? WHERE id=? AND org_id=? AND draft_id IS NULL AND status='active' AND step=? AND EXISTS(SELECT 1 FROM drafts WHERE id=? AND status='pending')",
      ).bind(did, e.id, e.org_id, e.step, did),
    ]);
  }
}

crmFeatures.get("/crm/policy", async (c) =>
  c.json(
    await pref(c.env, orgId(c), "crm-policy", {
      autoApplyConfidence: 0.8,
      reviewOther: true,
      customerRequiresReview: true,
    }),
  ),
);
crmFeatures.put("/crm/policy", async (c) => {
  requireAdmin(c);
  const b = await c.req.json<Row>();
  ensure(
    Number.isFinite(b.autoApplyConfidence) &&
      b.autoApplyConfidence >= 0 &&
      b.autoApplyConfidence <= 1,
    "Confidence must be 0 to 1",
  );
  await savePref(c.env, orgId(c), "crm-policy", {
    autoApplyConfidence: b.autoApplyConfidence,
    reviewOther: b.reviewOther !== false,
    customerRequiresReview: b.customerRequiresReview !== false,
  });
  return c.json({ ok: true });
});
crmFeatures.post("/crm/classifications/:id/apply", async (c) => {
  const cl = await record(
    c.env,
    orgId(c),
    "classifications",
    c.req.param("id"),
  );
  ensure(!cl.undone_at && !cl.applied_at, "Classification already handled");
  const person = await record(c.env, orgId(c), "people", cl.person_id),
    previous = json<Row>(cl.previous, {});
  ensure(
    previous.context === undefined || previous.context === person.crm_context,
    "A newer reply or stage change exists; classify again",
    409,
  );
  const accepted = await setCategory(
    c.env,
    orgId(c),
    cl.person_id,
    cl.category,
    cl.subcategory_id,
    "human",
    "Accepted AI suggestion",
    1,
    cl.message_id,
    previous.context ?? person.crm_context,
  );
  ensure(accepted, "A newer reply or stage change exists; classify again", 409);
  await c.env.DB.prepare(
    "UPDATE classifications SET applied_at=?,acknowledged_at=? WHERE id=? AND org_id=?",
  )
    .bind(now(), now(), cl.id, orgId(c))
    .run();
  return c.json({ ok: true });
});
