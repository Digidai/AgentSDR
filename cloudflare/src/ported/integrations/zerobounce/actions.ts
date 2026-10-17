// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.

import type { CellResult, EnrichmentConfig } from "../../grid/types";
import { PermanentRunError } from "../../grid/runners/types";
import type { IntegrationActionDefinition } from "../types";
import type { IntegrationActionHandlers } from "../server/types";
import {
  asRecord,
  errorMessage,
  mapConfiguredOutputs,
  parseJson,
  truncate,
} from "../server/helpers";

const ZEROBOUNCE_VALIDATE_URL = "https://api.zerobounce.net/v2/validate";
const VALID_STATUSES = new Set([
  "valid",
  "invalid",
  "catch-all",
  "unknown",
  "spamtrap",
  "abuse",
  "do_not_mail",
]);

async function runZeroBounce(
  config: EnrichmentConfig,
  action: IntegrationActionDefinition,
  inputs: Record<string, unknown>,
  apiKey: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CellResult> {
  if (action.handlerKey !== "zerobounce.validateEmail") {
    throw new PermanentRunError(
      `Unknown ZeroBounce action: ${action.handlerKey}`,
    );
  }

  const url = new URL(ZEROBOUNCE_VALIDATE_URL);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("email", String(inputs.email));
  if (inputs.ipAddress)
    url.searchParams.set("ip_address", String(inputs.ipAddress));
  const providerTimeoutSeconds = Math.max(
    3,
    Math.min(60, Math.floor((timeoutMs - 1_000) / 1_000)),
  );
  url.searchParams.set("timeout", String(providerTimeoutSeconds));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort);
  const started = Date.now();

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await response.text();
    const body = parseJson(text);
    const root = asRecord(body);

    if (!response.ok) {
      const message = `ZeroBounce returned ${response.status}: ${errorMessage(body, "request failed")}`;
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 429
      )
        throw new PermanentRunError(message);
      throw new Error(message);
    }
    if (typeof root.error === "string" && root.error) {
      const message = `ZeroBounce could not validate the email: ${root.error.slice(0, 300)}`;
      if (/api key|credits/i.test(root.error))
        throw new PermanentRunError(message);
      throw new Error(message);
    }

    const status =
      typeof root.status === "string" ? root.status.toLowerCase() : "";
    if (!VALID_STATUSES.has(status))
      throw new Error("ZeroBounce returned an invalid response");
    const logicalOutputs = {
      email: root.address,
      status,
      subStatus: root.sub_status,
      isFreeEmail: root.free_email,
      isCatchAll: root.catchall_domain,
      didYouMean: root.did_you_mean,
      account: root.account,
      domain: root.domain,
      domainAgeDays:
        root.domain_age_days == null ? null : Number(root.domain_age_days),
      activeInDays: root.active_in_days,
      mxFound: root.mx_found === true || root.mx_found === "true",
      mxRecord: root.mx_record,
      smtpProvider: root.smtp_provider,
      firstName: root.firstname,
      lastName: root.lastname,
      processedAt: root.processed_at,
    };

    return {
      value: status,
      outputs: mapConfiguredOutputs(config, logicalOutputs, body),
      provider: "zerobounce",
      outcome: "hit",
      costCents: 0,
      latencyMs: Date.now() - started,
      request: {
        method: "GET",
        endpoint: "/v2/validate",
        inputKeys: Object.keys(inputs),
      },
      response: truncate(body),
    };
  } catch (error) {
    if (error instanceof PermanentRunError) throw error;
    if ((error as Error).name === "AbortError")
      throw new Error(`ZeroBounce request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

export const ZEROBOUNCE_HANDLERS = {
  "zerobounce.validateEmail": ({
    config,
    action,
    inputs,
    credentials,
    timeoutMs,
    signal,
  }) =>
    runZeroBounce(
      config,
      action,
      inputs,
      credentials.apiKey,
      timeoutMs,
      signal,
    ),
} satisfies IntegrationActionHandlers;
