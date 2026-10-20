import { Hono } from "hono";
import type { AppEnv, Env, Row } from "../types";
import {
  decrypt,
  encrypt,
  id,
  json,
  now,
  text,
  token,
  emailValid,
  constantEqual,
  render,
} from "../core";
import { requireAdmin } from "../auth";
import {
  integration,
  ProviderError,
  requestJson,
  unipileBase,
} from "../providers";
import { enqueue } from "../jobs";
import { receive } from "../inbound";
import {
  CHANNEL_RULES,
  resolveValues,
  validateValues,
  isChannel,
  pickInRange,
  type Channel,
  ruleWarning,
} from "../ported/channels/rules";
import { ensure, orgId, pref, savePref, record, batches } from "./shared";
import { gmail, syncGmail, watchMailbox } from "./google";
export const channelFeatures = new Hono<AppEnv>(),
  publicChannels = new Hono<AppEnv>();
export class PacingWait extends Error {
  constructor(
    message: string,
    public waitSeconds = 60,
  ) {
    super(message);
  }
}
export async function selectAccount(
  env: Env,
  org: string,
  campaign: Row,
  enrollment: Row | null,
  person: Row,
  action: string,
) {
  if (
    campaign.channel === "email" &&
    campaign.provider !== "gmail" &&
    !enrollment?.account_id
  )
    return null;
  let account: Row | null = null;
  if (enrollment?.account_id)
    account = await record(env, org, "channel_accounts", enrollment.account_id);
  else if (campaign.account_id)
    account = await env.DB.prepare(
      "SELECT * FROM channel_accounts WHERE org_id=? AND (id=? OR external_id=?)",
    )
      .bind(org, campaign.account_id, campaign.account_id)
      .first<Row>();
  else {
    const rows = await env.DB.prepare(
      "SELECT a.* FROM channel_accounts a WHERE a.org_id=? AND a.channel=? AND a.status='connected' AND (NOT EXISTS(SELECT 1 FROM campaign_accounts ca WHERE ca.campaign_id=?) OR EXISTS(SELECT 1 FROM campaign_accounts ca WHERE ca.campaign_id=? AND ca.account_id=a.id)) ORDER BY a.is_default DESC,a.next_send_at,a.rowid",
    )
      .bind(org, campaign.channel, campaign.id || "", campaign.id || "")
      .all<Row>();
    account =
      rows.results.find((a) => !a.next_send_at || a.next_send_at <= now()) ||
      rows.results[0] ||
      null;
  }
  if (!account) {
    if (campaign.account_id || enrollment?.account_id)
      throw new PacingWait(
        "Account does not belong to this workspace or is disconnected",
        300,
      );
    if (campaign.provider === "gmail")
      throw new PacingWait("No connected Google mailbox is available", 300);
    return null;
  }
  if (account.channel !== campaign.channel)
    throw new PacingWait("Account channel does not match", 300);
  if (account.status !== "connected")
    throw new PacingWait("Account is not connected", 300);
  const settings = json<Row>(account.settings, {}),
    cfg = await rules(env, org, account.channel as Channel);
  if (
    !withinHours(
      settings.hours ||
        (account.channel === "whatsapp"
          ? (cfg as Row).sendingHours
          : account.channel === "linkedin"
            ? (cfg as Row).workingHours
            : null),
    )
  )
    throw new PacingWait("Outside account working hours", 300);
  if (account.next_send_at && account.next_send_at > now())
    throw new PacingWait(
      "Account is pacing sends",
      Math.ceil((Date.parse(account.next_send_at) - Date.now()) / 1000),
    );
  if (enrollment && account.channel === "whatsapp") {
    const existing = await env.DB.prepare(
      "SELECT id FROM messages WHERE org_id=? AND person_id=? AND account_id=? LIMIT 1",
    )
      .bind(org, person.id, account.id)
      .first();
    if (
      !existing &&
      Date.now() - Date.parse(account.first_connected_at) <
        Number((cfg as Row).warmupHours) * 3600000
    )
      throw new PacingWait("WhatsApp number is warming up", 300);
  }
  return account;
}
export async function reserveAccount(
  env: Env,
  org: string,
  account: Row,
  person: Row,
  action: string,
) {
  const cfg = await rules(env, org, account.channel as Channel),
    general = await rules(env, org, "general");
  const dayStart = String(general.dayStartsAt || "00:00")
    .split(":")
    .map(Number);
  const shifted = new Date(
    Date.now() - (dayStart[0] * 60 + dayStart[1]) * 60000,
  );
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: general.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(shifted);
  const newChat =
    account.channel === "whatsapp" &&
    !(await env.DB.prepare(
      "SELECT 1 FROM messages WHERE org_id=? AND person_id=? AND account_id=? LIMIT 1",
    )
      .bind(org, person.id, account.id)
      .first());
  const counted =
    account.channel === "email" ||
    (account.channel === "linkedin" && action === "invite") ||
    newChat;
  const cap = Number(
    account.daily_limit ??
      (account.channel === "email"
        ? (cfg as Row).dailySendLimit
        : account.channel === "whatsapp"
          ? (cfg as Row).newChatsPerDay
          : account.premium
            ? (cfg as Row).invitesPerDayPremium
            : (cfg as Row).invitesPerDayFree),
  );
  const key = `account:${account.id}:${account.channel === "linkedin" ? action : newChat ? "new" : "message"}`;
  if (counted) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO daily_usage(org_id,day,channel,count) VALUES(?,?,?,0)",
    )
      .bind(org, day, key)
      .run();
    const row = await env.DB.prepare(
      "UPDATE daily_usage SET count=count+1 WHERE org_id=? AND day=? AND channel=? AND count<? RETURNING count",
    )
      .bind(org, day, key, cap)
      .first();
    if (!row) throw new PacingWait("Account daily limit reached", 900);
  }
  const settings = json<Row>(account.settings, {});
  let seconds =
    account.channel === "email"
      ? pickInRange((cfg as Row).sendGapMinutes) * 60
      : account.channel === "whatsapp"
        ? Number((cfg as Row).secondsBetweenSends)
        : pickInRange((cfg as Row).inviteDelaySeconds || [30, 60]);
  if (account.channel === "linkedin") {
    const remaining =
      Number(settings[`run_remaining_${action}`]) ||
      pickInRange(
        (cfg as Row)[
          action === "invite" ? "invitesPerRun" : "followUpsPerRun"
        ] || [3, 4],
      );
    settings[`run_remaining_${action}`] = remaining - 1;
    if (settings[`run_remaining_${action}`] <= 0)
      seconds = pickInRange((cfg as Row).runGapMinutes || [30, 60]) * 60;
  }
  const claim = id(),
    until = new Date(Date.now() + seconds * 1000).toISOString();
  const changed = await env.DB.prepare(
    "UPDATE channel_accounts SET next_send_at=?,settings=?,send_lock=? WHERE org_id=? AND id=? AND status='connected' AND (next_send_at IS NULL OR next_send_at<=?) RETURNING id",
  )
    .bind(until, JSON.stringify(settings), claim, org, account.id, now())
    .first();
  const release = async () => {
    if (counted)
      await env.DB.prepare(
        "UPDATE daily_usage SET count=MAX(0,count-1) WHERE org_id=? AND day=? AND channel=?",
      )
        .bind(org, day, key)
        .run();
    await env.DB.prepare(
      "UPDATE channel_accounts SET next_send_at=NULL,send_lock=NULL WHERE org_id=? AND id=? AND send_lock=?",
    )
      .bind(org, account.id, claim)
      .run();
  };
  if (!changed) {
    await release();
    throw new PacingWait("Another message is using this account", 30);
  }
  return { release, newChat };
}
export async function rules(env: Env, org: string, channel: Channel) {
  return resolveValues(channel, await pref(env, org, `rules:${channel}`, {}));
}
export function withinHours(hours: Row | null | undefined, date = new Date()) {
  if (!hours) return true;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: hours.timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
      parts.weekday,
    ),
    minute = Number(parts.hour) * 60 + Number(parts.minute),
    asMin = (s: string) =>
      Number(s.split(":")[0]) * 60 + Number(s.split(":")[1]);
  const start = asMin(hours.start),
    end = asMin(hours.end);
  if (end > start)
    return hours.days.includes(day) && minute >= start && minute < end;
  return (
    (hours.days.includes(day) && minute >= start) ||
    (hours.days.includes((day + 6) % 7) && minute < end)
  );
}
async function requireUnipile(env: Env, org: string) {
  const cfg = await integration(env, org, "unipile");
  ensure(
    cfg && cfg.api_key && cfg.base_url,
    "请先在「渠道账号 → 配置渠道服务」填写 Unipile 服务地址和 API Key，再连接 LinkedIn、WhatsApp 或注册消息通知。",
  );
  return cfg;
}
export async function unipile(
  env: Env,
  org: string,
  path: string,
  method = "GET",
  body?: unknown,
) {
  const cfg = await requireUnipile(env, org);
  try {
    return await requestJson(
      `${unipileBase(cfg)}/api/v1/${path}`,
      {
        method,
        headers: {
          "X-API-KEY": cfg.api_key,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      !["GET", "HEAD"].includes(method),
    );
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    const message =
      error.status === 401 || error.status === 403
        ? `Unipile 连接验证失败（HTTP ${error.status}）。请检查服务地址、API Key 和账号权限。`
        : error.status === 429
          ? "Unipile 请求过于频繁（HTTP 429），请稍后重试。"
          : error.status
            ? `Unipile 暂时无法完成请求（HTTP ${error.status}），请检查服务后台。`
            : "暂时无法连接 Unipile，请检查服务地址和服务状态。";
    throw new ProviderError(
      message +
        (error.uncertain ? " 请先查看服务后台的执行记录，再重试。" : ""),
      error.uncertain,
      error.status,
    );
  }
}
channelFeatures.get("/channel-rules/:channel", async (c) => {
  const channel = c.req.param("channel");
  ensure(isChannel(channel), "Unknown channel");
  const value = await rules(c.env, orgId(c), channel);
  return c.json({
    values: value,
    definitions: CHANNEL_RULES[channel],
    warnings: CHANNEL_RULES[channel]
      .map((r) => ruleWarning(r, (value as Row)[r.key]))
      .filter(Boolean),
  });
});
channelFeatures.put("/channel-rules/:channel", async (c) => {
  requireAdmin(c);
  const channel = c.req.param("channel");
  ensure(isChannel(channel), "Unknown channel");
  const result = validateValues(channel, await c.req.json<Row>());
  ensure(result.ok, result.ok ? "" : result.error);
  await savePref(c.env, orgId(c), `rules:${channel}`, result.values);
  return c.json({ ok: true });
});
channelFeatures.get("/accounts", async (c) => {
  const [items, providers] = await c.env.DB.batch<Row>([
    c.env.DB.prepare(
      "SELECT * FROM channel_accounts WHERE org_id=? ORDER BY channel,is_default DESC,name",
    ).bind(orgId(c)),
    c.env.DB.prepare(
      "SELECT kind FROM integrations WHERE org_id=? AND kind IN ('unipile','google-workspace')",
    ).bind(orgId(c)),
  ]);
  for (const a of items.results) a.settings = json(a.settings, {});
  return c.json({
    items: items.results,
    connections: {
      unipile: providers.results.some((r) => r.kind === "unipile"),
      google_workspace: providers.results.some(
        (r) => r.kind === "google-workspace",
      ),
    },
  });
});
channelFeatures.post("/mailboxes", async (c) => {
  requireAdmin(c);
  const b = await c.req.json<Row>(),
    email = text(b.email, 254).toLowerCase();
  ensure(emailValid(email), "Use a valid mailbox address");
  const profile = await gmail(c.env, orgId(c), email, "profile");
  ensure(
    String(profile.emailAddress).toLowerCase() === email,
    "Mailbox identity mismatch",
  );
  const r = await rules(c.env, orgId(c), "email"),
    aid = id();
  await c.env.DB.prepare(
    "INSERT INTO channel_accounts(id,org_id,channel,address,name,signature,daily_limit,settings,history_id) VALUES(?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      aid,
      orgId(c),
      "email",
      email,
      text(b.name, 100),
      text(b.signature, 5000),
      r.dailySendLimit,
      JSON.stringify({ provider: "gmail", hours: r.sendingHours }),
      String(profile.historyId || ""),
    )
    .run();
  await watchMailbox(c.env, orgId(c), aid);
  return c.json({ id: aid }, 201);
});
channelFeatures.post("/accounts/sync", async (c) => {
  requireAdmin(c);
  return c.json(await syncAccounts(c.env, orgId(c)));
});
export async function syncAccounts(env: Env, org: string) {
  const result = await unipile(env, org, "accounts?limit=250");
  let count = 0;
  for (const remote of result.items || []) {
    const channel =
      remote.type === "WHATSAPP"
        ? "whatsapp"
        : remote.type === "LINKEDIN"
          ? "linkedin"
          : null;
    if (!channel) continue;
    const settings =
      remote.connection_params?.im || remote.connection_params?.linkedin || {};
    const premium = !!(
      settings.premium ||
      settings.sales_navigator ||
      remote.premium
    );
    const cfg = await rules(env, org, channel);
    const limit =
      channel === "whatsapp"
        ? cfg.newChatsPerDay
        : premium
          ? cfg.invitesPerDayPremium
          : cfg.invitesPerDayFree;
    const status = (remote.sources || []).some((s: Row) =>
      ["OK", "CONNECTED", "ok"].includes(s.status),
    )
      ? "connected"
      : "disconnected";
    const existing = await env.DB.prepare(
      "SELECT org_id FROM channel_accounts WHERE channel=? AND external_id=?",
    )
      .bind(channel, String(remote.id))
      .first<Row>();
    ensure(
      !existing || existing.org_id === org,
      "This provider account belongs to another workspace",
    );
    await env.DB.prepare(
      "INSERT INTO channel_accounts(id,org_id,channel,external_id,name,status,premium,daily_limit,settings) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(channel,external_id) DO UPDATE SET name=excluded.name,status=excluded.status,premium=excluded.premium,error=''",
    )
      .bind(
        id(),
        org,
        channel,
        String(remote.id),
        text(remote.name || settings.username || remote.id, 200),
        status,
        premium ? 1 : 0,
        Number(limit) || 25,
        JSON.stringify({ remote, provider: "unipile" }),
      )
      .run();
    count++;
  }
  return { synced: count };
}
channelFeatures.patch("/accounts/:id", async (c) => {
  requireAdmin(c);
  const a = await record(
      c.env,
      orgId(c),
      "channel_accounts",
      c.req.param("id"),
    ),
    b = await c.req.json<Row>();
  if (b.daily_limit !== undefined)
    ensure(
      Number.isInteger(b.daily_limit) &&
        b.daily_limit >= 1 &&
        b.daily_limit <=
          (a.channel === "email"
            ? 200
            : a.channel === "whatsapp"
              ? 200
              : a.premium
                ? 100
                : 50),
      "Daily limit is outside this account type bounds",
    );
  const settings = { ...json<Row>(a.settings, {}), ...(b.settings || {}) };
  if (settings.hours) {
    ensure(
      Array.isArray(settings.hours.days) &&
        settings.hours.days.every(
          (x: any) => Number.isInteger(x) && x >= 0 && x <= 6,
        ) &&
        /^\d\d:\d\d$/.test(settings.hours.start) &&
        /^\d\d:\d\d$/.test(settings.hours.end),
      "Invalid account hours",
    );
    try {
      withinHours(settings.hours);
    } catch {
      ensure(false, "Invalid timezone");
    }
  }
  const changes = [
    c.env.DB.prepare(
      "UPDATE channel_accounts SET name=?,signature=?,daily_limit=?,settings=?,status=?,is_default=? WHERE id=? AND org_id=?",
    ).bind(
      b.name === undefined ? a.name : text(b.name, 100),
      b.signature === undefined ? a.signature : text(b.signature, 5000),
      b.daily_limit ?? a.daily_limit,
      JSON.stringify(settings),
      ["connected", "disabled", "disconnected"].includes(b.status)
        ? b.status
        : a.status,
      b.is_default === undefined ? a.is_default : b.is_default ? 1 : 0,
      a.id,
      orgId(c),
    ),
  ];
  if (b.is_default)
    changes.unshift(
      c.env.DB.prepare(
        "UPDATE channel_accounts SET is_default=0 WHERE org_id=? AND channel=?",
      ).bind(orgId(c), a.channel),
    );
  await c.env.DB.batch(changes);
  return c.json({ ok: true });
});
channelFeatures.delete("/accounts/:id", async (c) => {
  requireAdmin(c);
  await record(c.env, orgId(c), "channel_accounts", c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM channel_accounts WHERE org_id=? AND id=?")
    .bind(orgId(c), c.req.param("id"))
    .run();
  return c.json({ ok: true });
});
channelFeatures.post("/accounts/:id/test", async (c) => {
  requireAdmin(c);
  const a = await record(
    c.env,
    orgId(c),
    "channel_accounts",
    c.req.param("id"),
  );
  try {
    if (a.channel === "email")
      await gmail(c.env, orgId(c), a.address, "profile");
    else
      await unipile(
        c.env,
        orgId(c),
        `accounts/${encodeURIComponent(a.external_id)}`,
      );
    await c.env.DB.prepare(
      "UPDATE channel_accounts SET status='connected',error='' WHERE id=? AND org_id=?",
    )
      .bind(a.id, orgId(c))
      .run();
    return c.json({ ok: true });
  } catch {
    await c.env.DB.prepare(
      "UPDATE channel_accounts SET status='disconnected',error='Connection test failed' WHERE id=? AND org_id=?",
    )
      .bind(a.id, orgId(c))
      .run();
    ensure(false, "Connection test failed");
  }
});
channelFeatures.post("/accounts/:id/sync", async (c) => {
  requireAdmin(c);
  const a = await record(
    c.env,
    orgId(c),
    "channel_accounts",
    c.req.param("id"),
  );
  const job = await enqueue(
    c.env,
    orgId(c),
    a.channel === "email" ? "gmail-sync" : "chat-sync",
    { account_id: a.id },
  );
  return c.json({ job }, 202);
});
channelFeatures.post("/accounts/hosted-auth", async (c) => {
  requireAdmin(c);
  const b = await c.req.json<Row>();
  ensure(
    ["linkedin", "whatsapp"].includes(b.channel),
    "请选择 LinkedIn 或 WhatsApp。",
  );
  const cfg = await requireUnipile(c.env, orgId(c));
  if (b.account_id) {
    const account = await record(
      c.env,
      orgId(c),
      "channel_accounts",
      b.account_id,
    );
    ensure(account.channel === b.channel, "重连账号与所选渠道不一致。");
  }
  const result = await unipile(
    c.env,
    orgId(c),
    "hosted/accounts/link",
    "POST",
    {
      type: b.account_id ? "reconnect" : "create",
      providers: [b.channel === "whatsapp" ? "WHATSAPP" : "LINKEDIN"],
      api_url: unipileBase(cfg),
      expiresOn: new Date(Date.now() + 30 * 60000).toISOString(),
      success_redirect_url: `${c.env.APP_URL}/channels?connected=1`,
      failure_redirect_url: `${c.env.APP_URL}/channels?connected=0`,
      ...(b.account_id
        ? {
            reconnect_account: (
              await record(c.env, orgId(c), "channel_accounts", b.account_id)
            ).external_id,
          }
        : {}),
    },
  );
  let hostedUrl: URL;
  try {
    hostedUrl = new URL(String(result.url || ""));
  } catch {
    ensure(false, "Unipile 没有返回有效的授权链接，请检查渠道服务配置。");
  }
  ensure(
    hostedUrl.protocol === "https:" &&
      !hostedUrl.username &&
      !hostedUrl.password &&
      hostedUrl.hostname.endsWith(".unipile.com"),
    "Unipile 返回的授权链接无效，请检查渠道服务配置。",
  );
  return c.json({ url: result.url });
});
channelFeatures.post("/channel-webhooks/register", async (c) => {
  requireAdmin(c);
  await requireUnipile(c.env, orgId(c));
  const existing = await unipile(c.env, orgId(c), "webhooks");
  let cfg = await integration(c.env, orgId(c), "webhook");
  if (!cfg) {
    cfg = { secret: token() };
    await c.env.DB.prepare(
      "INSERT INTO integrations(org_id,kind,encrypted,label) VALUES(?,?,?,?)",
    )
      .bind(
        orgId(c),
        "webhook",
        await encrypt(cfg, c.env.ENCRYPTION_KEY),
        "Webhook",
      )
      .run();
  }
  for (const source of ["messaging", "users", "account_status"]) {
    const url = `${c.env.APP_URL}/api/channel-webhooks/${orgId(c)}/${source}`;
    if (!(existing.items || []).some((x: Row) => x.request_url === url))
      await unipile(c.env, orgId(c), "webhooks", "POST", {
        request_url: url,
        source,
        name: `AgentSDR ${source}`,
        headers: [{ key: "X-Webhook-Secret", value: cfg.secret }],
      });
  }
  return c.json({ ok: true });
});
export async function acceptConnection(env: Env, org: string, payload: Row) {
  const external = String(payload.account_id || ""),
    provider = String(
      payload.user_provider_id ||
        payload.user_id ||
        payload.provider_id ||
        payload.user?.provider_id ||
        "",
    );
  const a = await env.DB.prepare(
    "SELECT * FROM channel_accounts WHERE org_id=? AND channel='linkedin' AND external_id=?",
  )
    .bind(org, external)
    .first<Row>();
  if (!a || !provider) return;
  const p = await env.DB.prepare(
    "SELECT * FROM people WHERE org_id=? AND json_extract(custom,'$.linkedin_provider_id')=?",
  )
    .bind(org, provider)
    .first<Row>();
  await env.DB.prepare(
    "INSERT INTO connections(id,org_id,account_id,person_id,provider_id,name,accepted_at,metadata) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(org_id,account_id,provider_id) DO UPDATE SET accepted_at=excluded.accepted_at,metadata=excluded.metadata",
  )
    .bind(
      id(),
      org,
      a.id,
      p?.id || null,
      provider,
      text(payload.name || p?.name, 200),
      now(),
      JSON.stringify(payload),
    )
    .run();
  if (p) {
    await env.DB.prepare(
      "UPDATE enrollments SET gate='',accepted_at=?,next_run=? WHERE org_id=? AND person_id=? AND gate='acceptance' AND account_id=?",
    )
      .bind(now(), now(), org, p.id, a.id)
      .run();
    await env.DB.prepare(
      "UPDATE jobs SET available_at=? WHERE org_id=? AND status='pending' AND json_extract(payload,'$.person_id')=?",
    )
      .bind(now(), org, p.id)
      .run();
  }
}
export async function importChat(
  env: Env,
  org: string,
  a: Row,
  remote: Row,
  historyOnly = false,
) {
  if (remote.event && remote.event !== "message_received") return;
  const cid = String(remote.chat_id || remote.id || "");
  if (!cid) return;
  const sender = String(
      remote.sender?.attendee_provider_id ||
        remote.attendee_provider_id ||
        remote.sender_id ||
        "",
    ),
    self = String(remote.account_info?.user_id || ""),
    isSender =
      remote.is_sender === true ||
      remote.is_sender === 1 ||
      (!!self && sender === self),
    peers = (Array.isArray(remote.attendees) ? remote.attendees : []).filter(
      (p: Row) => p.attendee_provider_id && p.attendee_provider_id !== self,
    ),
    provider = isSender
      ? peers.length === 1
        ? String(peers[0].attendee_provider_id)
        : ""
      : sender,
    group =
      remote.is_group === true || remote.is_group === 1 || peers.length > 1,
    phoneDigits =
      a.channel === "whatsapp"
        ? provider.split("@")[0].split(":")[0].replace(/^\+/, "")
        : "";
  const existing = await env.DB.prepare(
    "SELECT person_id FROM chats WHERE org_id=? AND account_id=? AND external_id=?",
  )
    .bind(org, a.id, cid)
    .first<Row>();
  let person =
    existing?.person_id && !group && (isSender || !provider)
      ? await env.DB.prepare("SELECT * FROM people WHERE org_id=? AND id=?")
          .bind(org, existing.person_id)
          .first<Row>()
      : null;
  if (!person && provider) {
    if (a.channel === "linkedin")
      person = await env.DB.prepare(
        "SELECT * FROM people WHERE org_id=? AND json_extract(custom,'$.linkedin_provider_id')=?",
      )
        .bind(org, provider)
        .first<Row>();
    else if (/^\d+$/.test(phoneDigits))
      person = await env.DB.prepare(
        "SELECT * FROM people WHERE org_id=? AND REPLACE(REPLACE(REPLACE(phone,' ',''),'-',''),'+','')=?",
      )
        .bind(org, phoneDigits)
        .first<Row>();
  }
  if (
    !person &&
    provider &&
    (a.channel === "linkedin" || /^\d+$/.test(phoneDigits))
  ) {
    const pid = id(),
      phone = a.channel === "whatsapp" ? "+" + phoneDigits : "";
    await env.DB.prepare(
      "INSERT INTO people(id,org_id,name,phone,custom) VALUES(?,?,?,?,?)",
    )
      .bind(
        pid,
        org,
        text(
          (isSender ? peers[0]?.attendee_name : remote.sender?.attendee_name) ||
            remote.name ||
            phone ||
            "LinkedIn contact",
          200,
        ),
        phone,
        JSON.stringify({
          source: "incoming",
          linkedin_provider_id: a.channel === "linkedin" ? provider : null,
        }),
      )
      .run();
    person = await record(env, org, "people", pid);
  }
  await env.DB.prepare(
    "INSERT INTO chats(id,org_id,account_id,external_id,person_id,name,metadata) VALUES(?,?,?,?,?,?,?) ON CONFLICT(org_id,account_id,external_id) DO UPDATE SET person_id=COALESCE(chats.person_id,excluded.person_id),metadata=excluded.metadata",
  )
    .bind(
      id(),
      org,
      a.id,
      cid,
      person?.id || null,
      text(remote.name || person?.name, 200),
      JSON.stringify(remote),
    )
    .run();
  if (
    person &&
    (remote.message || remote.text) &&
    (remote.message_id || remote.id)
  ) {
    if (isSender) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO messages(id,org_id,person_id,channel,direction,body,status,external_id,account_id,thread_id,metadata) VALUES(?,?,?,?,'outbound',?,'sent',?,?,?,?)",
      )
        .bind(
          id(),
          org,
          person.id,
          a.channel,
          text(remote.message || remote.text),
          String(remote.message_id || remote.id),
          a.id,
          cid,
          JSON.stringify({ source: "phone" }),
        )
        .run();
    } else {
      await receive(env, org, a.channel, {
        ...remote,
        person_id: person.id,
        external_id: remote.message_id || remote.id,
        historyOnly: historyOnly || group,
        crmEligible:
          !historyOnly &&
          !group &&
          !!(await env.DB.prepare(
            "SELECT id FROM enrollments WHERE org_id=? AND person_id=? LIMIT 1",
          )
            .bind(org, person.id)
            .first()),
      });
      await env.DB.prepare(
        "UPDATE messages SET account_id=?,thread_id=? WHERE org_id=? AND channel=? AND external_id=?",
      )
        .bind(a.id, cid, org, a.channel, String(remote.message_id || remote.id))
        .run();
    }
  }
}
export async function syncChats(
  env: Env,
  org: string,
  accountId: string,
  cursor?: string,
) {
  const a = await record(env, org, "channel_accounts", accountId);
  const listed = await unipile(
    env,
    org,
    `chats?account_id=${encodeURIComponent(a.external_id)}&limit=50${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
  );
  for (const chat of listed.items || []) {
    await importChat(env, org, a, chat, true);
    await enqueue(env, org, "chat-history", {
      account_id: a.id,
      chat_id: chat.id,
    });
  }
  if (listed.cursor)
    await enqueue(env, org, "chat-sync", {
      account_id: a.id,
      cursor: listed.cursor,
    });
  await env.DB.prepare(
    "UPDATE channel_accounts SET last_sync_at=? WHERE id=? AND org_id=?",
  )
    .bind(now(), a.id, org)
    .run();
}
export async function syncChatHistory(env: Env, org: string, payload: Row) {
  const a = await record(env, org, "channel_accounts", payload.account_id);
  const page = await unipile(
    env,
    org,
    `chats/${encodeURIComponent(payload.chat_id)}/messages?limit=50${payload.cursor ? "&cursor=" + encodeURIComponent(payload.cursor) : ""}`,
  );
  for (const m of page.items || [])
    await importChat(env, org, a, { ...m, chat_id: payload.chat_id }, true);
  if (page.cursor)
    await enqueue(env, org, "chat-history", {
      ...payload,
      cursor: page.cursor,
    });
}
publicChannels.post("/channel-webhooks/:org/:source", async (c) => {
  const org = c.req.param("org"),
    cfg = await integration(c.env, org, "webhook");
  ensure(
    cfg?.secret &&
      constantEqual(c.req.header("X-Webhook-Secret") || "", cfg.secret),
    "Invalid webhook authentication",
    403,
  );
  const payload = await c.req.json<Row>(),
    wid = id();
  await c.env.DB.prepare(
    "INSERT INTO webhook_events(id,org_id,provider,payload) VALUES(?,?,?,?)",
  )
    .bind(wid, org, "unipile:" + c.req.param("source"), JSON.stringify(payload))
    .run();
  await enqueue(c.env, org, "channel-webhook", { webhook_id: wid });
  return c.json({ ok: true });
});
publicChannels.post("/outreach/webhooks/gmail-watch", async (c) => {
  const payload = await c.req.json<Row>(),
    data = payload.message?.data
      ? JSON.parse(new TextDecoder().decode(decodeBase64(payload.message.data)))
      : payload;
  const a = await c.env.DB.prepare(
    "SELECT * FROM channel_accounts WHERE address=? AND channel='email'",
  )
    .bind(text(data.emailAddress, 254).toLowerCase())
    .first<Row>();
  ensure(a, "Unknown mailbox", 404);
  const cfg = await integration(c.env, a.org_id, "google-workspace");
  ensure(
    cfg?.webhook_secret &&
      constantEqual(
        c.req.query("token") || c.req.header("X-Webhook-Secret") || "",
        cfg.webhook_secret,
      ),
    "Invalid webhook authentication",
    403,
  );
  await enqueue(
    c.env,
    a.org_id,
    "gmail-sync",
    { account_id: a.id },
    `gmail:${a.id}:${String(data.historyId || payload.message?.messageId || id())}`,
  );
  return c.json({ ok: true });
});
function decodeBase64(s: string) {
  return Uint8Array.from(atob(s), (x) => x.charCodeAt(0));
}
channelFeatures.get("/chats", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT c.*,a.channel,a.name account_name,p.name person_name FROM chats c JOIN channel_accounts a ON a.id=c.account_id AND a.org_id=c.org_id LEFT JOIN people p ON p.id=c.person_id AND p.org_id=c.org_id WHERE c.org_id=? ORDER BY c.rowid DESC LIMIT 500",
  )
    .bind(orgId(c))
    .all();
  return c.json({ items: rows.results });
});
channelFeatures.get("/chats/:id", async (c) => {
  const chat = await record(c.env, orgId(c), "chats", c.req.param("id"));
  const messages = await c.env.DB.prepare(
    "SELECT * FROM messages WHERE org_id=? AND account_id=? AND thread_id=? ORDER BY created_at LIMIT 500",
  )
    .bind(orgId(c), chat.account_id, chat.external_id)
    .all();
  return c.json({ ...chat, messages: messages.results });
});
channelFeatures.post("/chats/:id/read", async (c) => {
  const chat = await record(c.env, orgId(c), "chats", c.req.param("id"));
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE chats SET unread=0 WHERE id=? AND org_id=?").bind(
      chat.id,
      orgId(c),
    ),
    c.env.DB.prepare(
      "UPDATE messages SET read_at=? WHERE org_id=? AND account_id=? AND thread_id=?",
    ).bind(now(), orgId(c), chat.account_id, chat.external_id),
  ]);
  return c.json({ ok: true });
});
channelFeatures.get("/connections", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT * FROM connections WHERE org_id=? ORDER BY accepted_at DESC LIMIT 1000",
  )
    .bind(orgId(c))
    .all();
  return c.json({ items: rows.results });
});
channelFeatures.get("/search/batches", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT * FROM search_batches WHERE org_id=? ORDER BY created_at DESC",
  )
    .bind(orgId(c))
    .all();
  return c.json({ items: rows.results });
});
channelFeatures.post("/search/batches", async (c) => {
  const b = await c.req.json<Row>();
  ensure(
    text(b.name, 200) && Array.isArray(b.queries) && b.queries.length <= 200,
    "Provide a name and up to 200 search queries",
  );
  const a = await record(c.env, orgId(c), "channel_accounts", b.account_id);
  ensure(a.channel === "linkedin", "Choose a LinkedIn account");
  const bid = id();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO search_batches(id,org_id,name,account_id) VALUES(?,?,?,?)",
    ).bind(bid, orgId(c), text(b.name, 200), a.id),
    ...b.queries.map((q: unknown) =>
      c.env.DB.prepare(
        "INSERT INTO search_queries(id,org_id,batch_id,query) VALUES(?,?,?,?)",
      ).bind(
        id(),
        orgId(c),
        bid,
        typeof q === "string" ? q : JSON.stringify(q),
      ),
    ),
  ]);
  return c.json({ id: bid }, 201);
});
channelFeatures.get("/search/batches/:id", async (c) => {
  const b = await record(c.env, orgId(c), "search_batches", c.req.param("id"));
  const rows = await c.env.DB.prepare(
    "SELECT * FROM search_queries WHERE org_id=? AND batch_id=? ORDER BY created_at",
  )
    .bind(orgId(c), b.id)
    .all();
  return c.json({
    ...b,
    queries: rows.results.map((r) => ({
      ...r,
      results: json(r.results as string, []),
    })),
  });
});
channelFeatures.post("/search/batches/:id/run", async (c) => {
  const batch = await record(
    c.env,
    orgId(c),
    "search_batches",
    c.req.param("id"),
  );
  ensure(batch.account_id, "Choose an account");
  const queries = await c.env.DB.prepare(
    "SELECT id FROM search_queries WHERE org_id=? AND batch_id=? AND status IN ('pending','failed')",
  )
    .bind(orgId(c), batch.id)
    .all<{ id: string }>();
  for (const q of queries.results)
    await enqueue(c.env, orgId(c), "linkedin-search", { query_id: q.id });
  await c.env.DB.prepare(
    "UPDATE search_batches SET status='running' WHERE id=? AND org_id=?",
  )
    .bind(batch.id, orgId(c))
    .run();
  return c.json({ queued: queries.results.length });
});
channelFeatures.post("/search/batches/:id/continue", async (c) => {
  const b = await record(c.env, orgId(c), "search_batches", c.req.param("id"));
  const queries = await c.env.DB.prepare(
    "SELECT id FROM search_queries WHERE org_id=? AND batch_id=? AND cursor IS NOT NULL",
  )
    .bind(orgId(c), b.id)
    .all<Row>();
  for (const q of queries.results)
    await enqueue(c.env, orgId(c), "linkedin-search", { query_id: q.id });
  return c.json({ queued: queries.results.length });
});
export async function searchLinkedIn(env: Env, org: string, queryId: string) {
  const q = await record(env, org, "search_queries", queryId),
    batch = await record(env, org, "search_batches", q.batch_id),
    a = await record(env, org, "channel_accounts", batch.account_id);
  const cfg = await rules(env, org, "linkedin");
  ensure(a.status === "connected", "LinkedIn account disconnected");
  if (!withinHours(json<Row>(a.settings, {}).hours || cfg.workingHours))
    throw new PacingWait("Outside account working hours", 300);
  const dailyKey = `search:${a.id}`,
    day = now().slice(0, 10),
    pageSize = 50;
  await env.DB.prepare(
    "INSERT OR IGNORE INTO daily_usage(org_id,day,channel,count) VALUES(?,?,?,0)",
  )
    .bind(org, day, dailyKey)
    .run();
  const remaining =
    Number(cfg.searchLeadsPerDay) -
    (await env.DB.prepare(
      "SELECT count FROM daily_usage WHERE org_id=? AND day=? AND channel=?",
    )
      .bind(org, day, dailyKey)
      .first<Row>())!.count;
  if (remaining < 1) throw new PacingWait("Search daily limit reached", 3600);
  const wanted = Math.min(pageSize, remaining);
  const reserved = await env.DB.prepare(
    "UPDATE daily_usage SET count=count+? WHERE org_id=? AND day=? AND channel=? AND count+?<=? RETURNING count",
  )
    .bind(wanted, org, day, dailyKey, wanted, cfg.searchLeadsPerDay)
    .first();
  if (!reserved) throw new PacingWait("Search daily limit reached", 3600);
  const input = json<Row>(
      q.query,
      /^https?:\/\//.test(q.query) ? { url: q.query } : { keywords: q.query },
    ),
    r = await unipile(
      env,
      org,
      `linkedin/search?account_id=${encodeURIComponent(a.external_id)}`,
      "POST",
      {
        api: "classic",
        category: "people",
        ...input,
        limit: wanted,
        ...(q.cursor ? { cursor: q.cursor } : {}),
      },
    );
  const received = (r.items || []).slice(0, wanted);
  await env.DB.prepare(
    "UPDATE daily_usage SET count=MAX(0,count-?) WHERE org_id=? AND day=? AND channel=?",
  )
    .bind(wanted - received.length, org, day, dailyKey)
    .run();
  const results = [
    ...new Map(
      [...json<Row[]>(q.results, []), ...received].map((p: Row) => [
        p.id || p.provider_id,
        p,
      ]),
    ).values(),
  ];
  await env.DB.prepare(
    "UPDATE search_queries SET status='done',results=?,cursor=?,error='' WHERE id=? AND org_id=?",
  )
    .bind(JSON.stringify(results), r.cursor || null, q.id, org)
    .run();
}
channelFeatures.post("/search/batches/:id/import", async (c) => {
  const batch = await record(
    c.env,
    orgId(c),
    "search_batches",
    c.req.param("id"),
  );
  const qs = await c.env.DB.prepare(
    "SELECT results FROM search_queries WHERE org_id=? AND batch_id=?",
  )
    .bind(orgId(c), batch.id)
    .all<{ results: string }>();
  let count = 0;
  for (const q of qs.results)
    for (const person of json<Row[]>(q.results, [])) {
      const provider = String(person.id || person.provider_id || "");
      if (!provider) continue;
      const exists = await c.env.DB.prepare(
        "SELECT id FROM people WHERE org_id=? AND json_extract(custom,'$.linkedin_provider_id')=?",
      )
        .bind(orgId(c), provider)
        .first();
      if (exists) continue;
      await c.env.DB.prepare(
        "INSERT INTO people(id,org_id,name,company,title,linkedin,custom) VALUES(?,?,?,?,?,?,?)",
      )
        .bind(
          id(),
          orgId(c),
          text(
            person.name ||
              [person.first_name, person.last_name].filter(Boolean).join(" "),
            200,
          ) || provider,
          text(person.current_positions?.[0]?.company, 300),
          text(person.headline, 300),
          text(person.public_profile_url || person.profile_url, 500),
          JSON.stringify({
            linkedin_provider_id: provider,
            search_batch_id: batch.id,
          }),
        )
        .run();
      count++;
    }
  return c.json({ imported: count });
});
channelFeatures.delete("/search/batches/:id", async (c) => {
  await record(c.env, orgId(c), "search_batches", c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM search_batches WHERE id=? AND org_id=?")
    .bind(c.req.param("id"), orgId(c))
    .run();
  return c.json({ ok: true });
});
export async function processWebhook(env: Env, org: string, wid: string) {
  const w = await record(env, org, "webhook_events", wid),
    p = json<Row>(w.payload, {});
  if (w.provider === "unipile:users") await acceptConnection(env, org, p);
  else if (w.provider === "unipile:account_status")
    await syncAccounts(env, org);
  else {
    const a = await env.DB.prepare(
      "SELECT * FROM channel_accounts WHERE org_id=? AND external_id=?",
    )
      .bind(org, String(p.account_id || ""))
      .first<Row>();
    if (a) await importChat(env, org, a, p, false);
  }
  await env.DB.prepare(
    "UPDATE webhook_events SET status='done',error='' WHERE id=? AND org_id=?",
  )
    .bind(wid, org)
    .run();
}
channelFeatures.get("/webhook-events", async (c) => {
  requireAdmin(c);
  const items = await c.env.DB.prepare(
    "SELECT * FROM webhook_events WHERE org_id=? ORDER BY created_at DESC LIMIT 100",
  )
    .bind(orgId(c))
    .all();
  return c.json({ items: items.results });
});
channelFeatures.post("/webhook-events/:id/replay", async (c) => {
  requireAdmin(c);
  await record(c.env, orgId(c), "webhook_events", c.req.param("id"));
  return c.json(
    {
      job: await enqueue(c.env, orgId(c), "channel-webhook", {
        webhook_id: c.req.param("id"),
      }),
    },
    202,
  );
});
