// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.

import type { CellResult, EnrichmentConfig } from "../../grid/types";
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

const API_BASE = "https://app.icypeas.com/api";
const PENDING = new Set(["NONE", "SCHEDULED", "IN_PROGRESS"]);
const FAILED = new Set(["BAD_INPUT", "INSUFFICIENT_FUNDS", "ABORTED"]);
const NOT_FOUND = new Set(["NOT_FOUND", "DEBITED_NOT_FOUND"]);

async function request(
  path: string,
  apiKey: string,
  timeoutMs: number,
  signal: AbortSignal,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
    cache: "no-store",
  });
  const text = await response.text();
  const payload = parseJson(text);
  const root = asRecord(payload);
  if (!response.ok || root.success === false) {
    const message = `Icypeas returned ${response.status}: ${errorMessage(payload, text || "request failed")}`;
    if (
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 429
    )
      throw new PermanentRunError(message);
    throw new Error(message);
  }
  return payload;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function runAsyncSearch(
  path: string,
  body: Record<string, unknown>,
  apiKey: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const started = asRecord(
    await request(path, apiKey, timeoutMs, signal, body),
  );
  const item = asRecord(started.item);
  const id = String(item._id ?? started._id ?? "");
  if (!id) throw new Error("Icypeas did not return a search ID");
  const deadline = Date.now() + timeoutMs - 1_000;
  while (Date.now() < deadline) {
    await delay(1_000, signal);
    const fetched = asRecord(
      await request("/bulk-single-searchs/read", apiKey, timeoutMs, signal, {
        id,
      }),
    );
    const resultItem = Array.isArray(fetched.items)
      ? asRecord(fetched.items[0])
      : asRecord(fetched.item);
    const status = String(resultItem.status ?? "").toUpperCase();
    if (PENDING.has(status)) continue;
    if (FAILED.has(status))
      throw new PermanentRunError(
        `Icypeas search ended with ${status.toLowerCase().replaceAll("_", " ")}`,
      );
    return resultItem;
  }
  throw new Error(`Icypeas search did not finish within ${timeoutMs}ms`);
}

function resultRecord(body: unknown): Record<string, unknown> {
  const root = asRecord(body);
  return asRecord(
    root.results ?? root.result ?? root.item ?? root.data ?? root,
  );
}

function formatLocation(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  const address = asRecord(value);
  const parts = [
    address.streetAddress,
    address.addressLocality,
    address.addressRegion,
    address.postalCode,
    address.addressCountry,
    address.addressCountryCode,
  ].filter(
    (part): part is string | number =>
      (typeof part === "string" && part.trim().length > 0) ||
      typeof part === "number",
  );
  return parts.length > 0
    ? [...new Set(parts.map(String))].join(", ")
    : undefined;
}

