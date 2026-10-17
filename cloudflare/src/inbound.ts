import { HTTPException } from "hono/http-exception";
import type { Env, Row } from "./types";
import { id, text } from "./core";
import { enqueue, event } from "./jobs";
export async function receive(
  env: Env,
  org: string,
  channel: string,
  body: Row,
) {
  const externalId = text(body.external_id || body.message_id || body.id, 300);
  if (!externalId)
    throw new HTTPException(400, {
      message: "A unique external_id is required",
    });
  if (body.is_sender === true || body.is_sender === 1) return { ignored: true };
  let person: Row | null = null;
  if (body.person_id)
    person = await env.DB.prepare(
      "SELECT * FROM people WHERE org_id=? AND id=?",
    )
      .bind(org, text(body.person_id, 100))
      .first<Row>();
  if (!person && body.email)
    person = await env.DB.prepare(
      "SELECT * FROM people WHERE org_id=? AND email=?",
    )
      .bind(org, text(body.email, 254).toLowerCase())
      .first<Row>();
  if (!person && body.phone)
    person = await env.DB.prepare(
      "SELECT * FROM people WHERE org_id=? AND REPLACE(REPLACE(REPLACE(phone,' ',''),'-',''),'+','')=?",
    )
      .bind(org, String(body.phone).replace(/\D/g, ""))
      .first<Row>();
  if (!person && body.sender?.attendee_provider_id) {
    const phone = String(body.sender.attendee_provider_id)
      .split("@")[0]
      .split(":")[0];
    person = await env.DB.prepare(
      "SELECT * FROM people WHERE org_id=? AND (REPLACE(REPLACE(REPLACE(phone,' ',''),'-',''),'+','')=? OR json_extract(custom,'$.linkedin_provider_id')=?)",
    )
      .bind(org, phone, body.sender.attendee_provider_id)
      .first<Row>();
  }
  if (!person) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO identity_exceptions(id,org_id,channel,external_id,payload) VALUES(?,?,?,?,?)",
    )
      .bind(id(), org, channel, externalId, JSON.stringify(body))
      .run();
    return {
      ignored: true,
      reason: "No matching lead",
      needsIdentityReview: true,
    };
  }
  const message = text(body.body || body.message || body.text, 10000);
  if (!message) return { ignored: true, reason: "No message content" };
  const mid = id();
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO webhook_receipts(org_id,external_id) VALUES(?,?)",
  )
    .bind(org, `${channel}:${externalId}`)
    .run();
  if (!result.meta.changes) return { duplicate: true };
  try {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE people SET crm_context=crm_context+1 WHERE org_id=? AND id=? AND ?=0",
      ).bind(org, person.id, body.historyOnly ? 1 : 0),
      env.DB.prepare(
        "INSERT INTO messages(id,org_id,person_id,channel,direction,subject,body,status,external_id) VALUES(?,?,?,?,'inbound',?,?,'received',?)",
      ).bind(
        mid,
        org,
        person.id,
        channel,
        text(body.subject, 300),
        message,
        externalId,
      ),
      env.DB.prepare(
        "UPDATE drafts SET status='discarded' WHERE org_id=? AND id IN (SELECT draft_id FROM crm_enrollments WHERE org_id=? AND person_id=? AND status='active') AND status='pending' AND ?=0",
      ).bind(org, org, person.id, body.historyOnly ? 1 : 0),
      env.DB.prepare(
        "UPDATE crm_enrollments SET status='stopped',draft_id=NULL WHERE org_id=? AND person_id=? AND status='active' AND ?=0",
      ).bind(org, person.id, body.historyOnly ? 1 : 0),
      env.DB.prepare(
        "UPDATE enrollments SET status='replied' WHERE org_id=? AND person_id=? AND status='active' AND ?=0",
      ).bind(org, person.id, body.historyOnly ? 1 : 0),
    ]);
  } catch (e) {
    await env.DB.prepare(
      "DELETE FROM webhook_receipts WHERE org_id=? AND external_id=?",
    )
      .bind(org, `${channel}:${externalId}`)
      .run();
    throw e;
  }
  if (body.crmEligible !== false && !body.historyOnly)
    await enqueue(env, org, "crm", { person_id: person.id, message_id: mid });
  await event(
    env,
    org,
    "message.received",
    `Reply received via ${channel}`,
    person.id,
  );
  return { ok: true };
}
