// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.

import type {
  CellResult,
  EnrichmentConfig,
  PendingCellResult,
} from "../../grid/types";
import type { IntegrationActionDefinition } from "../types";
import { PermanentRunError } from "../../grid/runners/types";
import type { IntegrationActionHandlers } from "../server/types";
import {
  asRecord,
  errorMessage,
  mapConfiguredOutputs,
  normalizeDomain,
  parseJson,
  truncate,
} from "../server/helpers";

const SNOV_REQUEST_SPACING_MS = 1050;
let nextSnovRequestAt = 0;
const snovTokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getSnovAccessToken(
  connectionId: string,
  credentials: Record<string, string>,
  timeoutMs: number,
): Promise<string> {
  const cacheKey = `${connectionId}:${credentials.clientId ?? ""}`;
  const cached = snovTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: credentials.clientId ?? "",
    client_secret: credentials.clientSecret ?? "",
  });
  const { response, body: payload } = await fetchJson(
    "https://api.snov.io/v1/oauth/access_token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
    timeoutMs,
  );
  const tokenResponse = asRecord(payload);
  const token = tokenResponse.access_token;
  if (!response.ok || typeof token !== "string" || !token) {
    throw new PermanentRunError("Snov.io rejected this account's credentials");
  }
  const expiresIn = Number(tokenResponse.expires_in ?? 3600);
  snovTokenCache.set(cacheKey, {
    token,
    expiresAt: Date.now() + Math.max(60, expiresIn) * 1000,
  });
  return token;
}

