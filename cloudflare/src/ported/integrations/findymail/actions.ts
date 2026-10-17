// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.

import { PermanentRunError } from "../../grid/runners/types";
import type { CellResult } from "../../grid/types";
import {
  asRecord,
  errorMessage,
  mapConfiguredOutputs,
  normalizeDomain,
  parseJson,
  truncate,
} from "../server/helpers";
import type {
  IntegrationActionContext,
  IntegrationActionHandlers,
} from "../server/types";

const API_BASE = "https://app.findymail.com/api";

async function executeFindymail(
  context: IntegrationActionContext,
): Promise<CellResult> {
  const { action, config, credentials, inputs, signal, timeoutMs } = context;
  let endpoint: string;
  let requestBody: Record<string, unknown>;
  if (action.handlerKey === "findymail.validateEmail") {
    endpoint = "/verify";
    requestBody = { email: inputs.email };
  } else if (action.handlerKey === "findymail.workEmailFromProfileUrl") {
    endpoint = "/search/business-profile";
    requestBody = { linkedin_url: inputs.linkedinUrl };
  } else if (action.handlerKey === "findymail.findWorkEmail") {
    endpoint = "/search/name";
    requestBody = {
      name: inputs.fullName,
      domain: normalizeDomain(String(inputs.companyDomain)),
    };
  } else if (action.handlerKey === "findymail.findMobilePhone") {
    endpoint = "/search/phone";
    requestBody = { linkedin_url: inputs.linkedinUrl };
  } else {
    throw new PermanentRunError(
      `Unknown Findymail action: ${action.handlerKey}`,
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort);
  const started = Date.now();
  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credentials.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await response.text();
    const body = parseJson(text);
    const root = asRecord(body);
    if (!response.ok || root.error) {
      const message = `Findymail returned ${response.status}: ${errorMessage(body, "request failed")}`;
      if (response.status === 429 || response.status >= 500)
        throw new Error(message);
      throw new PermanentRunError(message);
    }

    const contact = asRecord(root.contact);
    let logicalOutputs: Record<string, unknown>;
    let primary: unknown;
    if (action.handlerKey === "findymail.validateEmail") {
      logicalOutputs = {
        email: root.email,
        verified: root.verified,
        provider: root.provider,
      };
      primary =
        typeof root.verified === "boolean"
          ? root.verified
            ? "Valid"
            : "Invalid"
          : undefined;
    } else if (action.handlerKey === "findymail.findMobilePhone") {
      logicalOutputs = { phone: root.phone, lineType: root.line_type };
      primary = root.phone;
    } else {
      logicalOutputs = {
        email: contact.email,
        fullName: contact.name,
        companyDomain: contact.domain,
      };
      primary = contact.email;
    }
    const found = primary !== null && primary !== undefined && primary !== "";
    return {
      value: found ? String(primary) : "Not found",
      outputs: mapConfiguredOutputs(config, logicalOutputs, body),
      provider: "findymail",
      outcome: found ? "hit" : "miss",
      costCents: 0,
      latencyMs: Date.now() - started,
      request: { method: "POST", endpoint, inputKeys: Object.keys(inputs) },
      response: truncate(body),
    };
  } catch (error) {
    if (error instanceof PermanentRunError) throw error;
    if ((error as Error).name === "AbortError") {
      throw new Error(`Findymail request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

export const FINDYMAIL_HANDLERS = {
  "findymail.validateEmail": executeFindymail,
  "findymail.workEmailFromProfileUrl": executeFindymail,
  "findymail.findWorkEmail": executeFindymail,
  "findymail.findMobilePhone": executeFindymail,
} satisfies IntegrationActionHandlers;
