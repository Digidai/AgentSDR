// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.

import type {
  CellResult,
  EnrichmentConfig,
  PendingCellResult,
} from "../../grid/types";
import { PermanentRunError } from "../../grid/runners/types";
import type { IntegrationActionDefinition } from "../types";
import type { IntegrationActionHandlers } from "../server/types";
import {
  asRecord,
  errorMessage,
  mapConfiguredOutputs,
  normalizeDomain,
  parseJson,
  truncate,
} from "../server/helpers";

const API_BASE = "https://api.rocketreach.co/api/v2";

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function personParams(
  handlerKey: string,
  linkedinUrl: string,
): URLSearchParams {
  const params = new URLSearchParams({
    linkedin_url: linkedinUrl,
    return_cached_emails: "true",
  });
  if (
    handlerKey === "rocketreach.findProfessionalEmail" ||
    handlerKey === "rocketreach.findPersonalEmail"
  )
    params.set("lookup_type", "standard");
  else if (handlerKey === "rocketreach.findPhoneNumber")
    params.set("lookup_type", "phone");
  else if (handlerKey === "rocketreach.enrichPerson")
    params.set("lookup_type", "enrich");
  else throw new PermanentRunError(`Unknown RocketReach action: ${handlerKey}`);
  return params;
}

async function requestRocketReach(
  url: URL,
  apiKey: string,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json", "Api-Key": apiKey },
    signal,
    cache: "no-store",
  });
  const text = await response.text();
  const body = parseJson(text);
  if (!response.ok) {
    const message = `RocketReach returned ${response.status}: ${errorMessage(body, text || "request failed")}`;
    if (
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 429
    )
      throw new PermanentRunError(message);
    throw new Error(message);
  }
  return body;
}

function firstRecord(body: unknown): Record<string, unknown> {
  return Array.isArray(body) ? asRecord(body[0]) : asRecord(body);
}

function pendingStatus(value: unknown): boolean {
  return ["not queued", "progress", "searching", "waiting"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

function yearNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const match = String(value ?? "").match(/^\d{4}/);
  return match ? Number(match[0]) : undefined;
}

async function runRocketReach(
  config: EnrichmentConfig,
  action: IntegrationActionDefinition,
  inputs: Record<string, unknown>,
  apiKey: string,
  providerState: Record<string, unknown> | null | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CellResult | PendingCellResult> {
  const company = action.handlerKey === "rocketreach.enrichCompany";
  const profileId = providerState?.profileId;
  const polling =
    !company &&
    (typeof profileId === "number" || typeof profileId === "string");
  const endpoint = company
    ? "/company/lookup/"
    : polling
      ? "/person/checkStatus"
      : "/person/lookup";
  const url = new URL(`${API_BASE}${endpoint}`);
  if (company)
    url.searchParams.set("domain", normalizeDomain(String(inputs.domain)));
  else if (polling) url.searchParams.append("ids", String(profileId));
  else
    for (const [key, value] of personParams(
      action.handlerKey,
      String(inputs.linkedinUrl),
    ))
      url.searchParams.set(key, value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  const started = Date.now();
  try {
    const body = await requestRocketReach(url, apiKey, controller.signal);
    const root = firstRecord(body);
    const status = String(root.status ?? "")
      .trim()
      .toLowerCase();
    if (!company && pendingStatus(status)) {
      const id = root.id ?? profileId;
      if (typeof id !== "number" && typeof id !== "string") {
        throw new Error(
          "RocketReach returned a pending lookup without a profile ID",
        );
      }
      const startedAt =
        typeof providerState?.startedAt === "number"
          ? providerState.startedAt
          : Date.now();
      if (Date.now() - startedAt > (action.async?.timeoutMs ?? 300_000)) {
        throw new PermanentRunError(
          "RocketReach did not finish this lookup before its timeout",
        );
      }
      return {
        pending: true,
        state: {
          profileId: id,
          startedAt,
          pollCount: Number(providerState?.pollCount ?? 0) + 1,
        },
        pollAfterMs: action.async?.pollAfterMs ?? 3000,
      };
    }
    if (!company && status === "failed")
      throw new PermanentRunError("RocketReach person lookup failed");
    const emails = asRecords(root.emails);
    const phones = asRecords(root.phones);
    const professionalEmails = emails.filter((item) =>
      /professional|work/i.test(String(item.type ?? "")),
    );
    const personalEmails = emails.filter((item) =>
      /personal/i.test(String(item.type ?? "")),
    );
    let logicalOutputs: Record<string, unknown>;
    if (action.handlerKey === "rocketreach.findProfessionalEmail")
      logicalOutputs = {
        email:
          root.recommended_professional_email ??
          root.current_work_email ??
          professionalEmails[0]?.email,
        emails: professionalEmails,
      };
    else if (action.handlerKey === "rocketreach.findPersonalEmail")
      logicalOutputs = {
        email:
          root.recommended_personal_email ??
          root.current_personal_email ??
          personalEmails[0]?.email,
        emails: personalEmails,
      };
    else if (action.handlerKey === "rocketreach.findPhoneNumber")
      logicalOutputs = {
        phoneNumber:
          phones.find((item) => item.recommended === true)?.e164 ??
          phones[0]?.e164 ??
          phones[0]?.number,
        phoneNumbers: phones,
      };
    else if (action.handlerKey === "rocketreach.enrichPerson")
      logicalOutputs = {
        name: root.name,
        jobTitle: root.current_title,
        companyName: root.current_employer,
        companyDomain: root.current_employer_domain,
        location: root.location,
        linkedinUrl: root.linkedin_url,
        profile: root,
      };
    else if (company)
      logicalOutputs = {
        companyName: root.name,
        domain: root.domain ?? root.website_domain,
        industry: root.industry,
        employeeCount: root.num_employees,
        revenue: root.revenue,
        yearFounded: yearNumber(root.year_founded),
        technologies: root.techstack,
        company: root,
      };
    else
      throw new PermanentRunError(
        `Unknown RocketReach action: ${action.handlerKey}`,
      );
    const found = Object.values(logicalOutputs).some(
      (value) =>
        value !== null &&
        value !== undefined &&
        value !== "" &&
        (!Array.isArray(value) || value.length > 0),
    );
    return {
      value: found ? "Found" : "Not found",
      outputs: mapConfiguredOutputs(config, logicalOutputs, body),
      provider: "rocketreach",
      outcome: found ? "hit" : "miss",
      costCents: 0,
      latencyMs: Date.now() - started,
      request: { method: "GET", endpoint, inputKeys: Object.keys(inputs) },
      response: truncate(body),
    };
  } catch (error) {
    if (error instanceof PermanentRunError) throw error;
    if ((error as Error).name === "AbortError")
      throw new Error(`RocketReach request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

const execute: IntegrationActionHandlers[string] = ({
  config,
  action,
  inputs,
  credentials,
  providerState,
  timeoutMs,
  signal,
}) =>
  runRocketReach(
    config,
    action,
    inputs,
    credentials.apiKey,
    providerState,
    timeoutMs,
    signal,
  );
export const ROCKETREACH_HANDLERS: IntegrationActionHandlers = {
  "rocketreach.findProfessionalEmail": execute,
  "rocketreach.findPersonalEmail": execute,
  "rocketreach.findPhoneNumber": execute,
  "rocketreach.enrichPerson": execute,
  "rocketreach.enrichCompany": execute,
};
