import { enqueue } from "../jobs";
import { pref, savePref } from "./shared";
import type { Env, Row } from "../types";
import { fromB64, toB64, id, json, now, sign, text, escapeHtml } from "../core";
import { integration, requestJson, ProviderError } from "../providers";
import { receive } from "../inbound";
import { record } from "./shared";
const enc = new TextEncoder();
export const base64url = (input: Uint8Array | string) =>
  toB64(typeof input === "string" ? enc.encode(input) : input)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
export function decodeBase64url(value: string) {
  return fromB64(value.replaceAll("-", "+").replaceAll("_", "/"));
}
const tokenCache = new Map<string, { token: string; until: number }>();
export async function googleToken(
  env: Env,
  org: string,
  mailbox: string,
  providedConfig?: Row,
) {
  const config =
    providedConfig || (await integration(env, org, "google-workspace"));
  if (!config)
    throw new Error("Connect Google Workspace in channel settings first");
  const key =
    org +
    ":" +
    mailbox +
    ":" +
    config.client_email +
    ":" +
    String(config.private_key).slice(-48);
  const cached = tokenCache.get(key);
  if (cached && cached.until > Date.now()) return cached.token;
  const iat = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: config.client_email,
      sub: mailbox,
      scope:
        "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send",
      aud: "https://oauth2.googleapis.com/token",
      iat,
      exp: iat + 3600,
    }),
  );
  const raw = String(config.private_key)
    .replace(/\\n/g, "\n")
    .replace(/-----[^-]+-----/g, "")
    .replace(/\s/g, "");
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    fromB64(raw),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const assertion = `${header}.${claims}.${base64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, enc.encode(`${header}.${claims}`))))}`;
  const response = await requestJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.access_token)
    throw new Error("Google did not authorize this mailbox");
  if (tokenCache.size > 100) tokenCache.clear();
  tokenCache.set(key, {
    token: response.access_token,
    until: Date.now() + Number(response.expires_in || 3600) * 1000 - 60000,
  });
  return String(response.access_token);
}
export async function gmail(
  env: Env,
  org: string,
  address: string,
  path: string,
  method = "GET",
  body?: unknown,
  mutates = false,
) {
  return requestJson(
    `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(address)}/${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${await googleToken(env, org, address)}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    mutates,
  );
}
export function mailAddress(value: string) {
  const clean = value.replace(/[\r\n]/g, "");
  return /<([^>]+)>/.exec(clean)?.[1] || clean.trim();
}
export function parseGmailMessage(message: Row) {
  const headers = Object.fromEntries(
    (message.payload?.headers || []).map((h: Row) => [
      String(h.name).toLowerCase(),
      String(h.value),
    ]),
  );
  const parts: Row[] = [];
  function visit(p: Row) {
    if (p.body?.data) parts.push(p);
    for (const child of p.parts || []) visit(child);
  }
  visit(message.payload || {});
  let body = "";
  const part =
    parts.find((p) => p.mimeType === "text/plain") ||
    parts.find((p) => p.mimeType === "text/html");
  if (part) {
    body = new TextDecoder().decode(decodeBase64url(part.body.data));
    if (part.mimeType === "text/html")
      body = body
        .replace(
          /<style[^>]*>[\s\S]*?<\/style>|<script[^>]*>[\s\S]*?<\/script>/gi,
          "",
        )
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&");
  }
  return {
    external_id: String(message.id),
    thread_id: String(message.threadId || ""),
    email: mailAddress(String(headers.from || "")),
    to: mailAddress(String(headers.to || "")),
    subject: String(headers.subject || ""),
    body: body || String(message.snippet || ""),
    message_id: String(headers["message-id"] || ""),
    references: String(headers.references || ""),
    in_reply_to: String(headers["in-reply-to"] || ""),
    labels: message.labelIds || [],
    received_at: new Date(
      Number(message.internalDate) || Date.now(),
    ).toISOString(),
  };
}
export async function sendGmail(
  env: Env,
  org: string,
  person: Row,
  account: Row,
  subject: string,
  body: string,
  jobId: string,
) {
  const p = await env.DB.prepare(
    "SELECT thread_id,metadata FROM messages WHERE org_id=? AND person_id=? AND channel='email' AND account_id=? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(org, person.id, account.id)
    .first<Row>();
  const metadata = json<Row>(p?.metadata, {}),
    messageId = `<${jobId.replace(/[^a-zA-Z0-9-]/g, "-")}@${new URL(env.APP_URL).hostname}>`;
  const unsubscribe = `${env.APP_URL}/u/${org}/${person.id}?s=${await sign(`${org}:${person.id}`, env.UNSUBSCRIBE_SECRET)}`;
  let content = body;
  const signature = String(account.signature || "");
  content = content.includes("%signature%")
    ? content.replaceAll("%signature%", signature)
    : content + (signature ? `\n\n${signature}` : "");
  const safe = (v: string) => v.replace(/[\r\n]/g, "");
  const encoded = (v: string) => `=?UTF-8?B?${toB64(enc.encode(safe(v)))}?=`;
  const headers = [
    `From: ${account.name ? encoded(account.name) + " " : ""}<${safe(account.address)}>`,
    `To: ${safe(person.email)}`,
    `Subject: ${encoded(subject)}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    `List-Unsubscribe: <${unsubscribe}>`,
    "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
  ];
  if (metadata.message_id) {
    headers.push(
      `In-Reply-To: ${safe(metadata.message_id)}`,
      `References: ${safe(metadata.references || "")} ${safe(metadata.message_id)}`,
    );
  }
  const raw = base64url(
    headers.join("\r\n") +
      "\r\n\r\n" +
      toB64(enc.encode(content + "\n\nUnsubscribe: " + unsubscribe)),
  );
  const response = await gmail(
    env,
    org,
    account.address,
    "messages/send",
    "POST",
    { raw, ...(p?.thread_id ? { threadId: p.thread_id } : {}) },
    true,
  );
  if (!response.id)
    throw new ProviderError(
      "Gmail returned no receipt. Inspect the Sent folder before retrying.",
      true,
    );
  return {
    externalId: String(response.id),
    body: content,
    subject,
    threadId: String(response.threadId || ""),
    metadata: { message_id: messageId, mailbox: account.address },
  };
}
export async function syncGmail(env: Env, org: string, accountId: string) {
  const account = await record(env, org, "channel_accounts", accountId);
  if (account.status !== "connected" || account.channel !== "email") return;
  // A page is committed only after every message has persisted. On a retry the
  // receipt index deduplicates it. Never advance to profile.historyId mid-page.
  const stateKey = `gmail-sync:${account.id}`;
  let state = await pref<Row>(env, org, stateKey, {});
  if (!state.mode) {
    state = account.history_id
      ? { mode: "history", start: account.history_id }
      : {
          mode: "full",
          baseline: (await gmail(env, org, account.address, "profile"))
            .historyId,
        };
  }
  let listed: Row;
  try {
    listed = await gmail(
      env,
      org,
      account.address,
      state.mode === "history"
        ? `history?maxResults=50&startHistoryId=${encodeURIComponent(state.start)}&historyTypes=messageAdded${state.page ? "&pageToken=" + encodeURIComponent(state.page) : ""}`
        : `messages?maxResults=50&q=${encodeURIComponent("in:anywhere -in:spam -in:trash")}${state.page ? "&pageToken=" + encodeURIComponent(state.page) : ""}`,
    );
  } catch (error) {
    if (
      state.mode !== "history" ||
      !String((error as Error).message).includes("404")
    )
      throw error;
    await savePref(env, org, stateKey, {
      mode: "full",
      baseline: (await gmail(env, org, account.address, "profile")).historyId,
    });
    await enqueue(env, org, "gmail-sync", { account_id: account.id });
    return;
  }
  const ids = new Set<string>(
    state.mode === "history"
      ? (listed.history || [])
          .flatMap((h: Row) =>
            (h.messagesAdded || []).map((x: Row) =>
              String(x.message?.id || ""),
            ),
          )
          .filter(Boolean)
      : (listed.messages || []).map((x: Row) => String(x.id)),
  );
  for (const mid of ids) {
    let raw: Row;
    try {
      raw = await gmail(
        env,
        org,
        account.address,
        `messages/${encodeURIComponent(mid)}?format=full`,
      );
    } catch (error) {
      if (String((error as Error).message).includes("404")) continue;
      throw error;
    }
    const parsed = parseGmailMessage(raw);
    if (
      parsed.labels.includes("SENT") ||
      parsed.labels.includes("DRAFT") ||
      parsed.email.toLowerCase() === String(account.address).toLowerCase()
    )
      continue;
    const result = await receive(env, org, "email", {
      ...parsed,
      historyOnly: state.mode === "full",
    });
    if (result.ok || result.duplicate)
      await env.DB.prepare(
        "UPDATE messages SET account_id=?,thread_id=?,metadata=? WHERE org_id=? AND channel='email' AND external_id=?",
      )
        .bind(account.id, parsed.thread_id, JSON.stringify(parsed), org, mid)
        .run();
  }
  if (listed.nextPageToken) {
    await savePref(env, org, stateKey, {
      ...state,
      page: listed.nextPageToken,
    });
    await enqueue(env, org, "gmail-sync", { account_id: account.id });
  } else {
    await env.DB.prepare(
      "UPDATE channel_accounts SET history_id=?,last_sync_at=?,error='' WHERE id=? AND org_id=?",
    )
      .bind(
        String(
          state.mode === "full"
            ? state.baseline
            : listed.historyId || state.start,
        ),
        now(),
        account.id,
        org,
      )
      .run();
    await savePref(env, org, stateKey, {});
  }
}
export async function watchMailbox(env: Env, org: string, accountId: string) {
  const account = await record(env, org, "channel_accounts", accountId),
    config = await integration(env, org, "google-workspace");
  if (!config?.pubsub_topic) return;
  const watch = await gmail(env, org, account.address, "watch", "POST", {
    topicName: config.pubsub_topic,
    labelIds: ["INBOX"],
    labelFilterBehavior: "INCLUDE",
  });
  await env.DB.prepare(
    "UPDATE channel_accounts SET watch_expires_at=? WHERE id=? AND org_id=?",
  )
    .bind(new Date(Number(watch.expiration)).toISOString(), account.id, org)
    .run();
}
