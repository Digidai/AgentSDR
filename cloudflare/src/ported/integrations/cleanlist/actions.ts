// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.

import { PermanentRunError } from "../../grid/runners/types";
import type { CellResult, PendingCellResult } from "../../grid/types";
import {
  asRecord,
  mapConfiguredOutputs,
  normalizeDomain,
  parseJson,
  truncate,
} from "../server/helpers";
import type {
  IntegrationActionContext,
  IntegrationActionHandlers,
} from "../server/types";

const API_BASE = "https://api.cleanlist.ai/api/v2";

const PEOPLE_FILTER_MAP = {
  titles: "titles",
  seniority: "seniority",
  managementLevels: "management_levels",
  departments: "departments",
  locationCity: "location_city",
  locationState: "location_state",
  locationCountry: "location_country",
  locations: "locations",
  companyNames: "company_names",
  companyDomains: "company_domains",
  companyHeadcount: "company_headcount",
  companyIndustries: "company_industries",
} as const;

const COMPANY_FILTER_MAP = {
  industries: "industries",
  employeeCountRanges: "employee_count_ranges",
  locations: "locations",
  names: "names",
  domains: "domains",
} as const;

const PERSON_FIELD_MAP = {
  email: "email",
  linkedinUrl: "linkedin_url",
  personId: "person_id",
  firstName: "first_name",
  lastName: "last_name",
  companyName: "company_name",
  domain: "domain",
  phone: "phone",
  quoteId: "quote_id",
} as const;

async function executeCleanlist(
  context: IntegrationActionContext,
): Promise<CellResult | PendingCellResult> {
  switch (context.action.handlerKey) {
    case "cleanlist.searchPeople":
      return runSearch(context, "people", PEOPLE_FILTER_MAP);
    case "cleanlist.searchCompanies":
      return runSearch(context, "companies", COMPANY_FILTER_MAP);
    case "cleanlist.enrichPerson":
      return enrichPerson(context);
    case "cleanlist.enrichCompany":
      return enrichCompany(context);
    default:
      throw new PermanentRunError(
        `Unknown Cleanlist action: ${context.action.handlerKey}`,
      );
  }
}

async function runSearch(
  context: IntegrationActionContext,
  entity: "people" | "companies",
  filterMap: Readonly<Record<string, string>>,
): Promise<CellResult> {
  const { config, credentials, inputs, signal, timeoutMs } = context;
  const filters = buildSearchFilters(inputs, filterMap, entity);
  const limit = parseLimit(inputs.limit);
  const cursor = optionalString(inputs.cursor, "Cursor");
  const endpoint = `/search/${entity}`;
  const request = await fetchCleanlist(
    endpoint,
    credentials.apiKey,
    timeoutMs,
    signal,
    {
      method: "POST",
      body: JSON.stringify({ filters, limit, ...(cursor ? { cursor } : {}) }),
    },
  );
  assertCleanlistResponse(request.response, request.body);

  const root = asRecord(request.body);
  const results = Array.isArray(root.results) ? root.results : [];
  const logicalOutputs = {
    [entity]: results,
    resultCount: results.length,
    total: root.total,
    cursor: root.cursor,
    taskId: root.task_id,
    truncationWarning: root.truncation_warning,
  };
  const found = results.length > 0;
  return {
    value: found ? "Found" : "Not found",
    outputs: mapConfiguredOutputs(config, logicalOutputs, request.body),
    provider: "cleanlist",
    outcome: found ? "hit" : "miss",
    costCents: 0,
    latencyMs: request.latencyMs,
    request: { method: "POST", endpoint, inputKeys: Object.keys(inputs) },
    response: truncate(request.body),
  };
}

