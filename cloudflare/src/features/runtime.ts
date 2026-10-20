import { Hono } from "hono";
import type { AppEnv, Env, Row } from "../types";
import { now, json } from "../core";
import { requireUser } from "../auth";
import { enqueue } from "../jobs";
import { identityFeatures, publicIdentity } from "./identity";
import {
  channelFeatures,
  publicChannels,
  processWebhook,
  syncChats,
  syncChatHistory,
  searchLinkedIn,
} from "./channels";
import { callFeatures, recorderRoutes, transcribeCall } from "./calls";
import { tableFeatures, executeTableRow } from "./tables";
import { crmFeatures, crmSequenceTick, createSequenceDraft } from "./crm";
import { workflowFeatures, qualifyProspect } from "./workflows";
import { syncGmail, watchMailbox } from "./google";
import { completeness } from "./completeness";
import { aiFeatures } from "./ai";
export const publicFeatures = new Hono<AppEnv>()
  .route("/", publicIdentity)
  .route("/", publicChannels)
  .route("/", recorderRoutes);
export const featureRoutes = new Hono<AppEnv>();
featureRoutes.use("*", requireUser);
featureRoutes
  .route("/", identityFeatures)
  .route("/", channelFeatures)
  .route("/", callFeatures)
  .route("/", tableFeatures)
  .route("/", crmFeatures)
  .route("/", workflowFeatures)
  .route("/", completeness)
  .route("/", aiFeatures);
export async function featureJob(env: Env, job: Row, payload: Row) {
  switch (job.kind) {
    case "crm-sequence":
      await createSequenceDraft(env, job.org_id, payload.enrollment_id);
      return true;
    case "gmail-sync":
      await syncGmail(env, job.org_id, payload.account_id);
      return true;
    case "mailbox-watch":
      await watchMailbox(env, job.org_id, payload.account_id);
      return true;
    case "chat-history":
      await syncChatHistory(env, job.org_id, payload);
      return true;
    case "chat-sync":
      await syncChats(env, job.org_id, payload.account_id, payload.cursor);
      return true;
    case "linkedin-search":
      await searchLinkedIn(env, job.org_id, payload.query_id);
      return true;
    case "channel-webhook":
      try {
        await processWebhook(env, job.org_id, payload.webhook_id);
      } catch (error) {
        await env.DB.prepare(
          "UPDATE webhook_events SET status='failed',error=? WHERE id=? AND org_id=?",
        )
          .bind(
            String((error as Error).message).slice(0, 500),
            payload.webhook_id,
            job.org_id,
          )
          .run();
        throw error;
      }
      return true;
    case "table-row":
      await executeTableRow(env, job, payload);
      return true;
    case "call-transcribe":
      await transcribeCall(env, job.org_id, payload.call_id);
      return true;
    case "prospect":
      await qualifyProspect(env, job.org_id, payload.prospect_id);
      return true;
    default:
      return false;
  }
}
export async function featureTick(env: Env) {
  const slot = Math.floor(Date.now() / 300000);
  const mailboxes = await env.DB.prepare(
    "SELECT id,org_id,watch_expires_at FROM channel_accounts WHERE channel='email' AND status='connected' AND json_extract(settings,'$.provider')='gmail' LIMIT 200",
  ).all<Row>();
  for (const a of mailboxes.results) {
    await enqueue(
      env,
      a.org_id,
      "gmail-sync",
      { account_id: a.id },
      `gmail-poll:${a.id}:${slot}`,
    );
    if (
      !a.watch_expires_at ||
      a.watch_expires_at < new Date(Date.now() + 86400000).toISOString()
    )
      await enqueue(
        env,
        a.org_id,
        "mailbox-watch",
        { account_id: a.id },
        `gmail-watch:${a.id}:${Math.floor(Date.now() / 86400000)}`,
      );
  }
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE channel_accounts SET status='connected',error='' WHERE status='limit_reached' AND next_send_at<=?",
    ).bind(now()),
    env.DB.prepare(
      "UPDATE calls SET status='no_recording',error='Call recorder did not connect' WHERE status='pending' AND created_at<?",
    ).bind(new Date(Date.now() - 5 * 60000).toISOString()),
    env.DB.prepare(
      "UPDATE calls SET status='failed',error='Call recorder session expired' WHERE status='in_progress' AND token_expires_at<?",
    ).bind(now()),
    env.DB.prepare("DELETE FROM auth_tokens WHERE expires_at<?").bind(
      new Date(Date.now() - 86400000).toISOString(),
    ),
  ]);
  await crmSequenceTick(env);
}
