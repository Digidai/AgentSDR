import { Hono } from "hono";
import type { AppEnv, Env, Row } from "../types";
import {
  constantEqual,
  digest,
  extractJson,
  id,
  json,
  modelText,
  now,
  sign,
  text,
  token,
} from "../core";
import { enqueue } from "../jobs";
import { integration, generate } from "../providers";
import { ensure, orgId, pref, record } from "./shared";
import {
  MAX_RECORDING_BYTES,
  CONTACT_CALL_STATUSES,
  CALL_DISPOSITIONS,
  RETRY_AFTER_DAYS,
} from "../ported/calls/contract";
import { normalizePhone } from "./phone";
import { strictAiRuntime } from "./ai";
export const callFeatures = new Hono<AppEnv>(),
  recorderRoutes = new Hono<AppEnv>();
export function callSummary(r: Row) {
  return {
    id: r.id,
    personId: r.person_id,
    crmRecordId: r.person_id,
    campaignContactId: r.contact_id,
    phone: r.phone,
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationMs: r.duration_ms,
    hasRecording: !!r.recording_key,
    recordingOffsetMs: r.recording_offset_ms,
    error: r.error,
    disposition: r.disposition,
    transcriptStatus: r.transcript_status,
    createdAt: r.created_at,
    transcript: json(r.transcript, null),
    transcriptError: r.transcript_error,
  };
}
async function recorder(c: any, write = false) {
  const bearer =
    c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") || "";
  ensure(bearer, "Missing recorder token", 403);
  const row = await c.env.DB.prepare("SELECT * FROM calls WHERE id=?")
    .bind(c.req.param("id"))
    .first();
  ensure(
    row &&
      constantEqual(await digest(bearer), row.recorder_token_hash) &&
      row.token_expires_at > now(),
    "Recorder token invalid or expired",
    403,
  );
  if (write)
    ensure(
      !["recorded", "failed", "no_recording"].includes(row.status),
      "Call is already finished",
      409,
    );
  return row as Row;
}
callFeatures.post("/calls", async (c) => {
  const b = await c.req.json<Row>(),
    p = await record(c.env, orgId(c), "people", b.personId || b.person_id);
  ensure(!p.dnc, "This lead is on Do Not Contact");
  const phone = await normalizePhone(c.env, orgId(c), b.phone || p.phone);
  ensure(/^\+[1-9]\d{6,14}$/.test(phone), "Use an international phone number");
  if (b.campaignContactId) {
    const contact = await record(
      c.env,
      orgId(c),
      "call_contacts",
      b.campaignContactId,
    );
    ensure(contact.person_id === p.id, "Call contact does not match the lead");
  }
  const cid = id(),
    raw = token();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE people SET phone=? WHERE id=? AND org_id=?").bind(
      phone,
      p.id,
      orgId(c),
    ),
    c.env.DB.prepare(
      "INSERT INTO calls(id,org_id,person_id,contact_id,phone,recorder_token_hash,token_expires_at) VALUES(?,?,?,?,?,?,?)",
    ).bind(
      cid,
      orgId(c),
      p.id,
      b.campaignContactId || null,
      phone,
      await digest(raw),
      new Date(Date.now() + 4 * 3600000).toISOString(),
    ),
  ]);
  if (b.campaignContactId)
    await c.env.DB.prepare(
      "UPDATE call_contacts SET call_status='calling',last_called_at=? WHERE id=? AND org_id=?",
    )
      .bind(now(), b.campaignContactId, orgId(c))
      .run();
  return c.json(
    {
      call: callSummary(await record(c.env, orgId(c), "calls", cid)),
      recorderToken: raw,
      lead: {
        name: p.name,
        detail: [p.title, p.company].filter(Boolean).join(" · "),
        firstName: p.name.split(" ")[0],
        company: p.company,
      },
    },
    201,
  );
});
callFeatures.get("/calls", async (c) => {
  const personId = c.req.query("personId") || c.req.query("person_id");
  if (personId) await record(c.env, orgId(c), "people", personId);
  const items = await c.env.DB.prepare(
    "SELECT * FROM calls WHERE org_id=? AND (? IS NULL OR person_id=?) ORDER BY created_at DESC LIMIT 300",
  )
    .bind(orgId(c), personId || null, personId || null)
    .all<Row>();
  return c.json({ calls: items.results.map(callSummary) });
});
callFeatures.get("/calls/:id", async (c) =>
  c.json(
    callSummary(await record(c.env, orgId(c), "calls", c.req.param("id"))),
  ),
);
callFeatures.post("/calls/:id/cancel", async (c) => {
  const call = await record(c.env, orgId(c), "calls", c.req.param("id"));
  const changed = await c.env.DB.prepare(
    "UPDATE calls SET status='no_recording',ended_at=?,error='Cancelled by user' WHERE id=? AND org_id=? AND status='pending' RETURNING id",
  )
    .bind(now(), c.req.param("id"), orgId(c))
    .first();
  if (changed && call.contact_id)
    await c.env.DB.prepare(
      "UPDATE call_contacts SET call_status=CASE WHEN stage='follow_up' THEN 'connected' WHEN unanswered_attempts>0 THEN 'no_answer' ELSE 'new' END WHERE id=? AND org_id=? AND call_status='calling' AND NOT EXISTS(SELECT 1 FROM calls newer JOIN calls current ON current.id=? WHERE newer.org_id=current.org_id AND newer.contact_id=current.contact_id AND newer.rowid>current.rowid)",
    )
      .bind(call.contact_id, orgId(c), call.id)
      .run();
  return c.json(
    callSummary(await record(c.env, orgId(c), "calls", c.req.param("id"))),
  );
});
callFeatures.patch("/calls/:id", async (c) => {
  const r = await record(c.env, orgId(c), "calls", c.req.param("id")),
    b = await c.req.json<Row>();
  ensure(
    CALL_DISPOSITIONS.includes(b.disposition),
    "Choose a valid call outcome",
  );
  await c.env.DB.prepare(
    "UPDATE calls SET disposition=? WHERE id=? AND org_id=?",
  )
    .bind(b.disposition, r.id, orgId(c))
    .run();
  if (r.contact_id)
    await outcome(c.env, orgId(c), r.contact_id, b.disposition, b.followUpAt, {
      callId: r.id,
    });
  if (b.disposition === "do_not_call")
    await doNotCall(c.env, orgId(c), r.person_id);
  if (b.disposition === "interested" || b.disposition === "meeting_booked")
    await c.env.DB.prepare("UPDATE people SET stage=? WHERE id=? AND org_id=?")
      .bind(
        b.disposition === "interested" ? "interested" : "meeting",
        r.person_id,
        orgId(c),
      )
      .run();
  return c.json({ ok: true });
});
callFeatures.get("/calls/:id/recording", async (c) => {
  const r = await record(c.env, orgId(c), "calls", c.req.param("id"));
  ensure(r.recording_key, "No recording is available", 404);
  const expires = String(Date.now() + 5 * 60000),
    sig = await sign(`${r.id}:${expires}`, c.env.UNSUBSCRIBE_SECRET);
  return c.redirect(
    `/api/recordings/${r.id}?expires=${expires}&signature=${sig}`,
  );
});
recorderRoutes.get("/recordings/:id", async (c) => {
  const expires = c.req.query("expires") || "",
    signature = c.req.query("signature") || "";
  ensure(
    Number(expires) > Date.now() &&
      Number(expires) < Date.now() + 6 * 60000 &&
      constantEqual(
        signature,
        await sign(`${c.req.param("id")}:${expires}`, c.env.UNSUBSCRIBE_SECRET),
      ),
    "Recording link expired",
    403,
  );
  const r = await c.env.DB.prepare(
    "SELECT recording_key,content_type FROM calls WHERE id=?",
  )
    .bind(c.req.param("id"))
    .first<Row>();
  ensure(r?.recording_key, "Recording not found", 404);
  const object = await c.env.MEDIA.get(r.recording_key, {
    range: c.req.raw.headers,
  });
  ensure(object, "Recording not found", 404);
  const headers = new Headers({
    "Content-Type": r.content_type || "audio/webm",
    "Cache-Control": "private,no-store",
    "Accept-Ranges": "bytes",
  });
  object.writeHttpMetadata(headers);
  if (object.range && "offset" in object.range) {
    headers.set(
      "Content-Range",
      `bytes ${object.range.offset}-${(object.range.offset || 0) + (object.range.length || object.size) - 1}/${object.size}`,
    );
    headers.set("Content-Length", String(object.range.length));
  }
  return new Response(object.body, {
    status: object.range ? 206 : 200,
    headers,
  });
});
callFeatures.post("/calls/:id/transcribe", async (c) => {
  const r = await record(c.env, orgId(c), "calls", c.req.param("id"));
  ensure(r.status === "recorded", "No recording is available");
  const claimed = await c.env.DB.prepare(
    "UPDATE calls SET transcript_status='pending',transcript_error=NULL WHERE id=? AND org_id=? AND transcript_status!='pending' RETURNING id",
  )
    .bind(r.id, orgId(c))
    .first();
  if (claimed)
    await enqueue(c.env, orgId(c), "call-transcribe", { call_id: r.id });
  return c.json(callSummary(await record(c.env, orgId(c), "calls", r.id)));
});
recorderRoutes.options(
  "/call-recorder/*",
  (c) =>
    new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
        "Access-Control-Allow-Headers": "Authorization,Content-Type",
      },
    }),
);
recorderRoutes.use("/call-recorder/*", async (c, next) => {
  await next();
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Cache-Control", "no-store");
});
recorderRoutes.get("/call-recorder/calls/:id", async (c) => {
  const r = await recorder(c);
  return c.json({
    status: r.status,
    transcriptStatus: r.transcript_status,
    summary: json<Row>(r.transcript, {})?.summary || null,
    durationMs: r.duration_ms,
  });
});
recorderRoutes.post("/call-recorder/calls/:id/started", async (c) => {
  const r = await recorder(c, true),
    b = await c.req.json<Row>();
  ensure(Number.isFinite(Date.parse(b.startedAt)), "Invalid call start time");
  await c.env.DB.prepare(
    "UPDATE calls SET status='in_progress',started_at=? WHERE id=? AND org_id=? AND status='pending'",
  )
    .bind(b.startedAt, r.id, r.org_id)
    .run();
  return c.json({ ok: true });
});
recorderRoutes.post("/call-recorder/calls/:id/upload-url", async (c) => {
  const r = await recorder(c, true),
    b = await c.req.json<Row>();
  ensure(
    Number.isInteger(b.bytes) && b.bytes > 0 && b.bytes <= MAX_RECORDING_BYTES,
    "Recording exceeds 200 MB",
  );
  ensure(
    /^audio\/(webm|ogg|wav|mp3|mpeg|mp4)(;.*)?$/.test(b.contentType),
    "Unsupported audio type",
  );
  const key = `${r.org_id}/recordings/${r.id}.webm`,
    expires = String(Date.now() + 15 * 60000),
    signature = await sign(
      `${r.id}:${key}:${b.bytes}:${expires}`,
      c.env.UNSUBSCRIBE_SECRET,
    );
  const upload = await c.env.MEDIA.createMultipartUpload(key, {
    httpMetadata: { contentType: b.contentType },
  });
  await c.env.DB.prepare(
    "UPDATE calls SET recording_bytes=?,content_type=?,upload_id=? WHERE id=? AND org_id=?",
  )
    .bind(b.bytes, b.contentType, upload.uploadId, r.id, r.org_id)
    .run();
  const uploadUrl = `${c.env.APP_URL}/api/call-recorder/calls/${r.id}/upload?expires=${expires}&bytes=${b.bytes}&signature=${signature}`;
  return c.json({
    uploadUrl,
    recordingKey: key,
    headers: { "Content-Type": b.contentType },
    multipart: {
      partSize: 8 * 1024 * 1024,
      completeUrl: uploadUrl + "&complete=1",
    },
  });
});
recorderRoutes.put("/call-recorder/calls/:id/upload", async (c) => {
  const r = await c.env.DB.prepare("SELECT * FROM calls WHERE id=?")
    .bind(c.req.param("id"))
    .first<Row>();
  ensure(
    r && ["pending", "in_progress"].includes(r.status) && r.upload_id,
    "Upload is unavailable",
    403,
  );
  const key = `${r.org_id}/recordings/${r.id}.webm`,
    expires = c.req.query("expires") || "",
    bytes = Number(c.req.query("bytes")),
    signature = c.req.query("signature") || "";
  ensure(
    Number(expires) > Date.now() &&
      bytes === r.recording_bytes &&
      constantEqual(
        signature,
        await sign(
          `${r.id}:${key}:${bytes}:${expires}`,
          c.env.UNSUBSCRIBE_SECRET,
        ),
      ),
    "Upload capability invalid or expired",
    403,
  );
  const upload = c.env.MEDIA.resumeMultipartUpload(key, r.upload_id);
  if (c.req.query("complete")) {
    const body = await c.req.json<Row>();
    ensure(
      Array.isArray(body.parts) &&
        body.parts.length > 0 &&
        body.parts.length <= 26,
      "Invalid multipart upload",
    );
    const object = await upload.complete(body.parts);
    if (object.size !== bytes) {
      await c.env.MEDIA.delete(key);
      ensure(false, "Recording length does not match");
    }
    await c.env.DB.prepare(
      "UPDATE calls SET recording_key=?,upload_parts=? WHERE id=? AND org_id=?",
    )
      .bind(key, JSON.stringify(body.parts), r.id, r.org_id)
      .run();
    return c.json({ ok: true });
  }
  const part = Number(c.req.query("part") || 1);
  ensure(
    Number.isInteger(part) && part >= 1 && part <= 26,
    "Invalid part number",
  );
  const data = await c.req.arrayBuffer();
  ensure(
    data.byteLength <= 8 * 1024 * 1024 && data.byteLength > 0,
    "Part exceeds 8 MB",
  );
  const result = await upload.uploadPart(part, data);
  return c.json(result);
});
recorderRoutes.post("/call-recorder/calls/:id/finish", async (c) => {
  const r = await recorder(c),
    b = await c.req.json<Row>();
  if (["recorded", "no_recording", "failed"].includes(r.status))
    return c.json({ call: callSummary(r) });
  ensure(
    ["recorded", "no_recording", "failed"].includes(b.outcome),
    "Invalid call result",
  );
  if (b.outcome === "recorded") {
    const expected = `${r.org_id}/recordings/${r.id}.webm`;
    ensure(
      b.recordingKey === expected,
      "Recording key does not match this call",
    );
    const object = await c.env.MEDIA.head(expected);
    ensure(
      object && object.size === b.bytes && object.size === r.recording_bytes,
      "Recording upload is incomplete",
    );
    ensure(
      Number.isFinite(b.durationMs) &&
        b.durationMs >= 0 &&
        Number.isFinite(Date.parse(b.startedAt)) &&
        Number.isFinite(Date.parse(b.endedAt)),
      "Invalid recording duration",
    );
  }
  const changed = await c.env.DB.prepare(
    "UPDATE calls SET status=?,recording_key=?,started_at=?,ended_at=?,duration_ms=?,recording_offset_ms=?,error=?,transcript_status=? WHERE id=? AND org_id=? AND status IN ('pending','in_progress') RETURNING id",
  )
    .bind(
      b.outcome,
      b.outcome === "recorded" ? b.recordingKey : null,
      b.startedAt || r.started_at,
      b.endedAt || now(),
      b.durationMs ?? null,
      b.recordingOffsetMs ?? null,
      b.error ? text(b.error, 500) : null,
      b.outcome === "recorded" ? "pending" : "none",
      r.id,
      r.org_id,
    )
    .first();
  if (changed && b.outcome === "recorded")
    await enqueue(c.env, r.org_id, "call-transcribe", { call_id: r.id });
  if (changed && r.contact_id)
    await outcome(
      c.env,
      r.org_id,
      r.contact_id,
      b.outcome === "recorded" ? "connected" : "no_answer",
      undefined,
      { callId: r.id, automatic: true },
    );
  return c.json({
    call: callSummary(await record(c.env, r.org_id, "calls", r.id)),
  });
});
async function doNotCall(env: Env, org: string, personId: string) {
  await env.DB.batch([
    env.DB.prepare("UPDATE people SET dnc=1 WHERE id=? AND org_id=?").bind(
      personId,
      org,
    ),
    env.DB.prepare(
      "UPDATE enrollments SET status='stopped' WHERE org_id=? AND person_id=? AND status='active'",
    ).bind(org, personId),
    env.DB.prepare(
      "UPDATE crm_enrollments SET status='stopped' WHERE org_id=? AND person_id=? AND status IN ('active','paused')",
    ).bind(org, personId),
    env.DB.prepare(
      "UPDATE drafts SET status='discarded' WHERE org_id=? AND person_id=? AND status IN ('pending','queued')",
    ).bind(org, personId),
    env.DB.prepare(
      "UPDATE call_contacts SET call_status='do_not_call',stage='done' WHERE org_id=? AND person_id=?",
    ).bind(org, personId),
  ]);
}
async function outcome(
  env: Env,
  org: string,
  contactId: string,
  value: string,
  follow?: string,
  source?: { callId: string; automatic?: boolean },
) {
  ensure(
    CONTACT_CALL_STATUSES.includes(value as any) ||
      CALL_DISPOSITIONS.includes(value as any),
    "Choose a valid call outcome",
  );
  const r = await record(env, org, "call_contacts", contactId);
  if (value === "do_not_call") {
    await doNotCall(env, org, r.person_id);
    return;
  }
  const person = await record(env, org, "people", r.person_id);
  if (person.dnc || r.call_status === "do_not_call") return;
  let stage = "follow_up",
    attempts = r.unanswered_attempts,
    status = value;
  const countsAttempt = ["no_answer", "busy"].includes(value),
    attemptKey = source ? `call-unanswered:${source.callId}` : null,
    alreadyCounted =
      (source &&
        attempts > 0 &&
        ["no_answer", "busy"].includes(r.call_status)) ||
      (attemptKey
        ? await env.DB.prepare("SELECT id FROM events WHERE id=? AND org_id=?")
            .bind(attemptKey, org)
            .first()
        : false);
  let followAt = follow || null;
  if (countsAttempt) {
    if (!alreadyCounted) attempts++;
    const wait = RETRY_AFTER_DAYS[attempts - 1];
    stage = wait ? "to_call" : "done";
    followAt =
      follow ||
      (wait ? new Date(Date.now() + wait * 86400000).toISOString() : null);
  } else if (
    [
      "wrong_number",
      "not_on_whatsapp",
      "not_interested",
      "do_not_call",
    ].includes(value)
  )
    stage = "done";
  if (!CONTACT_CALL_STATUSES.includes(status as any))
    status = [
      "interested",
      "meeting_booked",
      "callback",
      "send_details",
      "not_interested",
    ].includes(value)
      ? "connected"
      : r.call_status;
  const gate =
      "EXISTS(SELECT 1 FROM people p WHERE p.id=call_contacts.person_id AND p.org_id=call_contacts.org_id AND p.dnc=0) AND call_status<>'do_not_call' AND (? IS NULL OR EXISTS(SELECT 1 FROM calls c WHERE c.id=? AND c.org_id=call_contacts.org_id AND c.contact_id=call_contacts.id AND (?=0 OR (call_status='calling' AND c.disposition IS NULL)) AND NOT EXISTS(SELECT 1 FROM calls newer WHERE newer.org_id=c.org_id AND newer.contact_id=c.contact_id AND newer.rowid>c.rowid)))",
    gateArgs = [
      source?.callId || null,
      source?.callId || null,
      source?.automatic ? 1 : 0,
    ],
    statements: D1PreparedStatement[] = [];
  if (attemptKey && countsAttempt)
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO events(id,org_id,type,detail,person_id) SELECT ?,org_id,'call.unanswered',?,person_id FROM call_contacts WHERE id=? AND org_id=? AND ${gate}`,
      ).bind(
        attemptKey,
        JSON.stringify({ call_id: source!.callId }),
        r.id,
        org,
        ...gateArgs,
      ),
    );
  statements.push(
    env.DB.prepare(
      `UPDATE call_contacts SET call_status=?,stage=?,unanswered_attempts=${attemptKey && countsAttempt ? "unanswered_attempts+?*changes()" : "?"},follow_up_at=? WHERE id=? AND org_id=? AND ${gate}`,
    ).bind(
      status,
      stage,
      ...(attemptKey && countsAttempt ? [alreadyCounted ? 0 : 1] : [attempts]),
      followAt,
      r.id,
      org,
      ...gateArgs,
    ),
  );
  await env.DB.batch(statements);
}
callFeatures.get("/calling/campaigns", async (c) => {
  const items = await c.env.DB.prepare(
    "SELECT c.*,(SELECT COUNT(*) FROM call_contacts ct WHERE ct.campaign_id=c.id) leads,(SELECT COUNT(*) FROM call_contacts ct WHERE ct.campaign_id=c.id AND ct.last_called_at IS NOT NULL) called FROM call_campaigns c WHERE c.org_id=? ORDER BY c.created_at DESC",
  )
    .bind(orgId(c))
    .all();
  return c.json({ items: items.results, campaigns: items.results });
});
callFeatures.post("/calling/campaigns", async (c) => {
  const b = await c.req.json<Row>();
  ensure(text(b.name, 200), "Name is required");
  const cid = id();
  await c.env.DB.prepare(
    "INSERT INTO call_campaigns(id,org_id,name,description) VALUES(?,?,?,?)",
  )
    .bind(cid, orgId(c), text(b.name, 200), text(b.description, 3000))
    .run();
  return c.json({ id: cid }, 201);
});
callFeatures.get("/calling/campaigns/:id", async (c) => {
  const campaign = await record(
    c.env,
    orgId(c),
    "call_campaigns",
    c.req.param("id"),
  );
  const contacts = await c.env.DB.prepare(
    "SELECT ct.*,p.name,p.email,p.phone,p.company,p.title,p.dnc FROM call_contacts ct JOIN people p ON p.id=ct.person_id AND p.org_id=ct.org_id WHERE ct.org_id=? AND ct.campaign_id=? ORDER BY ct.follow_up_at LIMIT 1000",
  )
    .bind(orgId(c), campaign.id)
    .all();
  return c.json({ ...campaign, contacts: contacts.results });
});
callFeatures.patch("/calling/campaigns/:id", async (c) => {
  const r = await record(c.env, orgId(c), "call_campaigns", c.req.param("id")),
    b = await c.req.json<Row>();
  await c.env.DB.prepare(
    "UPDATE call_campaigns SET name=?,description=?,status=? WHERE id=? AND org_id=?",
  )
    .bind(
      text(b.name, 200) || r.name,
      b.description === undefined ? r.description : text(b.description, 3000),
      ["active", "paused"].includes(b.status) ? b.status : r.status,
      r.id,
      orgId(c),
    )
    .run();
  return c.json({ ok: true });
});
callFeatures.delete("/calling/campaigns/:id", async (c) => {
  await record(c.env, orgId(c), "call_campaigns", c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM call_campaigns WHERE id=? AND org_id=?")
    .bind(c.req.param("id"), orgId(c))
    .run();
  return c.json({ ok: true });
});
callFeatures.post("/calling/campaigns/:id/contacts", async (c) => {
  const r = await record(c.env, orgId(c), "call_campaigns", c.req.param("id")),
    b = await c.req.json<Row>();
  ensure(
    Array.isArray(b.people) && b.people.length <= 500,
    "Choose up to 500 people",
  );
  let added = 0;
  for (const pid of b.people) {
    const p = await record(c.env, orgId(c), "people", pid);
    if (p.dnc || !p.phone) continue;
    const changed = await c.env.DB.prepare(
      "INSERT OR IGNORE INTO call_contacts(id,org_id,campaign_id,person_id) VALUES(?,?,?,?)",
    )
      .bind(id(), orgId(c), r.id, p.id)
      .run();
    added += changed.meta.changes;
  }
  return c.json({ added });
});
callFeatures.patch("/calling/contacts/:id", async (c) => {
  const r = await record(c.env, orgId(c), "call_contacts", c.req.param("id")),
    b = await c.req.json<Row>();
  if (b.callStatus && b.callStatus !== r.call_status)
    await outcome(c.env, orgId(c), r.id, b.callStatus, b.followUpAt);
  await c.env.DB.prepare(
    "UPDATE call_contacts SET notes=?,follow_up_at=COALESCE(?,follow_up_at),stage=COALESCE(?,stage) WHERE id=? AND org_id=?",
  )
    .bind(
      b.notes === undefined ? r.notes : text(b.notes, 10000),
      b.followUpAt || null,
      ["to_call", "follow_up", "done"].includes(b.stage) ? b.stage : null,
      r.id,
      orgId(c),
    )
    .run();
  return c.json({ ok: true });
});
export async function transcribeCall(env: Env, org: string, callId: string) {
  const r = await record(env, org, "calls", callId);
  try {
    const object = await env.MEDIA.get(r.recording_key);
    ensure(object, "Recording not found");
    const settings = await pref<Row>(env, org, "ai", {}),
      openrouterConfig = await integration(env, org, "openrouter");
    let openrouter = openrouterConfig;
    const byok = await pref<Row>(env, org, "byok", {});
    if (byok.transcriptionModel) {
      const runtime = await strictAiRuntime(env, org, {
        model: byok.transcriptionModel.modelId,
        upstreamProvider: byok.transcriptionModel.provider,
      });
      if (runtime) {
        openrouter = { api_key: runtime.apiKey };
        settings.transcriptionModel = runtime.model;
        settings.provider = runtime.provider;
      }
    }
    let transcript: Row;
    if (settings.transcriptionModel && openrouter) {
      const prefix = JSON.stringify({
        model: settings.transcriptionModel,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: 'Transcribe this sales call in its original language. Infer rep/lead roles. Return JSON: {language,summary,utterances:[{startSeconds,speaker:"rep"|"lead",text}]}. Give a factual English summary and agreed next steps.',
              },
              {
                type: "input_audio",
                input_audio: {
                  format: r.content_type?.includes("ogg") ? "ogg" : "webm",
                  data: "__AUDIO_DATA__",
                },
              },
            ],
          },
        ],
        provider: {
          only: settings.provider ? [settings.provider] : undefined,
          order: settings.provider ? [settings.provider] : undefined,
          allow_fallbacks: false,
          require_parameters: true,
        },
        temperature: 0,
      }).split("__AUDIO_DATA__");
      const reader = object.body.getReader(),
        encoder = new TextEncoder();
      let carry = new Uint8Array(0);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(prefix[0]));
        },
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              if (carry.length)
                controller.enqueue(
                  encoder.encode(btoa(String.fromCharCode(...carry))),
                );
              controller.enqueue(encoder.encode(prefix[1]));
              controller.close();
              return;
            }
            const buffer = new Uint8Array(carry.length + value.length);
            buffer.set(carry);
            buffer.set(value, carry.length);
            const end = buffer.length - (buffer.length % 3);
            for (let i = 0; i < end; i += 32766)
              controller.enqueue(
                encoder.encode(
                  btoa(
                    String.fromCharCode(
                      ...buffer.subarray(i, Math.min(end, i + 32766)),
                    ),
                  ),
                ),
              );
            carry = buffer.slice(end);
          } catch (error) {
            controller.error(error);
          }
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      });
      const response = await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${openrouter.api_key}`,
            "Content-Type": "application/json",
          },
          body: stream,
          signal: AbortSignal.timeout(300000),
          duplex: "half",
        } as RequestInit,
      );
      ensure(response.ok, "Transcription provider rejected this recording");
      transcript = extractJson<Row>(modelText((await response.json()) as Row));
      transcript.model = settings.transcriptionModel;
    } else {
      ensure(
        object.size <= 10 * 1024 * 1024,
        "Choose an audio-capable OpenRouter transcription model for recordings larger than 10 MB",
      );
      const result = await (env.AI as any).run("@cf/openai/whisper", {
        audio: Array.from(new Uint8Array(await object.arrayBuffer())),
      });
      const summary = await generate(
        env,
        org,
        "Summarize this call using only the transcript. Return a concise summary and agreed next steps. Do not invent commitments.",
        String(result.text || ""),
      );
      transcript = {
        language: result.language || null,
        summary,
        utterances: [
          {
            startSeconds: 0,
            speaker: "unknown",
            text: String(result.text || ""),
          },
        ],
        model: "@cf/openai/whisper",
      };
    }
    if (Array.isArray(transcript.utterances))
      transcript.utterances = transcript.utterances
        .filter((u: Row) => typeof u.text === "string" && u.text.trim())
        .map((u: Row) => ({
          startSeconds: Math.max(0, Number(u.startSeconds) || 0),
          speaker: ["rep", "lead"].includes(u.speaker) ? u.speaker : "unknown",
          text: text(u.text, 50000),
        }));
    ensure(
      Array.isArray(transcript.utterances) && transcript.utterances.length > 0,
      "No usable transcript returned",
    );
    await env.DB.prepare(
      "UPDATE calls SET transcript_status='done',transcript=?,transcript_error=NULL WHERE id=? AND org_id=?",
    )
      .bind(JSON.stringify(transcript), r.id, org)
      .run();
  } catch (e) {
    await env.DB.prepare(
      "UPDATE calls SET transcript_status='failed',transcript_error=? WHERE id=? AND org_id=?",
    )
      .bind(text((e as Error).message, 500), r.id, org)
      .run();
    throw e;
  }
}
