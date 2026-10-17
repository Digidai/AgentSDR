// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.

import type { CellResult, EnrichmentConfig } from "../../grid/types";
import type { IntegrationActionDefinition } from "../types";
import { PermanentRunError } from "../../grid/runners/types";
import type { IntegrationActionHandlers } from "../server/types";
import {
  asRecord,
  errorMessage,
  mapConfiguredOutputs,
  parseJson,
  truncate,
} from "../server/helpers";

const MILLIONVERIFIER_API_BASE = "https://api.millionverifier.com/api/v3";

async function runMillionVerifier(
  config: EnrichmentConfig,
  action: IntegrationActionDefinition,
  inputs: Record<string, unknown>,
  apiKey: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CellResult> {
  if (action.handlerKey !== "millionverifier.verifyEmail") {
    throw new PermanentRunError(
      `Unknown MillionVerifier action: ${action.handlerKey}`,
    );
  }

  const url = new URL(MILLIONVERIFIER_API_BASE);
  url.searchParams.set("api", apiKey);
  url.searchParams.set("email", String(inputs.email));
  // MillionVerifier accepts 2–60 seconds. Leave a small margin for our own
  // request deadline so the provider can return an "unknown" result first.
  const providerTimeoutSeconds = Math.max(
    2,
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
      const message = `MillionVerifier returned ${response.status}: ${errorMessage(body, "request failed")}`;
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 429
      ) {
        throw new PermanentRunError(message);
      }
      throw new Error(message);
    }

    const result = typeof root.result === "string" ? root.result : "";
    if (result === "error") {
      const providerError =
        typeof root.error === "string" ? root.error : "request failed";
      const message = `MillionVerifier could not verify the email: ${providerError.slice(0, 300)}`;
      if (providerError.toLowerCase().includes("internal"))
        throw new Error(message);
      throw new PermanentRunError(message);
    }
    if (!result)
      throw new Error("MillionVerifier returned an invalid response");

    const logicalOutputs = {
      email: root.email,
      result: root.result,
      quality: root.quality,
      resultCode: root.resultcode,
      subresult: root.subresult,
      isFreeEmail: root.free,
      isRoleBased: root.role,
      didYouMean: root.didyoumean,
      creditsRemaining: root.credits,
      executionTimeMs: root.executiontime,
      liveMode: root.livemode,
    };

    return {
      value: result,
      outputs: mapConfiguredOutputs(config, logicalOutputs, body),
      provider: "millionverifier",
      outcome: "hit",
      costCents: 0,
      latencyMs: Date.now() - started,
      request: {
        method: "GET",
        endpoint: "/api/v3",
        inputKeys: Object.keys(inputs),
      },
      response: truncate(body),
    };
  } catch (error) {
    if (error instanceof PermanentRunError) throw error;
    if ((error as Error).name === "AbortError") {
      throw new Error(`MillionVerifier request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

export const MILLIONVERIFIER_HANDLERS = {
  "millionverifier.verifyEmail": ({
    config,
    action,
    inputs,
    credentials,
    timeoutMs,
    signal,
  }) =>
    runMillionVerifier(
      config,
      action,
      inputs,
      credentials.apiKey,
      timeoutMs,
      signal,
    ),
} satisfies IntegrationActionHandlers;
