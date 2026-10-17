// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.
import {
  resolveByokAllowedModelIds,
  type OpenRouterModelSummary,
  type OpenRouterProviderModels,
} from "./openrouter-types";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export type OpenRouterModel = {
  id: string;
  canonical_slug?: string;
  name: string;
  description?: string;
  context_length?: number;
  architecture?: { output_modalities?: string[] };
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
};
export type OpenRouterByokCredential = {
  id: string;
  provider: string;
  name: string | null;
  label: string;
  disabled: boolean;
  is_fallback: boolean;
  allowed_models: string[] | null;
  allowed_api_key_hashes: string[] | null;
};
type OpenRouterProvider = { slug: string; name: string };

async function openRouterJson<T>(path: string, apiKey?: string): Promise<T> {
  const response = await fetch(`${OPENROUTER_BASE_URL}${path}`, {
    headers: apiKey?.trim()
      ? { Authorization: `Bearer ${apiKey.trim()}` }
      : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json().catch(() => null)) as
    ({ error?: { message?: string } } & T) | null;
  if (!response.ok) {
    throw new Error(
      body?.error?.message ?? `OpenRouter request failed (${response.status})`,
    );
  }
  if (!body) throw new Error("OpenRouter returned an empty response");
  return body;
}

export async function verifyOpenRouterInferenceKey(
  apiKey: string,
): Promise<void> {
  const body = await openRouterJson<{ data?: { is_management_key?: boolean } }>(
    "/key",
    apiKey,
  );
  if (body.data?.is_management_key) {
    throw new Error(
      "Use an OpenRouter inference key here; management keys cannot run models",
    );
  }
}

export async function listOpenRouterByokCredentials(
  managementKey: string,
): Promise<OpenRouterByokCredential[]> {
  const credentials: OpenRouterByokCredential[] = [];
  for (let offset = 0; ; offset += 100) {
    const body = await openRouterJson<{
      data?: OpenRouterByokCredential[];
      total_count?: number;
    }>(`/byok?limit=100&offset=${offset}`, managementKey);
    const page = body.data ?? [];
    credentials.push(...page);
    if (
      !page.length ||
      credentials.length >= (body.total_count ?? credentials.length)
    )
      break;
  }
  return credentials;
}

export async function listOpenRouterByokCatalog(
  managementKey: string,
): Promise<OpenRouterProviderModels[]> {
  const [credentials, providerBody] = await Promise.all([
    listOpenRouterByokCredentials(managementKey),
    openRouterJson<{ data?: OpenRouterProvider[] }>("/providers"),
  ]);
  const providerNames = new Map(
    (providerBody.data ?? []).map((provider) => [provider.slug, provider.name]),
  );
  const active = credentials.filter((credential) => !credential.disabled);
  const groups = new Map<string, OpenRouterByokCredential[]>();
  for (const credential of active) {
    groups.set(credential.provider, [
      ...(groups.get(credential.provider) ?? []),
      credential,
    ]);
  }

  const hasRestrictedAzureCredential = (groups.get("azure") ?? []).some(
    (credential) =>
      !credential.is_fallback && credential.allowed_models !== null,
  );
  const globalModelsPromise = hasRestrictedAzureCredential
    ? openRouterJson<{ data?: OpenRouterModel[] }>(
        "/models?limit=1000&output_modalities=all",
      )
    : Promise.resolve<{ data?: OpenRouterModel[] }>({ data: [] });

  return Promise.all(
    [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(async ([slug, entries]) => {
        // Fallback-section credentials run after OpenRouter's shared endpoints.
        // They are shown for visibility, but never exposed as selectable strict routes.
        const prioritized = entries.filter((entry) => !entry.is_fallback);
        if (!prioritized.length) {
          return {
            slug,
            name: providerNames.get(slug) ?? slug,
            credentialCount: entries.length,
            prioritizedCredentialCount: 0,
            fallbackCredentialCount: entries.length,
            discoveredModelCount: 0,
            modelFilterRestricted: false,
            allowedModelCount: 0,
            unmatchedAllowedModels: [],
            models: [],
          };
        }

        // The Models API is public. Avoid sending the inference key here because
        // API-key/account restrictions can hide models that are valid for this
        // BYOK provider. The BYOK credential filters are applied explicitly below.
        const providerName = providerNames.get(slug) ?? slug;
        const params = new URLSearchParams({
          providers: providerName,
          limit: "1000",
          output_modalities: "all",
        });
        const body = await openRouterJson<{ data?: OpenRouterModel[] }>(
          `/models?${params}`,
        );
        const unrestricted = prioritized.some(
          (entry) => entry.allowed_models === null,
        );
        const allowed = new Set(
          prioritized.flatMap((entry) => entry.allowed_models ?? []),
        );
        const isSelectableModel = (model: OpenRouterModel) => {
          const outputModalities = model.architecture?.output_modalities ?? [
            "text",
          ];
          return (
            !model.id.endsWith(":free") &&
            (outputModalities.includes("text") ||
              outputModalities.includes("image"))
          );
        };
        const discovered = (body.data ?? []).filter(isSelectableModel);
        const globalModels =
          slug === "azure" && !unrestricted
            ? ((await globalModelsPromise).data ?? []).filter(isSelectableModel)
            : [];
        const resolved = resolveByokAllowedModelIds({
          provider: slug,
          allowedModelIds: [...allowed],
          providerModels: discovered.map((model) => ({
            id: model.id,
            canonicalSlug: model.canonical_slug,
          })),
          globalModels: globalModels.map((model) => ({
            id: model.id,
            canonicalSlug: model.canonical_slug,
          })),
        });
        const restrictedModelIds = new Set(resolved.modelIds);
        const sourceModels =
          slug === "azure" && !unrestricted
            ? [
                ...new Map(
                  [...globalModels, ...discovered].map((model) => [
                    model.id,
                    model,
                  ]),
                ).values(),
              ]
            : discovered;
        const catalogModels: OpenRouterModelSummary[] = sourceModels
          .filter((model) => unrestricted || restrictedModelIds.has(model.id))
          .map((model) => ({
            id: model.id,
            canonicalSlug: model.canonical_slug,
            name: model.name,
            description: model.description,
            context_length: model.context_length,
            pricing: model.pricing,
            supportedParameters: model.supported_parameters,
            outputModalities: model.architecture?.output_modalities ?? ["text"],
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return {
          slug,
          name: providerName,
          credentialCount: entries.length,
          prioritizedCredentialCount: prioritized.length,
          fallbackCredentialCount: entries.length - prioritized.length,
          discoveredModelCount: discovered.length,
          modelFilterRestricted: !unrestricted,
          allowedModelCount: allowed.size,
          unmatchedAllowedModels: resolved.unmatchedModelIds,
          models: catalogModels,
        };
      }),
  );
}
