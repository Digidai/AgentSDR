import { Hono } from "hono";
import type { AppEnv, Env, Row } from "../types";
import { decrypt, fromB64, id, now, text } from "../core";
import { requireAdmin } from "../auth";
import { ensure, orgId, pref, record, savePref } from "./shared";
import {
  normalizeByokSettings,
  strictProviderRouting,
  strictImageProviderRouting,
  openRouterTokenLimit,
  type ByokSettings,
} from "../ported/openrouter-types";
import { listOpenRouterByokCatalog } from "../ported/openrouter-catalog";
export const aiFeatures = new Hono<AppEnv>();
async function credentials(env: Env, org: string, connectionId: string) {
  const c = await record(env, org, "provider_connections", connectionId);
  ensure(
    c.provider === "openrouter" && c.enabled,
    "Choose a verified OpenRouter connection",
  );
  const credentials = await decrypt<Row>(c.encrypted, env.ENCRYPTION_KEY);
  return {
    apiKey: credentials.apiKey || credentials.api_key,
    managementKey: credentials.managementKey || credentials.management_key,
  };
}
aiFeatures.get("/ai/byok/settings", async (c) =>
  c.json(normalizeByokSettings(await pref(c.env, orgId(c), "byok", {}))),
);
aiFeatures.get("/ai/byok/catalog", async (c) => {
  const settings = normalizeByokSettings(
      await pref(c.env, orgId(c), "byok", {}),
    ),
    cid = c.req.query("connectionId") || settings.connectionId;
  if (!cid) return c.json({ providers: [], settings });
  const key = await credentials(c.env, orgId(c), cid);
  ensure(
    key.managementKey,
    "Add an OpenRouter management key to discover BYOK models",
  );
  return c.json({
    providers: await listOpenRouterByokCatalog(key.managementKey),
    settings,
  });
});
aiFeatures.put("/ai/byok/settings", async (c) => {
  requireAdmin(c);
  const s = normalizeByokSettings(await c.req.json());
  if (s.providers.length) {
    ensure(
      s.byokOnlyConfirmed && s.connectionId && s.defaultModel,
      "Choose a connection, default model and confirm BYOK-only routing",
    );
    const key = await credentials(c.env, orgId(c), s.connectionId),
      catalog = await listOpenRouterByokCatalog(key.managementKey);
    for (const provider of s.providers) {
      const p = catalog.find((p) => p.slug === provider);
      ensure(
        p?.prioritizedCredentialCount,
        "Provider has no active prioritized BYOK credential",
      );
      ensure(
        s.modelsByProvider[provider]?.length &&
          s.modelsByProvider[provider].every((model) =>
            p.models.some((m) => m.id === model),
          ),
        "Enabled models are not in the verified provider catalog",
      );
    }
  }
  await savePref(c.env, orgId(c), "byok", s);
  return c.json(s);
});
export async function strictAiRuntime(
  env: Env,
  org: string,
  options: Row = {},
) {
  const raw = await pref<Row | null>(env, org, "byok", null);
  if (!raw?.providers?.length) return null;
  const s = normalizeByokSettings(raw),
    selection = options.model
      ? {
          provider: options.upstreamProvider || s.defaultModel?.provider,
          modelId: options.model,
        }
      : s.defaultModel;
  ensure(
    s.byokOnlyConfirmed && s.connectionId && selection,
    "Configure the BYOK default model",
  );
  ensure(
    s.providers.includes(selection.provider) &&
      s.modelsByProvider[selection.provider]?.includes(selection.modelId),
    "Model/provider is not enabled",
  );
  if (options.connectionId)
    ensure(
      options.connectionId === s.connectionId,
      "Choose the verified workspace BYOK connection",
    );
  return {
    ...(await credentials(env, org, s.connectionId)),
    model: selection.modelId,
    provider: selection.provider,
  };
}
export async function aiImage(
  env: Env,
  org: string,
  prompt: string,
  options: Row,
  tableId: string,
) {
  const strict = await strictAiRuntime(env, org, options);
  ensure(strict, "Configure verified BYOK image models in AI Settings");
  const body = {
    model: strict.model,
    prompt,
    n: 1,
    provider: strictImageProviderRouting(strict.provider),
  };
  const response = await fetch("https://openrouter.ai/api/v1/images", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${strict.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  ensure(response.ok, `Image provider returned HTTP ${response.status}`);
  const r = (await response.json()) as Row,
    image = r.data?.[0];
  ensure(image?.b64_json, "Provider returned no image");
  const bytes = fromB64(image.b64_json);
  ensure(bytes.byteLength <= 20 * 1024 * 1024, "Generated image exceeds 20 MB");
  const fid = id(),
    key = `${org}/generated/${fid}`,
    contentType = /^image\/(png|jpeg|webp)$/.test(image.media_type)
      ? image.media_type
      : "image/png";
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType } });
  await env.DB.prepare(
    "INSERT INTO files(id,org_id,name,object_key,content_type,size,table_id) VALUES(?,?,?,?,?,?,?)",
  )
    .bind(
      fid,
      org,
      "Generated image",
      key,
      contentType,
      bytes.byteLength,
      tableId,
    )
    .run();
  return {
    value: `/api/files/${fid}`,
    audit: {
      request: body,
      response: {
        ...r,
        data: [{ media_type: contentType, bytes: bytes.byteLength }],
      },
    },
    provider: `openrouter/${strict.model}@${strict.provider}`,
  };
}
