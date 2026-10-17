// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.

import { PermanentRunError } from "../../grid/runners/types";
import type { CellResult } from "../../grid/types";
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

const API_BASE = "https://api.lusha.com";

const COMPANY_SIGNAL_TYPES: Readonly<Record<string, string[]>> = {
  "lusha.companyWebsiteTrafficSignal": [
    "websiteTrafficIncrease",
    "websiteTrafficDecrease",
  ],
  "lusha.companyItSpendSignal": ["itSpendIncrease", "itSpendDecrease"],
  "lusha.companyJobsGrowthByLocationSignal": ["surgeInHiringByLocation"],
  "lusha.companyJobsGrowthByDepartmentSignal": ["surgeInHiringByDepartment"],
  "lusha.companyJobsGrowthSignal": ["surgeInHiring"],
  "lusha.companyHeadcountGrowthSignal": [
    "headcountIncrease1m",
    "headcountIncrease3m",
    "headcountIncrease6m",
    "headcountIncrease12m",
    "headcountDecrease1m",
    "headcountDecrease3m",
    "headcountDecrease6m",
    "headcountDecrease12m",
  ],
  "lusha.companyNewsSignal": [
    "riskNews",
    "commercialActivityNews",
    "corporateStrategyNews",
    "financialEventsNews",
    "peopleNews",
    "marketIntelligenceNews",
    "productActivityNews",
  ],
};

type LushaResponse = { body: unknown; latencyMs: number };

function errorText(body: unknown): string {
  const root = asRecord(body);
  const errors = Array.isArray(root.errors) ? root.errors : [];
  const first = asRecord(errors[0]);
  for (const value of [root.message, first.message, first.detail, first.code]) {
    if (typeof value === "string" && value) return value.slice(0, 300);
  }
  return "request failed";
}