async function runSnov(
  config: EnrichmentConfig,
  action: IntegrationActionDefinition,
  inputs: Record<string, unknown>,
  accessToken: string,
  providerState: Record<string, unknown> | null | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CellResult | PendingCellResult> {
  if (action.handlerKey === "snov.emailCount") {
    return runSnovImmediate(
      config,
      action,
      accessToken,
      "/v1/get-domain-emails-count",
      {
        domain: normalizeDomain(String(inputs.domain)),
      },
      timeoutMs,
      signal,
    );
  }
  if (action.handlerKey === "snov.profileByEmail") {
    return runSnovImmediate(
      config,
      action,
      accessToken,
      "/v1/get-profile-by-email",
      {
        email: String(inputs.email),
      },
      timeoutMs,
      signal,
    );
  }

  const taskHash =
    typeof providerState?.taskHash === "string" ? providerState.taskHash : null;
  const startedAt =
    typeof providerState?.startedAt === "number"
      ? providerState.startedAt
      : Date.now();
  if (Date.now() - startedAt > (action.async?.timeoutMs ?? 300_000)) {
    throw new PermanentRunError(
      "Snov.io did not finish this task before its timeout",
    );
  }

  if (!taskHash) {
    const { endpoint, body, json } = snovStartRequest(
      action.handlerKey,
      inputs,
    );
    const request = await fetchJson(
      `https://api.snov.io${endpoint}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(json
            ? { "Content-Type": "application/json" }
            : { "Content-Type": "application/x-www-form-urlencoded" }),
        },
        body: json ? JSON.stringify(body) : (body as URLSearchParams),
      },
      timeoutMs,
      signal,
    );
    assertSnovResponse(request.response, request.body);
    const root = asRecord(request.body);
    const externalId =
      asRecord(root.data).task_hash ?? asRecord(root.meta).task_hash;
    if (typeof externalId !== "string" || !externalId) {
      throw new PermanentRunError(
        `Snov.io did not return a task hash: ${errorMessage(request.body, "invalid response")}`,
      );
    }
    return {
      pending: true,
      state: { taskHash: externalId, startedAt, pollCount: 0 },
      pollAfterMs: action.async?.pollAfterMs ?? 3000,
    };
  }

  const pollEndpoint = snovPollEndpoint(action.handlerKey, taskHash, inputs);
  const polled = await fetchJson(
    `https://api.snov.io${pollEndpoint}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
    timeoutMs,
    signal,
  );
  assertSnovResponse(polled.response, polled.body);
  const status = String(asRecord(polled.body).status ?? "")
    .toLowerCase()
    .replace(" ", "_");
  if (status === "in_progress" || !status) {
    const pollCount = Number(providerState?.pollCount ?? 0) + 1;
    return {
      pending: true,
      state: { taskHash, startedAt, pollCount },
      pollAfterMs: Math.min(
        30_000,
        (action.async?.pollAfterMs ?? 3000) *
          Math.max(1, Math.ceil(pollCount / 3)),
      ),
    };
  }
  if (status === "not_enough_credits")
    throw new PermanentRunError("Snov.io account does not have enough credits");
  if (status !== "completed")
    throw new PermanentRunError(`Snov.io task ended with status: ${status}`);

  return makeSnovResult(config, action, inputs, polled.body, polled.latencyMs);
}

async function runSnovImmediate(
  config: EnrichmentConfig,
  action: IntegrationActionDefinition,
  accessToken: string,
  endpoint: string,
  fields: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CellResult> {
  const body = new URLSearchParams({ access_token: accessToken, ...fields });
  const result = await fetchJson(
    `https://api.snov.io${endpoint}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
    timeoutMs,
    signal,
  );
  if (
    action.handlerKey === "snov.profileByEmail" &&
    isSnovProfileNotFound(result.response, result.body)
  ) {
    return makeSnovResult(
      config,
      action,
      fields,
      result.body,
      result.latencyMs,
    );
  }
  assertSnovResponse(result.response, result.body);
  return makeSnovResult(config, action, fields, result.body, result.latencyMs);
}

function isSnovProfileNotFound(response: Response, body: unknown): boolean {
  if (!response.ok) return false;
  const root = asRecord(body);
  if (root.success !== false) return false;
  const detail = [root.result, root.message, root.error]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return /(?:could(?:n't| not) find|not found|no profile)/i.test(detail);
}

function snovStartRequest(
  handlerKey: string,
  inputs: Record<string, unknown>,
): {
  endpoint: string;
  body: URLSearchParams | Record<string, unknown>;
  json: boolean;
} {
  if (handlerKey === "snov.domainSearch") {
    return {
      endpoint: "/v2/domain-search/start",
      body: new URLSearchParams({
        domain: normalizeDomain(String(inputs.domain)),
      }),
      json: false,
    };
  }
  if (handlerKey === "snov.databaseSearch") {
    const searchType = String(inputs.searchType).trim().toLowerCase();
    if (searchType !== "prospects" && searchType !== "companies") {
      throw new PermanentRunError("Search Type must be prospects or companies");
    }
    let filters = inputs.filters;
    if (typeof filters === "string") {
      try {
        filters = JSON.parse(filters);
      } catch {
        throw new PermanentRunError("Search Filters must contain valid JSON");
      }
    }
    return {
      endpoint: `/v2/database-search/${searchType}/start`,
      body: { filters, page: Number(inputs.page ?? 1) },
      json: true,
    };
  }
  if (handlerKey === "snov.findEmailsByNameDomain") {
    return {
      endpoint: "/v2/emails-by-domain-by-name/start",
      body: {
        rows: [
          {
            first_name: inputs.firstName,
            last_name: inputs.lastName,
            domain: normalizeDomain(String(inputs.domain)),
          },
        ],
      },
      json: true,
    };
  }
  if (handlerKey === "snov.companyDomainByName") {
    const body = new URLSearchParams();
    body.append("names[]", String(inputs.companyName));
    return { endpoint: "/v2/company-domain-by-name/start", body, json: false };
  }
  if (handlerKey === "snov.linkedinProfileInfo") {
    const body = new URLSearchParams();
    body.append("urls[]", String(inputs.linkedinUrl));
    return { endpoint: "/v2/li-profiles-by-urls/start", body, json: false };
  }
  if (handlerKey === "snov.emailVerifier") {
    const body = new URLSearchParams();
    body.append("emails[]", String(inputs.email));
    return { endpoint: "/v2/email-verification/start", body, json: false };
  }
  throw new PermanentRunError(`Unknown Snov.io action: ${handlerKey}`);
}

function snovPollEndpoint(
  handlerKey: string,
  taskHash: string,
  inputs: Record<string, unknown>,
): string {
  const encoded = encodeURIComponent(taskHash);
  if (handlerKey === "snov.domainSearch")
    return `/v2/domain-search/result/${encoded}`;
  if (handlerKey === "snov.databaseSearch") {
    const type = String(inputs.searchType).trim().toLowerCase();
    return `/v2/database-search/${type}/result/${encoded}`;
  }
  if (handlerKey === "snov.findEmailsByNameDomain")
    return `/v2/emails-by-domain-by-name/result?task_hash=${encoded}`;
  if (handlerKey === "snov.companyDomainByName")
    return `/v2/company-domain-by-name/result?task_hash=${encoded}`;
  if (handlerKey === "snov.linkedinProfileInfo")
    return `/v2/li-profiles-by-urls/result?task_hash=${encoded}`;
  if (handlerKey === "snov.emailVerifier")
    return `/v2/email-verification/result?task_hash=${encoded}`;
  throw new PermanentRunError(`Unknown Snov.io action: ${handlerKey}`);
}

function makeSnovResult(
  config: EnrichmentConfig,
  action: IntegrationActionDefinition,
  inputs: Record<string, unknown>,
  body: unknown,
  latencyMs: number,
): CellResult {
  const logicalOutputs = extractSnovOutputs(action.handlerKey, body);
  const outputs = mapConfiguredOutputs(config, logicalOutputs, body);
  const found = Object.values(logicalOutputs).some(
    (value) =>
      value !== null &&
      value !== undefined &&
      value !== "" &&
      (!Array.isArray(value) || value.length),
  );
  return {
    value: found ? "Found" : "Not found",
    outputs,
    provider: "snov",
    outcome: found ? "hit" : "miss",
    costCents: 0,
    latencyMs,
    request: { action: action.handlerKey, inputKeys: Object.keys(inputs) },
    response: truncate(body),
  };
}

function extractSnovOutputs(
  handlerKey: string,
  body: unknown,
): Record<string, unknown> {
  const root = asRecord(body);
  if (handlerKey === "snov.emailCount")
    return { emailCount: root.result, webmail: root.webmail };
  if (handlerKey === "snov.profileByEmail")
    return {
      profileId: root.id,
      source: root.source,
      name: root.name,
      firstName: root.firstName,
      lastName: root.lastName,
      industry: root.industry,
      country: root.country,
      locality: root.locality,
      profileImage: root.logo,
      social: root.social,
      currentJobs: root.currentJobs,
      previousJobs: root.previousJobs,
      lastUpdated: root.lastUpdateDate,
    };
  if (handlerKey === "snov.domainSearch") {
    const data = asRecord(root.data);
    const meta = asRecord(root.meta);
    return {
      companyName: data.company_name,
      city: data.city,
      founded: numberOrValue(data.founded),
      website: data.website,
      phone: data.hq_phone,
      industry: data.industry,
      size: data.size,
      relatedDomains: data.related_domains,
      prospectsCount: meta.prospects_count,
      emailsCount: meta.emails_count,
      genericContactsCount: meta.generic_contacts_count,
    };
  }
  if (handlerKey === "snov.databaseSearch") {
    const data = asRecord(root.data);
    return {
      total: data.total,
      page: data.page,
      totalPages: data.total_pages,
      results: data.prospects ?? data.companies ?? [],
    };
  }
  const first = Array.isArray(root.data)
    ? asRecord(root.data[0])
    : asRecord(root.data);
  const resultValue = first.result;
  const result = Array.isArray(resultValue)
    ? asRecord(resultValue[0])
    : asRecord(resultValue);
  if (handlerKey === "snov.findEmailsByNameDomain")
    return {
      fullName: first.people,
      email: result.email,
      smtpStatus: result.smtp_status,
      isValidFormat: result.is_valid_format,
      isDisposable: result.is_disposable,
      isWebmail: result.is_webmail,
      unknownReason: result.unknown_status_reason,
    };
  if (handlerKey === "snov.companyDomainByName")
    return { companyName: first.name, domain: result.domain };
  if (handlerKey === "snov.linkedinProfileInfo")
    return {
      name: result.name,
      firstName: result.first_name,
      lastName: result.last_name,
      industry: result.industry,
      location: result.location,
      country: result.country,
      skills: result.skills,
      positions: result.positions,
    };
  if (handlerKey === "snov.emailVerifier")
    return {
      email: first.email,
      smtpStatus: result.smtp_status,
      isValidFormat: result.is_valid_format,
      isDisposable: result.is_disposable,
      isWebmail: result.is_webmail,
      isGibberish: result.is_gibberish,
      unknownReason: result.unknown_status_reason,
    };
  return {};
}

function assertSnovResponse(response: Response, body: unknown): void {
  const root = asRecord(body);
  if (response.ok && root.success !== false && !root.error) return;
  const message = `Snov.io returned ${response.status}: ${errorMessage(body, "request failed")}`;
  if (response.ok) throw new PermanentRunError(message);
  if (
    response.status >= 400 &&
    response.status < 500 &&
    response.status !== 429
  ) {
    throw new PermanentRunError(message);
  }
  throw new Error(message);
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Promise<{ response: Response; body: unknown; latencyMs: number }> {
  // Snov.io documents a 60 request/minute API limit. Reserve one local slot
  // before every token, submit, and poll request so a worker burst cannot
  // exhaust the account immediately.
  const slot = Math.max(Date.now(), nextSnovRequestAt);
  nextSnovRequestAt = slot + SNOV_REQUEST_SPACING_MS;
  const waitMs = slot - Date.now();
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  outerSignal?.addEventListener("abort", abort);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await response.text();
    return { response, body: parseJson(text), latencyMs: Date.now() - started };
  } catch (error) {
    if ((error as Error).name === "AbortError")
      throw new Error(`Snov.io request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", abort);
  }
}

function numberOrValue(value: unknown): unknown {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : value;
}

const executeSnov: IntegrationActionHandlers[string] = async ({
  config,
  action,
  inputs,
  credentials,
  connectionId,
  providerState,
  timeoutMs,
  signal,
}) => {
  const accessToken = await getSnovAccessToken(
    connectionId,
    credentials,
    timeoutMs,
  );
  return runSnov(
    config,
    action,
    inputs,
    accessToken,
    providerState,
    timeoutMs,
    signal,
  );
};

export const SNOV_HANDLERS = {
  "snov.domainSearch": executeSnov,
  "snov.databaseSearch": executeSnov,
  "snov.emailCount": executeSnov,
  "snov.findEmailsByNameDomain": executeSnov,
  "snov.companyDomainByName": executeSnov,
  "snov.linkedinProfileInfo": executeSnov,
  "snov.profileByEmail": executeSnov,
  "snov.emailVerifier": executeSnov,
} satisfies IntegrationActionHandlers;
