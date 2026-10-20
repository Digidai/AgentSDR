import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile } from "node:fs/promises";
import { app } from "../src/api";
import { importChat, processWebhook } from "../src/features/channels";
import type { Env, Row } from "../src/types";
void app;

let mf: Miniflare, env: Env;
const org = "team-channel-org";
const account: Row = {
  id: "team-li-account",
  org_id: org,
  channel: "linkedin",
  external_id: "linked-account",
  settings: "{}",
};
const sql = (query: string, ...params: any[]) =>
  env.DB.prepare(query).bind(...params);
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("test")}}',
      compatibilityDate: "2026-10-17",
      d1Databases: ["DB"],
      r2Buckets: ["MEDIA"],
      queueProducers: { TASKS: "team-channel-fixture" },
    }),
  );
  env = {
    ...(await mf.getBindings()),
    ENCRYPTION_KEY: "team-key",
    APP_URL: "https://fixture.example.com",
  } as unknown as Env;
  for (const name of ["0001_native.sql", "0002_upstream_parity.sql"])
    await env.DB.exec(
      await readFile(new URL("../migrations/" + name, import.meta.url), "utf8"),
    );
  await sql(
    "INSERT INTO organizations(id,name) VALUES(?, 'Team channel tests')",
    org,
  ).run();
  await sql(
    "INSERT INTO channel_accounts(id,org_id,channel,external_id) VALUES(?,?,'linkedin',?)",
    account.id,
    org,
    account.external_id,
  ).run();
});
beforeEach(async () => {
  for (const table of ["webhook_events", "jobs", "chats", "people"])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
});
afterAll(async () => {
  await mf?.dispose();
});
async function person(id: string, phone = "", provider = "") {
  await sql(
    "INSERT INTO people(id,org_id,name,phone,custom) VALUES(?,?,?,?,?)",
    id,
    org,
    id,
    phone,
    JSON.stringify(provider ? { linkedin_provider_id: provider } : {}),
  ).run();
}
async function knownChat(personId: string) {
  await sql(
    "INSERT INTO chats(id,org_id,account_id,external_id,person_id) VALUES('fixture-chat',?,?, 'remote-chat',?)",
    org,
    account.id,
    personId,
  ).run();
}
describe("team review: incoming channel identity and direction", () => {
  it.each([true, false])(
    "does not assign a multi-peer group message with unknown individual recipient/sender to a cached contact (outbound=%s)",
    async (is_sender) => {
      await person("known-recipient", "+15550001111", "peer-provider");
      await knownChat("known-recipient");
      await importChat(env, org, account, {
        chat_id: "remote-chat",
        message_id: "group-unknown",
        is_sender,
        attendees: [
          { attendee_provider_id: "peer-provider" },
          { attendee_provider_id: "second-peer" },
        ],
        message: "Group conversation",
      });
      expect(
        (await sql("SELECT COUNT(*) n FROM messages").first<Row>())?.n,
      ).toBe(0);
    },
  );
  it("keeps ordinary incoming messages and duplicate webhook delivery correctly associated", async () => {
    await person("known-recipient", "+15550001111", "peer-provider");
    const payload = {
      event: "message_received",
      chat_id: "incoming-chat",
      message_id: "incoming-message",
      account_info: { user_id: "our-provider" },
      sender: { attendee_provider_id: "peer-provider" },
      message: "Customer reply",
    };
    await importChat(env, org, account, payload);
    await importChat(env, org, account, payload);
    expect(
      await sql(
        "SELECT person_id,direction,body FROM messages WHERE external_id='incoming-message'",
      ).first<Row>(),
    ).toMatchObject({
      person_id: "known-recipient",
      direction: "inbound",
      body: "Customer reply",
    });
    expect((await sql("SELECT COUNT(*) n FROM messages").first<Row>())?.n).toBe(
      1,
    );
  });
  it("resolves a self-sent new direct chat to its sole recipient, not the account owner", async () => {
    await importChat(env, org, account, {
      event: "message_received",
      chat_id: "new-outbound-chat",
      message_id: "new-outbound-message",
      account_info: { user_id: "our-provider" },
      sender: { attendee_provider_id: "our-provider" },
      attendees: [
        {
          attendee_provider_id: "customer-provider",
          attendee_name: "Customer",
        },
      ],
      message: "Our greeting",
    });
    const customer = await sql("SELECT id,custom FROM people").first<Row>();
    expect(JSON.parse(customer!.custom).linkedin_provider_id).toBe(
      "customer-provider",
    );
    expect(
      await sql("SELECT person_id,direction FROM messages").first<Row>(),
    ).toMatchObject({ person_id: customer!.id, direction: "outbound" });
  });
  it("never associates an unknown peer with the first contact having no phone", async () => {
    await person("unrelated-empty-phone");
    await importChat(
      env,
      org,
      account,
      { id: "unknown-chat", name: "Unknown chat" },
      true,
    );
    const chat = await sql(
      "SELECT person_id FROM chats WHERE external_id='unknown-chat'",
    ).first<Row>();
    expect(chat?.person_id).toBeNull();
  });
  it("keeps known chat identity when outbound history has no peer identifier", async () => {
    await person("unrelated-empty-phone");
    await person("known-recipient", "+15550001111", "peer-provider");
    await knownChat("known-recipient");
    await importChat(
      env,
      org,
      account,
      {
        chat_id: "remote-chat",
        id: "outbound-history",
        is_sender: 1,
        text: "Our previous message",
      },
      true,
    );
    expect(
      (
        await sql(
          "SELECT person_id FROM chats WHERE external_id='remote-chat'",
        ).first<Row>()
      )?.person_id,
    ).toBe("known-recipient");
    expect(
      await sql(
        "SELECT person_id,direction FROM messages WHERE external_id='outbound-history'",
      ).first<Row>(),
    ).toMatchObject({ person_id: "known-recipient", direction: "outbound" });
  });
  it("uses the official webhook sender/account identity to recognize self-sent messages", async () => {
    await person("known-recipient", "+15550001111", "peer-provider");
    await knownChat("known-recipient");
    await importChat(env, org, account, {
      event: "message_received",
      chat_id: "remote-chat",
      message_id: "self-webhook",
      account_info: { user_id: "our-provider-id" },
      sender: { attendee_provider_id: "our-provider-id" },
      attendees: [{ attendee_provider_id: "peer-provider" }],
      message: "Sent from our phone",
    });
    const saved = await sql(
      "SELECT person_id,direction FROM messages WHERE external_id='self-webhook'",
    ).first<Row>();
    expect(saved).toMatchObject({
      person_id: "known-recipient",
      direction: "outbound",
    });
    expect((await sql("SELECT COUNT(*) n FROM people").first<Row>())?.n).toBe(
      1,
    );
    expect(
      (await sql("SELECT COUNT(*) n FROM jobs WHERE kind='crm'").first<Row>())
        ?.n,
    ).toBe(0);
  });
  it("does not match a LinkedIn provider id against unrelated phone digits", async () => {
    await person("phone-only-contact", "+12345");
    await importChat(env, org, account, {
      id: "new-linkedin-chat",
      sender: {
        attendee_provider_id: "12345",
        attendee_name: "LinkedIn person",
      },
    });
    const chat = await sql(
      "SELECT person_id FROM chats WHERE external_id='new-linkedin-chat'",
    ).first<Row>();
    expect(chat?.person_id).toBeTruthy();
    expect(chat?.person_id).not.toBe("phone-only-contact");
  });
  it.each(["message_read", "message_reaction", "message_deleted"])(
    "does not treat a %s event as a fresh customer reply",
    async (event) => {
      await person("known-recipient", "+15550001111", "peer-provider");
      await knownChat("known-recipient");
      await sql(
        "INSERT INTO webhook_events(id,org_id,provider,payload) VALUES('notification',?,'unipile:messaging',?)",
        org,
        JSON.stringify({
          event,
          account_id: account.external_id,
          chat_id: "remote-chat",
          message_id: "notification-message",
          sender: { attendee_provider_id: "peer-provider" },
          message: "Text copied in provider notification",
        }),
      ).run();
      await processWebhook(env, org, "notification");
      expect(
        (await sql("SELECT COUNT(*) n FROM messages").first<Row>())?.n,
      ).toBe(0);
      expect(
        (
          await sql(
            "SELECT status FROM webhook_events WHERE id='notification'",
          ).first<Row>()
        )?.status,
      ).toBe("done");
    },
  );
});
