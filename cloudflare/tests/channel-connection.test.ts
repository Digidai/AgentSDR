import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile } from "node:fs/promises";
import { app } from "../src/api";
import { encrypt } from "../src/core";
import { unipileBase } from "../src/providers";
import type { Env, Row } from "../src/types";

const origin = "https://channels.example.com";
let mf: Miniflare, env: Env, cookie: string, org: string;
async function request(path: string, method = "GET", body?: unknown) {
  return app.request(
    origin + "/api" + path,
    {
      method,
      headers: {
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}
async function configured() {
  await env.DB.prepare(
    "INSERT INTO integrations(org_id,kind,encrypted) VALUES(?,'unipile',?)",
  )
    .bind(
      org,
      await encrypt(
        {
          api_key: "fixture-private-key",
          base_url: "https://fixture.unipile.com:13178",
        },
        env.ENCRYPTION_KEY,
      ),
    )
    .run();
}
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("fixture")}}',
      compatibilityDate: "2026-10-17",
      d1Databases: ["DB"],
      r2Buckets: ["MEDIA"],
      queueProducers: { TASKS: "channel-fixture" },
    }),
  );
  env = {
    ...(await mf.getBindings()),
    APP_URL: origin,
    ENCRYPTION_KEY: "channel-fixture-key",
    BOOTSTRAP_TOKEN: "channel-fixture-setup",
    UNSUBSCRIBE_SECRET: "fixture",
  } as unknown as Env;
  for (const migration of ["0001_native.sql", "0002_upstream_parity.sql"])
    await env.DB.exec(
      await readFile(
        new URL("../migrations/" + migration, import.meta.url),
        "utf8",
      ),
    );
  const response = await request("/auth/setup", "POST", {
    token: env.BOOTSTRAP_TOKEN,
    email: "owner@example.com",
    name: "Owner",
    organization: "Channel tests",
    password: "channel-test-password-long",
  });
  expect(response.status).toBe(201);
  cookie = response.headers.get("set-cookie")!.split(";")[0];
  org = ((await (await request("/auth/status")).json()) as Row).user.org_id;
});
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM integrations WHERE org_id=?")
    .bind(org)
    .run();
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await mf?.dispose();
});

describe("channel connection prerequisites and provider flows", () => {
  it.each(["linkedin", "whatsapp"])(
    "explains missing setup for %s before contacting a provider",
    async (channel) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const response = await request("/accounts/hosted-auth", "POST", {
        channel,
      });
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).toContain("Unipile");
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("does not create a webhook secret when channel setup is missing", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const response = await request("/channel-webhooks/register", "POST", {});
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain("Unipile");
    expect(
      await env.DB.prepare("SELECT kind FROM integrations WHERE org_id=?")
        .bind(org)
        .first(),
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("exposes connection readiness without credentials", async () => {
    expect(
      ((await (await request("/accounts")).json()) as Row).connections.unipile,
    ).toBe(false);
    await configured();
    const response = (await (await request("/accounts")).json()) as Row;
    expect(response.connections.unipile).toBe(true);
    expect(JSON.stringify(response)).not.toContain("fixture-private-key");
  });
  it("accepts HTTPS Unipile DSN ports while rejecting arbitrary hosts and embedded credentials", () => {
    expect(
      unipileBase({ base_url: "https://fixture.unipile.com:13178/" }),
    ).toBe("https://fixture.unipile.com:13178");
    for (const base_url of [
      "http://fixture.unipile.com:13178",
      "https://unipile.com.attacker.example",
      "https://127.0.0.1:13178",
      "https://secret@fixture.unipile.com",
    ])
      expect(() => unipileBase({ base_url })).toThrow();
  });
  it("verifies and saves a DSN port with trimmed credentials through the settings API", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ items: [] }),
    );
    vi.stubGlobal("fetch", fetch);
    const response = await request("/integrations/unipile", "POST", {
      base_url: " https://fixture.unipile.com:13178/ ",
      api_key: " fixture-private-key ",
    });
    expect(response.status).toBe(200);
    expect(fetch.mock.calls[0][0]).toBe(
      "https://fixture.unipile.com:13178/api/v1/accounts",
    );
    expect(
      (fetch.mock.calls[0][1]?.headers as Record<string, string>)["X-API-KEY"],
    ).toBe("fixture-private-key");
    const connections = (await (await request("/accounts")).json()) as Row;
    expect(connections.connections.unipile).toBe(true);
    expect(JSON.stringify(connections)).not.toContain("fixture-private-key");
  });
  it.each(["linkedin", "whatsapp"])(
    "creates a valid %s authorization link and returns to channels",
    async (channel) => {
      await configured();
      const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
        Response.json({ url: "https://account.unipile.com/fixture-auth" }),
      );
      vi.stubGlobal("fetch", fetch);
      const response = await request("/accounts/hosted-auth", "POST", {
        channel,
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as Row).url).toBe(
        "https://account.unipile.com/fixture-auth",
      );
      expect(fetch.mock.calls[0][0]).toBe(
        "https://fixture.unipile.com:13178/api/v1/hosted/accounts/link",
      );
      const payload = JSON.parse(String(fetch.mock.calls[0][1]?.body));
      expect(payload.providers).toEqual([channel.toUpperCase()]);
      expect(payload.api_url).toBe("https://fixture.unipile.com:13178");
      expect(payload.success_redirect_url).toBe(
        origin + "/channels?connected=1",
      );
    },
  );
  it("rejects an invalid channel before creating an authorization link", async () => {
    await configured();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(
      (await request("/accounts/hosted-auth", "POST", { channel: "email" }))
        .status,
    ).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reports provider credential rejection without a generic internal error", async () => {
    await configured();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ message: "invalid credentials" }, { status: 401 }),
      ),
    );
    const response = await request("/accounts/hosted-auth", "POST", {
      channel: "linkedin",
    });
    expect(response.status).toBe(502);
    const body = JSON.stringify(await response.json());
    expect(body).toContain("Unipile");
    expect(body).toContain("401");
    expect(body).not.toContain("fixture-private-key");
  });
  it("does not create local webhook credentials if the provider cannot be reached", async () => {
    await configured();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network unavailable");
      }),
    );
    const response = await request("/channel-webhooks/register", "POST", {});
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).toContain("Unipile");
    expect(
      await env.DB.prepare(
        "SELECT kind FROM integrations WHERE org_id=? AND kind='webhook'",
      )
        .bind(org)
        .first(),
    ).toBeNull();
  });
  it("registers three notification sources and reuses existing provider webhooks", async () => {
    await configured();
    const registered: Row[] = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit = {}) => {
      if (init.method === "GET") return Response.json({ items: registered });
      const body = JSON.parse(String(init.body));
      registered.push(body);
      return Response.json({ id: "hook-" + registered.length });
    });
    vi.stubGlobal("fetch", fetch);
    expect(
      (await request("/channel-webhooks/register", "POST", {})).status,
    ).toBe(200);
    expect(registered.map((r) => r.source)).toEqual([
      "messaging",
      "users",
      "account_status",
    ]);
    expect(
      (await request("/channel-webhooks/register", "POST", {})).status,
    ).toBe(200);
    expect(registered).toHaveLength(3);
    expect(
      fetch.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(3);
  });
});
