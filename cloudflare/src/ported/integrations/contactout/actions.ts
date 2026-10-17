// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.

import { PermanentRunError } from "../../grid/runners/types";
import type { CellResult } from "../../grid/types";
import {
  asRecord,
  errorMessage,
  mapConfiguredOutputs,
  parseJson,
  truncate,
} from "../server/helpers";
import type {
  IntegrationActionContext,
  IntegrationActionHandlers,
} from "../server/types";

const API_BASE = "https://api.contactout.com/v1";

async function executeContactOut(
  context: IntegrationActionContext,
): Promise<CellResult> {
  const { action, config, credentials, inputs, signal, timeoutMs } = context;
  const url = new URL(API_BASE);
  if (action.handlerKey === "contactout.professionalUrlFromPersonalEmail") {
    url.pathname = "/v1/people/person";
    url.searchParams.set("email", String(inputs.email));
  } else if (action.handlerKey === "contactout.mobileNumberFromLinkedIn") {
    url.pathname = "/v1/people/linkedin";
    url.searchParams.set("profile", String(inputs.linkedinUrl));
    url.searchParams.set("include_phone", "true");
    url.searchParams.set("email_type", "none");
  } else if (action.handlerKey === "contactout.personalEmailFromLinkedIn") {
    url.pathname = "/v1/people/linkedin";
    url.searchParams.set("profile", String(inputs.linkedinUrl));
    url.searchParams.set("include_phone", "false");
    url.searchParams.set("email_type", "personal");
  } else {
    throw new PermanentRunError(
      `Unknown ContactOut action: ${action.handlerKey}`,
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        token: credentials.apiKey,
      },
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await response.text();
    const body = parseJson(text);
    const root = asRecord(body);
    const statusCode =
      typeof root.status_code === "number" ? root.status_code : response.status;
    if (response.status === 404 || statusCode === 404) {
      return {
        value: "Not found",
        outputs: mapConfiguredOutputs(config, {}, body),
        provider: "contactout",
        outcome: "miss",
        costCents: 0,
        latencyMs: Date.now() - started,
        request: {
          method: "GET",
          endpoint: url.pathname,
          inputKeys: Object.keys(inputs),
        },
        response: truncate(body),
      };
    }
    if (!response.ok || statusCode >= 400) {
      const message = `ContactOut returned ${statusCode}: ${errorMessage(body, "request failed")}`;
      if (statusCode >= 400 && statusCode < 500 && statusCode !== 429)
        throw new PermanentRunError(message);
      throw new Error(message);
    }

    const profile = asRecord(root.profile);
    const personalEmails = stringList(profile.personal_email);
    const phoneNumbers = stringList(profile.phone);
    const logicalOutputs =
      action.handlerKey === "contactout.professionalUrlFromPersonalEmail"
        ? { linkedinUrl: profile.linkedin, email: profile.email }
        : action.handlerKey === "contactout.mobileNumberFromLinkedIn"
          ? { mobileNumber: phoneNumbers[0], phoneNumbers }
          : { personalEmail: personalEmails[0], personalEmails };
    const primary = Object.values(logicalOutputs).find(
      (value) =>
        value !== null &&
        value !== undefined &&
        value !== "" &&
        (!Array.isArray(value) || value.length),
    );
    return {
      value: primary
        ? String(Array.isArray(primary) ? primary[0] : primary)
        : "Not found",
      outputs: mapConfiguredOutputs(config, logicalOutputs, body),
      provider: "contactout",
      outcome: primary ? "hit" : "miss",
      costCents: 0,
      latencyMs: Date.now() - started,
      request: {
        method: "GET",
        endpoint: url.pathname,
        inputKeys: Object.keys(inputs),
      },
      response: truncate(body),
    };
  } catch (error) {
    if (error instanceof PermanentRunError) throw error;
    if ((error as Error).name === "AbortError") {
      throw new Error(`ContactOut request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value))
    return value.filter(
      (item): item is string => typeof item === "string" && Boolean(item),
    );
  return typeof value === "string" && value ? [value] : [];
}

export const CONTACTOUT_HANDLERS = {
  "contactout.professionalUrlFromPersonalEmail": executeContactOut,
  "contactout.mobileNumberFromLinkedIn": executeContactOut,
  "contactout.personalEmailFromLinkedIn": executeContactOut,
} satisfies IntegrationActionHandlers;