async function postLusha(
  endpoint: string,
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Promise<LushaResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  outerSignal?.addEventListener("abort", onOuterAbort);
  const started = Date.now();
  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        api_key: apiKey,
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = parseJson(text);
    if (!response.ok) {
      const message = `Lusha returned ${response.status}: ${errorText(parsed)}`;
      if (response.status === 429 || response.status >= 500)
        throw new Error(message);
      throw new PermanentRunError(message);
    }
    return { body: parsed, latencyMs: Date.now() - started };
  } catch (error) {
    if (error instanceof PermanentRunError) throw error;
    if ((error as Error).name === "AbortError")
      throw new Error(`Lusha request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}

function firstResult(body: unknown): Record<string, unknown> {
  const results = asRecord(body).results;
  return Array.isArray(results) ? asRecord(results[0]) : {};
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (!Array.isArray(value)) return undefined;
  const first = value.find(
    (entry) =>
      typeof entry === "string" || (entry && typeof entry === "object"),
  );
  if (typeof first === "string") return first;
  const record = asRecord(first);
  for (const candidate of [
    record.email,
    record.address,
    record.value,
    record.number,
    record.phone,
  ]) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return undefined;
}

function collectSignals(
  result: Record<string, unknown>,
  signalTypes: readonly string[],
): unknown[] {
  return signalTypes.flatMap((signalType) => {
    const events = result[signalType];
    if (!Array.isArray(events)) return [];
    return events.map((event) => ({ signalType, ...asRecord(event) }));
  });
}

async function resolveCompanyId(
  context: IntegrationActionContext,
): Promise<{
  id: string | null;
  company: Record<string, unknown>;
  response: unknown;
  latencyMs: number;
}> {
  const response = await postLusha(
    "/v3/companies/search",
    context.credentials.apiKey,
    {
      companies: [
        { domain: normalizeDomain(String(context.inputs.companyDomain)) },
      ],
      options: { includePartialProfiles: true },
    },
    context.timeoutMs,
    context.signal,
  );
  const company = firstResult(response.body);
  const id =
    typeof company.id === "string" || typeof company.id === "number"
      ? String(company.id)
      : null;
  return {
    id,
    company,
    response: response.body,
    latencyMs: response.latencyMs,
  };
}

async function executeCompanySignal(
  context: IntegrationActionContext,
): Promise<CellResult> {
  const signalTypes = COMPANY_SIGNAL_TYPES[context.action.handlerKey];
  if (!signalTypes)
    throw new PermanentRunError(
      `Unknown Lusha company signal action: ${context.action.handlerKey}`,
    );
  const resolved = await resolveCompanyId(context);
  if (!resolved.id) {
    return miss(
      context,
      "/v3/companies/search",
      resolved.response,
      resolved.latencyMs,
    );
  }

  const signalResponse = await postLusha(
    "/v3/companies/signals",
    context.credentials.apiKey,
    {
      ids: [resolved.id],
      signalTypes,
      ...(context.inputs.startDate
        ? { startDate: String(context.inputs.startDate) }
        : {}),
      maxResultsPerSignal: 10,
    },
    context.timeoutMs,
    context.signal,
  );
  const result = firstResult(signalResponse.body);
  const signals = collectSignals(result, signalTypes);
  const outputs = {
    signals,
    signalCount: signals.length,
    companyName:
      result.companyName ??
      resolved.company.name ??
      resolved.company.companyName,
    companyDomain: result.domain ?? resolved.company.domain,
  };
  return finish(
    context,
    "/v3/companies/signals",
    signalResponse.body,
    outputs,
    signals.length
      ? `${signals.length} signal${signals.length === 1 ? "" : "s"}`
      : undefined,
    resolved.latencyMs + signalResponse.latencyMs,
  );
}

async function executeEnrichCompany(
  context: IntegrationActionContext,
): Promise<CellResult> {
  const response = await postLusha(
    "/v3/companies/search-and-enrich",
    context.credentials.apiKey,
    {
      companies: [
        { domain: normalizeDomain(String(context.inputs.companyDomain)) },
      ],
      options: { includePartialProfiles: true },
    },
    context.timeoutMs,
    context.signal,
  );
  const company = firstResult(response.body);
  const employeeCount = asRecord(company.employeeCount);
  const socialLinks = asRecord(company.socialLinks);
  const domain = company.domain;
  const outputs = {
    companyName: company.name ?? company.companyName,
    companyDomain: domain,
    website:
      company.website ??
      company.websiteUrl ??
      (typeof domain === "string" ? `https://${domain}` : undefined),
    industry: company.industry ?? company.industryLabel,
    employeeCount:
      employeeCount.exact ?? employeeCount.max ?? company.employees,
    linkedinUrl: socialLinks.linkedin ?? company.linkedinUrl,
    company,
  };
  return finish(
    context,
    "/v3/companies/search-and-enrich",
    response.body,
    outputs,
    outputs.companyName,
    response.latencyMs,
  );
}

async function resolveContactId(
  context: IntegrationActionContext,
): Promise<{
  id: string | null;
  contact: Record<string, unknown>;
  response: unknown;
  latencyMs: number;
}> {
  const response = await postLusha(
    "/v3/contacts/search",
    context.credentials.apiKey,
    {
      contacts: [{ linkedinUrl: context.inputs.linkedinUrl }],
      options: { includePartialProfiles: true },
    },
    context.timeoutMs,
    context.signal,
  );
  const contact = firstResult(response.body);
  const id =
    typeof contact.id === "string" || typeof contact.id === "number"
      ? String(contact.id)
      : null;
  return {
    id,
    contact,
    response: response.body,
    latencyMs: response.latencyMs,
  };
}

