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

const API_BASE = "https://api.hunter.io/v2";

function hunterError(body: unknown): string {
  const errors = asRecord(body).errors;
  const first = Array.isArray(errors) ? asRecord(errors[0]) : asRecord(errors);
  for (const value of [
    first.details,
    first.detail,
    first.message,
    first.code,
  ]) {
    if (typeof value === "string" && value) return value.slice(0, 300);
  }
  return "request failed";
}

async function executeHunter(
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
  const startedAt =
    typeof providerState?.startedAt === "number"
      ? providerState.startedAt
      : Date.now();
  if (Date.now() - startedAt > (action.async?.timeoutMs ?? 120_000)) {
    throw new PermanentRunError(
      "Hunter did not finish verifying this email before its timeout",
    );
  }

  const url = new URL(API_BASE);
  if (action.handlerKey === "hunter.verifyEmail") {
    url.pathname = "/v2/email-verifier";
    url.searchParams.set("email", String(inputs.email));
  } else if (action.handlerKey === "hunter.findEmailsByCompany") {
    url.pathname = "/v2/domain-search";
    url.searchParams.set(
      "domain",
      normalizeDomain(String(inputs.companyDomain)),
    );
    url.searchParams.set("limit", "10");
  } else if (action.handlerKey === "hunter.findWorkEmail") {
    url.pathname = "/v2/email-finder";
    url.searchParams.set(
      "domain",
      normalizeDomain(String(inputs.companyDomain)),
    );
    url.searchParams.set("full_name", String(inputs.fullName));
  } else {
    throw new PermanentRunError(`Unknown Hunter action: ${action.handlerKey}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "X-API-KEY": credentials.apiKey },
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await response.text();
    const body = parseJson(text);

    if (response.status === 202 && action.handlerKey === "hunter.verifyEmail") {
      return {
        pending: true,
        state: {
          startedAt,
          pollCount: Number(providerState?.pollCount ?? 0) + 1,
        },
        pollAfterMs: action.async?.pollAfterMs ?? 2000,
      };
    }
    if (!response.ok) {
      const message = `Hunter returned ${response.status}: ${hunterError(body)}`;
      if (
        response.status === 222 ||
        response.status === 403 ||
        response.status >= 500
      )
        throw new Error(message);
      throw new PermanentRunError(message);
    }

    const data = asRecord(asRecord(body).data);
    let logicalOutputs: Record<string, unknown>;
    let primary: unknown;
    if (action.handlerKey === "hunter.verifyEmail") {
      logicalOutputs = {
        email: data.email,
        status: data.status,
        score: data.score,
        acceptAll: data.accept_all,
        disposable: data.disposable,
        webmail: data.webmail,
      };
      primary = data.status;
    } else if (action.handlerKey === "hunter.findEmailsByCompany") {
      const emails = Array.isArray(data.emails) ? data.emails : [];
      const first = asRecord(emails[0]);
      logicalOutputs = {
        emails,
        emailCount: emails.length,
        firstEmail: first.value,
        organization: data.organization,
        pattern: data.pattern,
      };
      primary = first.value;
    } else {
      const verification = asRecord(data.verification);
      logicalOutputs = {
        email: data.email,
        score: data.score,
        verificationStatus: verification.status,
        position: data.position,
        linkedinUrl: data.linkedin_url,
        phoneNumber: data.phone_number,
      };
      primary = data.email;
    }
    const found = primary !== null && primary !== undefined && primary !== "";
    return {
      value: found ? String(primary) : "Not found",
      outputs: mapConfiguredOutputs(config, logicalOutputs, body),
      provider: "hunter",
      outcome: found ? "hit" : "miss",
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
    if ((error as Error).name === "AbortError")
      throw new Error(`Hunter request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

export const HUNTER_HANDLERS = {
  "hunter.verifyEmail": executeHunter,
  "hunter.findEmailsByCompany": executeHunter,
  "hunter.findWorkEmail": executeHunter,
} satisfies IntegrationActionHandlers;