async function enrichPerson(
  context: IntegrationActionContext,
): Promise<CellResult | PendingCellResult> {
  const {
    action,
    config,
    credentials,
    inputs,
    providerState,
    signal,
    timeoutMs,
  } = context;
  const workflowId =
    typeof providerState?.workflowId === "string"
      ? providerState.workflowId
      : null;
  const startedAt =
    typeof providerState?.startedAt === "number"
      ? providerState.startedAt
      : Date.now();
  if (Date.now() - startedAt > (action.async?.timeoutMs ?? 900_000)) {
    throw new PermanentRunError(
      "Cleanlist did not finish this person enrichment before its timeout",
    );
  }

  if (!workflowId) {
    const body = makePersonEnrichmentBody(inputs);
    const started = await fetchCleanlist(
      "/enrichment/person",
      credentials.apiKey,
      timeoutMs,
      signal,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
    assertCleanlistResponse(started.response, started.body);
    const id = asRecord(started.body).workflow_id;
    if (typeof id !== "string" || !id) {
      throw new Error("Cleanlist did not return a workflow ID");
    }
    return {
      pending: true,
      state: { workflowId: id, startedAt, pollCount: 0 },
      pollAfterMs: action.async?.pollAfterMs ?? 5000,
    };
  }

  const endpoint = `/enrichment/status/${encodeURIComponent(workflowId)}`;
  const polled = await fetchCleanlist(
    endpoint,
    credentials.apiKey,
    timeoutMs,
    signal,
  );
  assertCleanlistResponse(polled.response, polled.body);
  const root = asRecord(polled.body);
  const status = String(root.status ?? "")
    .trim()
    .toLowerCase();

  if (
    status === "failed" ||
    status === "canceled" ||
    status === "cancelled" ||
    status === "terminated"
  ) {
    throw new PermanentRunError(
      `Cleanlist person enrichment ended with status ${status}: ${cleanlistErrorMessage(polled.body, "enrichment failed")}`,
    );
  }

  if (status !== "completed" && status !== "completed_with_errors") {
    const pollCount = Number(providerState?.pollCount ?? 0) + 1;
    return {
      pending: true,
      state: { workflowId, startedAt, pollCount },
      pollAfterMs: action.async?.pollAfterMs ?? 5000,
    };
  }

  const result = asRecord(root.result);
  const resultStatus = String(result.status ?? "")
    .trim()
    .toLowerCase();
  const leadId = result.lead_id;
  const usable =
    resultStatus !== "failed" &&
    typeof leadId === "string" &&
    leadId.length > 0;
  const logicalOutputs = {
    fullName: result.full_name,
    firstName: result.first_name,
    lastName: result.last_name,
    email: result.email,
    emailStatus: result.email_status,
    phone: result.phone,
    linkedinUrl: result.linkedin_url,
    jobTitle: result.title,
    companyName: result.company,
    provider: result.provider,
    leadId,
    status: result.status,
    creditsCharged: root.credits_charged,
    result: root.result,
  };
  return {
    value: usable ? "Found" : "Not found",
    outputs: mapConfiguredOutputs(config, logicalOutputs, polled.body),
    provider: "cleanlist",
    outcome: usable ? "hit" : "miss",
    costCents: 0,
    latencyMs: polled.latencyMs,
    request: {
      method: "GET",
      endpoint: "/enrichment/status/:workflow_id",
      inputKeys: Object.keys(inputs),
    },
    response: truncate(polled.body),
  };
}

async function enrichCompany(
  context: IntegrationActionContext,
): Promise<CellResult> {
  const { config, credentials, inputs, signal, timeoutMs } = context;
  const domain = normalizeDomain(
    requiredString(inputs.domain, "Company Domain"),
  );
  const quoteId = optionalString(inputs.quoteId, "Quote ID");
  const endpoint = "/enrichment/company";
  const enriched = await fetchCleanlist(
    endpoint,
    credentials.apiKey,
    timeoutMs,
    signal,
    {
      method: "POST",
      body: JSON.stringify({
        domain,
        ...(quoteId ? { quote_id: quoteId } : {}),
      }),
    },
  );
  assertCleanlistResponse(enriched.response, enriched.body);
  const root = asRecord(enriched.body);
  const company = asRecord(root.company);
  const usable = [company.company_id, company.name, company.domain].some(
    (value) => typeof value === "string" && value.length > 0,
  );
  const logicalOutputs = {
    companyName: company.name,
    domain: company.domain,
    industry: company.industry,
    industries: company.industries,
    employeeCount: company.employee_count,
    employeeCountRange: company.employee_count_range,
    revenueRange: company.revenue_range,
    hqLocation: company.hq_location,
    fundingStage: company.funding_stage,
    totalFundingUsd: company.total_funding_usd,
    techStack: company.tech_stack,
    linkedinUrl: company.linkedin_url,
    companyId: company.company_id,
    creditsCharged: root.credits_charged,
    company: root.company,
  };
  return {
    value: usable ? "Found" : "Not found",
    outputs: mapConfiguredOutputs(config, logicalOutputs, enriched.body),
    provider: "cleanlist",
    outcome: usable ? "hit" : "miss",
    costCents: 0,
    latencyMs: enriched.latencyMs,
    request: { method: "POST", endpoint, inputKeys: Object.keys(inputs) },
    response: truncate(enriched.body),
  };
}

function buildSearchFilters(
  inputs: Record<string, unknown>,
  filterMap: Readonly<Record<string, string>>,
  entity: "people" | "companies",
): Record<string, string[]> {
  const allowedLegacyKeys = new Set(Object.values(filterMap));
  const legacyFilters = parseLegacyFilters(
    inputs.filters,
    allowedLegacyKeys,
    entity,
  );
  const explicitFilters: Record<string, string[]> = {};

  for (const [inputKey, wireKey] of Object.entries(filterMap)) {
    const values = normalizeFilterValues(
      inputs[inputKey],
      `Cleanlist ${entity} filter ${wireKey}`,
    );
    if (values) explicitFilters[wireKey] = values;
  }

  const filters = { ...legacyFilters, ...explicitFilters };
  if (Object.keys(filters).length === 0) {
    throw new PermanentRunError(
      `${capitalize(entity)} filters cannot be empty`,
    );
  }
  return filters;
}

function parseLegacyFilters(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  entity: "people" | "companies",
): Record<string, string[]> {
  if (value === undefined || value === null || value === "") return {};

  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new PermanentRunError(
        `${capitalize(entity)} filters must contain valid JSON`,
      );
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PermanentRunError(
      `${capitalize(entity)} filters must be a JSON object`,
    );
  }

  const filters = parsed as Record<string, unknown>;
  const entries = Object.entries(filters);
  if (entries.length === 0) {
    return {};
  }
  const normalized: Record<string, string[]> = {};
  for (const [key, filterValue] of entries) {
    if (!allowedKeys.has(key)) {
      throw new PermanentRunError(`Unknown Cleanlist ${entity} filter: ${key}`);
    }
    if (!Array.isArray(filterValue)) {
      throw new PermanentRunError(
        `Cleanlist ${entity} filter ${key} must be a non-empty array of non-empty strings`,
      );
    }
    const values = normalizeStringArray(
      filterValue,
      `Cleanlist ${entity} filter ${key}`,
    );
    if (!values) {
      throw new PermanentRunError(
        `Cleanlist ${entity} filter ${key} must be a non-empty array of non-empty strings`,
      );
    }
    normalized[key] = values;
  }
  return normalized;
}