async function executePersonSignals(
  context: IntegrationActionContext,
): Promise<CellResult> {
  const resolved = await resolveContactId(context);
  if (!resolved.id)
    return miss(
      context,
      "/v3/contacts/search",
      resolved.response,
      resolved.latencyMs,
    );
  const signalTypes = ["promotion", "companyChange"];
  const signalResponse = await postLusha(
    "/v3/contacts/signals",
    context.credentials.apiKey,
    {
      ids: [resolved.id],
      signalTypes,
      ...(context.inputs.startDate
        ? { startDate: String(context.inputs.startDate) }
        : {}),
      maxResultsPerSignal: 10,
    },
    context.timeoutMs,
    context.signal,
  );
  const result = firstResult(signalResponse.body);
  const signals = collectSignals(result, signalTypes);
  const fullName =
    result.fullName ??
    resolved.contact.fullName ??
    [resolved.contact.firstName, resolved.contact.lastName]
      .filter(Boolean)
      .join(" ");
  return finish(
    context,
    "/v3/contacts/signals",
    signalResponse.body,
    { signals, signalCount: signals.length, fullName },
    signals.length
      ? `${signals.length} signal${signals.length === 1 ? "" : "s"}`
      : undefined,
    resolved.latencyMs + signalResponse.latencyMs,
  );
}

async function executeEnrichPerson(
  context: IntegrationActionContext,
): Promise<CellResult> {
  const response = await postLusha(
    "/v3/contacts/search-and-enrich",
    context.credentials.apiKey,
    {
      contacts: [{ linkedinUrl: context.inputs.linkedinUrl }],
      reveal: ["emails", "phones"],
      options: { includePartialProfiles: true },
    },
    context.timeoutMs,
    context.signal,
  );
  const person = firstResult(response.body);
  const nestedJobTitle = asRecord(person.jobTitle).title;
  const fullName =
    person.fullName ??
    [person.firstName, person.lastName].filter(Boolean).join(" ");
  const outputs = {
    fullName,
    workEmail: firstString(person.emails) ?? firstString(person.email),
    phoneNumber:
      firstString(person.phones) ??
      firstString(person.phoneNumbers) ??
      firstString(person.phone),
    jobTitle:
      typeof person.jobTitle === "string"
        ? person.jobTitle
        : (nestedJobTitle ?? person.title),
    companyName: person.companyName ?? asRecord(person.company).name,
    linkedinUrl: person.linkedinUrl ?? context.inputs.linkedinUrl,
    person,
  };
  return finish(
    context,
    "/v3/contacts/search-and-enrich",
    response.body,
    outputs,
    fullName,
    response.latencyMs,
  );
}

function finish(
  context: IntegrationActionContext,
  endpoint: string,
  response: unknown,
  outputs: Record<string, unknown>,
  primary: unknown,
  latencyMs: number,
): CellResult {
  const found = primary !== null && primary !== undefined && primary !== "";
  return {
    value: found ? String(primary) : "Not found",
    outputs: mapConfiguredOutputs(context.config, outputs, response),
    provider: "lusha",
    outcome: found ? "hit" : "miss",
    costCents: 0,
    latencyMs,
    request: {
      method: "POST",
      endpoint,
      inputKeys: Object.keys(context.inputs),
    },
    response: truncate(response),
  };
}

function miss(
  context: IntegrationActionContext,
  endpoint: string,
  response: unknown,
  latencyMs: number,
): CellResult {
  return finish(context, endpoint, response, {}, undefined, latencyMs);
}

export const LUSHA_HANDLERS = {
  "lusha.companyWebsiteTrafficSignal": executeCompanySignal,
  "lusha.companyItSpendSignal": executeCompanySignal,
  "lusha.companyJobsGrowthByLocationSignal": executeCompanySignal,
  "lusha.companyJobsGrowthByDepartmentSignal": executeCompanySignal,
  "lusha.companyJobsGrowthSignal": executeCompanySignal,
  "lusha.companyHeadcountGrowthSignal": executeCompanySignal,
  "lusha.companyNewsSignal": executeCompanySignal,
  "lusha.enrichCompany": executeEnrichCompany,
  "lusha.findPersonSignals": executePersonSignals,
  "lusha.enrichPerson": executeEnrichPerson,
} satisfies IntegrationActionHandlers;