async function runIcypeas(
  config: EnrichmentConfig,
  action: IntegrationActionDefinition,
  inputs: Record<string, unknown>,
  apiKey: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CellResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  const started = Date.now();
  let endpoint = "";
  try {
    let body: unknown;
    if (action.handlerKey === "icypeas.verifyEmail") {
      endpoint = "/email-verification";
      body = await runAsyncSearch(
        endpoint,
        { email: String(inputs.email) },
        apiKey,
        timeoutMs,
        controller.signal,
      );
    } else if (action.handlerKey === "icypeas.findWorkEmail") {
      endpoint = "/email-search";
      body = await runAsyncSearch(
        endpoint,
        {
          firstname: String(inputs.firstName),
          lastname: String(inputs.lastName),
          domainOrCompany: String(inputs.company),
        },
        apiKey,
        timeoutMs,
        controller.signal,
      );
    } else if (action.handlerKey === "icypeas.findEmailsForDomain") {
      endpoint = "/domain-search";
      body = await runAsyncSearch(
        endpoint,
        { domainOrCompany: normalizeDomain(String(inputs.domain)) },
        apiKey,
        timeoutMs,
        controller.signal,
      );
    } else if (action.handlerKey === "icypeas.findProfessionalProfile") {
      endpoint = "/url-search/profile";
      body = await request(endpoint, apiKey, timeoutMs, controller.signal, {
        firstname: String(inputs.firstName),
        lastname: String(inputs.lastName),
        companyOrDomain: String(inputs.company),
      });
    } else if (action.handlerKey === "icypeas.findCompanyProfessionalProfile") {
      endpoint = "/url-search/company";
      body = await request(endpoint, apiKey, timeoutMs, controller.signal, {
        companyOrDomain: String(inputs.company),
      });
    } else if (action.handlerKey === "icypeas.findPeopleAtCompany") {
      endpoint = "/find-people";
      body = await request(endpoint, apiKey, timeoutMs, controller.signal, {
        query: {
          currentCompanyId: {
            include: [normalizeDomain(String(inputs.domain))],
          },
        },
        pagination: { size: 25 },
      });
    } else if (action.handlerKey === "icypeas.enrichProfile") {
      endpoint = `/scrape/profile?url=${encodeURIComponent(String(inputs.profileUrl))}`;
      body = await request(endpoint, apiKey, timeoutMs, controller.signal);
    } else if (action.handlerKey === "icypeas.enrichCompany") {
      endpoint = `/scrape/company?url=${encodeURIComponent(String(inputs.profileUrl))}`;
      body = await request(endpoint, apiKey, timeoutMs, controller.signal);
    } else
      throw new PermanentRunError(
        `Unknown Icypeas action: ${action.handlerKey}`,
      );

    const root = asRecord(body);
    const result = resultRecord(body);
    const emails = Array.isArray(result.emails)
      ? result.emails.map(asRecord)
      : [];
    const leads = Array.isArray(root.leads) ? root.leads : [];
    let logicalOutputs: Record<string, unknown>;
    if (action.handlerKey === "icypeas.verifyEmail")
      logicalOutputs = {
        email: result.email ?? inputs.email,
        status: result.status ?? root.status,
        certainty: result.certainty,
        details: result,
      };
    else if (action.handlerKey === "icypeas.findWorkEmail") {
      const first = emails[0] ?? {};
      logicalOutputs = {
        email: first.email,
        certainty: first.certainty,
        mxProvider: first.mxProvider,
      };
    } else if (action.handlerKey === "icypeas.findEmailsForDomain")
      logicalOutputs = { emails, resultCount: emails.length };
    else if (action.handlerKey === "icypeas.findPeopleAtCompany")
      logicalOutputs = { people: leads, resultCount: leads.length };
    else if (
      action.handlerKey === "icypeas.findProfessionalProfile" ||
      action.handlerKey === "icypeas.findCompanyProfessionalProfile"
    )
      logicalOutputs = {
        profileUrl:
          root.url ??
          root.profileUrl ??
          root.linkedinUrl ??
          result.url ??
          result.profileUrl ??
          result.linkedinUrl,
      };
    else if (action.handlerKey === "icypeas.enrichProfile")
      logicalOutputs = {
        fullName: result.fullname ?? result.fullName ?? result.name,
        jobTitle: result.jobTitle ?? result.currentJobTitle ?? result.title,
        companyName: result.companyName ?? result.currentCompanyName,
        location: result.location,
        profile: result,
      };
    else
      logicalOutputs = {
        companyName: result.name ?? result.companyName,
        domain: result.domain ?? result.website,
        industry: result.industry,
        employeeCount: result.numberOfEmployees ?? result.headcount,
        location: formatLocation(result.address ?? result.location),
        company: result,
      };
    const terminalStatus = String(
      root.status ?? result.status ?? "",
    ).toUpperCase();
    const resultHasData = Object.keys(result).some(
      (key) => !["status", "success"].includes(key),
    );
    let found: boolean;
    if (action.handlerKey === "icypeas.verifyEmail")
      found = !NOT_FOUND.has(terminalStatus) && resultHasData;
    else if (
      action.handlerKey === "icypeas.findWorkEmail" ||
      action.handlerKey === "icypeas.findEmailsForDomain"
    )
      found = emails.length > 0;
    else if (action.handlerKey === "icypeas.findPeopleAtCompany")
      found = leads.length > 0;
    else if (
      action.handlerKey === "icypeas.findProfessionalProfile" ||
      action.handlerKey === "icypeas.findCompanyProfessionalProfile"
    )
      found = Boolean(logicalOutputs.profileUrl);
    else found = resultHasData;
    return {
      value: found ? "Found" : "Not found",
      outputs: mapConfiguredOutputs(config, logicalOutputs, body),
      provider: "icypeas",
      outcome: found ? "hit" : "miss",
      costCents: 0,
      latencyMs: Date.now() - started,
      request: {
        method: endpoint.startsWith("/scrape/") ? "GET" : "POST",
        endpoint: endpoint.split("?")[0],
        inputKeys: Object.keys(inputs),
      },
      response: truncate(body),
    };
  } catch (error) {
    if (error instanceof PermanentRunError) throw error;
    if ((error as Error).name === "AbortError")
      throw new Error(`Icypeas request timed out after ${timeoutMs}ms`);
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
  timeoutMs,
  signal,
}) => runIcypeas(config, action, inputs, credentials.apiKey, timeoutMs, signal);
export const ICYPEAS_HANDLERS: IntegrationActionHandlers = {
  "icypeas.verifyEmail": execute,
  "icypeas.findProfessionalProfile": execute,
  "icypeas.findPeopleAtCompany": execute,
  "icypeas.findEmailsForDomain": execute,
  "icypeas.findWorkEmail": execute,
  "icypeas.findCompanyProfessionalProfile": execute,
  "icypeas.enrichProfile": execute,
  "icypeas.enrichCompany": execute,
};