function normalizeFilterValues(
  value: unknown,
  label: string,
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return normalizeStringArray(value, label);
  if (typeof value !== "string") {
    throw new PermanentRunError(
      `${label} must be text or an array of text values`,
    );
  }

  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new PermanentRunError(`${label} must contain a valid JSON array`);
    }
    if (!Array.isArray(parsed)) {
      throw new PermanentRunError(`${label} must contain a JSON array`);
    }
    return normalizeStringArray(parsed, label);
  }

  const values = trimmed
    .split(/[,\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function normalizeStringArray(
  value: unknown[],
  label: string,
): string[] | undefined {
  if (!value.every((item) => typeof item === "string")) {
    throw new PermanentRunError(`${label} must contain only text values`);
  }
  const values = value.map((item) => item.trim()).filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function parseLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") return 25;
  const limit = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new PermanentRunError(
      "Cleanlist search limit must be an integer from 1 to 500",
    );
  }
  return limit;
}

function makePersonEnrichmentBody(
  inputs: Record<string, unknown>,
): Record<string, string> {
  const leadListId = requiredString(inputs.leadListId, "Lead List ID");
  const enrichmentType =
    optionalString(inputs.enrichmentType, "Enrichment Type")?.toLowerCase() ||
    "partial";
  if (
    enrichmentType !== "partial" &&
    enrichmentType !== "phone_only" &&
    enrichmentType !== "full"
  ) {
    throw new PermanentRunError(
      "Cleanlist enrichment type must be partial, phone_only, or full",
    );
  }

  const body: Record<string, string> = {
    lead_list_id: leadListId,
    enrichment_type: enrichmentType,
  };
  for (const [inputKey, apiKey] of Object.entries(PERSON_FIELD_MAP)) {
    const value = optionalString(inputs[inputKey], inputKey);
    if (value)
      body[apiKey] = apiKey === "domain" ? normalizeDomain(value) : value;
  }

  const hasStrongIdentifier = Boolean(
    body.email || body.linkedin_url || body.person_id,
  );
  const hasNameAndCompany = Boolean(
    body.first_name && body.last_name && (body.company_name || body.domain),
  );
  if (!hasStrongIdentifier && !hasNameAndCompany) {
    throw new PermanentRunError(
      "Cleanlist person enrichment requires email, LinkedIn URL, or person ID; alternatively provide first name, last name, and company name or domain",
    );
  }
  return body;
}

function requiredString(value: unknown, label: string): string {
  const parsed = optionalString(value, label);
  if (!parsed) throw new PermanentRunError(`${label}: A value is required`);
  return parsed;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string")
    throw new PermanentRunError(`${label} must be text`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

async function fetchCleanlist(
  endpoint: string,
  apiKey: string,
  timeoutMs: number,
  outerSignal?: AbortSignal,
  init: RequestInit = {},
): Promise<{ response: Response; body: unknown; latencyMs: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  if (outerSignal?.aborted) controller.abort();
  else outerSignal?.addEventListener("abort", onOuterAbort);
  const started = Date.now();
  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await response.text();
    return { response, body: parseJson(text), latencyMs: Date.now() - started };
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      if (outerSignal?.aborted)
        throw new Error("Cleanlist request was aborted");
      throw new Error(`Cleanlist request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}

function assertCleanlistResponse(response: Response, body: unknown): void {
  if (response.ok) return;
  const message = `Cleanlist returned ${response.status}: ${cleanlistErrorMessage(body, "request failed")}`;
  if (response.status === 429 || response.status >= 500)
    throw new Error(message);
  throw new PermanentRunError(message);
}

function cleanlistErrorMessage(body: unknown, fallback: string): string {
  const root = asRecord(body);
  const error = asRecord(root.error);
  const direct = [
    error.problem,
    error.message,
    error.fix,
    root.problem,
    root.message,
  ].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (direct.length > 0) return direct.join(" ").slice(0, 500);

  if (Array.isArray(root.detail)) {
    const details = root.detail.flatMap((item) => {
      const issue = asRecord(item);
      const message = typeof issue.msg === "string" ? issue.msg : null;
      const location = Array.isArray(issue.loc)
        ? issue.loc.map(String).join(".")
        : null;
      return message ? [`${location ? `${location}: ` : ""}${message}`] : [];
    });
    if (details.length > 0) return details.join("; ").slice(0, 500);
  }
  return fallback.slice(0, 500);
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export const CLEANLIST_HANDLERS = {
  "cleanlist.searchPeople": executeCleanlist,
  "cleanlist.searchCompanies": executeCleanlist,
  "cleanlist.enrichPerson": executeCleanlist,
  "cleanlist.enrichCompany": executeCleanlist,
} satisfies IntegrationActionHandlers;
