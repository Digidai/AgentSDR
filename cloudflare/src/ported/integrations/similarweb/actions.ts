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

const ACTIONS: Record<
  string,
  {
    version: "v1" | "v4";
    path: string;
    arrayKey: string;
    valueKey?: string;
    outputKey: string;
  }
> = {
  "similarweb.getMonthlyWebsiteVisits": {
    version: "v1",
    path: "total-traffic-and-engagement/visits",
    arrayKey: "visits",
    valueKey: "visits",
    outputKey: "visits",
  },
  "similarweb.getTrafficDistributionByGeography": {
    version: "v4",
    path: "geo/total-traffic-by-country",
    arrayKey: "records",
    outputKey: "countries",
  },
  "similarweb.getWebsitePagesPerVisit": {
    version: "v1",
    path: "total-traffic-and-engagement/pages-per-visit",
    arrayKey: "pages_per_visit",
    valueKey: "pages_per_visit",
    outputKey: "pagesPerVisit",
  },
  "similarweb.getWebsiteBounceRate": {
    version: "v1",
    path: "total-traffic-and-engagement/bounce-rate",
    arrayKey: "bounce_rate",
    valueKey: "bounce_rate",
    outputKey: "bounceRate",
  },
  "similarweb.getWebsiteAverageVisitDuration": {
    version: "v1",
    path: "total-traffic-and-engagement/average-visit-duration",
    arrayKey: "average_visit_duration",
    valueKey: "average_visit_duration",
    outputKey: "averageVisitDuration",
  },
  "similarweb.getGlobalWebsiteTrafficRank": {
    version: "v1",
    path: "global-rank/global-rank",
    arrayKey: "global_rank",
    valueKey: "global_rank",
    outputKey: "globalRank",
  },
  "similarweb.findWebsiteTechnologies": {
    version: "v4",
    path: "technographics/all",
    arrayKey: "technologies",
    outputKey: "technologies",
  },
};

function latestCompleteMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    .toISOString()
    .slice(0, 7);
}

async function runSimilarweb(
  config: EnrichmentConfig,
  action: IntegrationActionDefinition,
  inputs: Record<string, unknown>,
  apiKey: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CellResult> {
  const spec = ACTIONS[action.handlerKey];
  if (!spec)
    throw new PermanentRunError(
      `Unknown Similarweb action: ${action.handlerKey}`,
    );
  const domain = normalizeDomain(String(inputs.domain));
  const url = new URL(
    `https://api.similarweb.com/${spec.version}/website/${encodeURIComponent(domain)}/${spec.path}`,
  );
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("format", "json");
  if (spec.path !== "technographics/all") {
    const month = latestCompleteMonth();
    url.searchParams.set("start_date", month);
    url.searchParams.set("end_date", month);
    url.searchParams.set("main_domain_only", "false");
    if (spec.version === "v1" && !spec.path.startsWith("global-rank")) {
      url.searchParams.set("country", "world");
      url.searchParams.set("granularity", "monthly");
    }
  }
  if (spec.version === "v4") {
    url.searchParams.set("limit", "100");
    url.searchParams.set("offset", "0");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await response.text();
    const body = parseJson(text);
    const root = asRecord(body);
    if (!response.ok || asRecord(root.meta).status === "Error") {
      const message = `Similarweb returned ${response.status}: ${errorMessage(body, "request failed")}`;
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 429
      )
        throw new PermanentRunError(message);
      throw new Error(message);
    }
    const values = Array.isArray(root[spec.arrayKey])
      ? (root[spec.arrayKey] as unknown[])
      : [];
    const latest = asRecord(values.at(-1));
    const logicalOutputs = spec.valueKey
      ? { [spec.outputKey]: latest[spec.valueKey], month: latest.date }
      : { [spec.outputKey]: values };
    const found = values.length > 0;
    return {
      value: found ? "Found" : "Not found",
      outputs: mapConfiguredOutputs(config, logicalOutputs, body),
      provider: "similarweb",
      outcome: found ? "hit" : "miss",
      costCents: 0,
      latencyMs: Date.now() - started,
      request: {
        method: "GET",
        endpoint: `/${spec.version}/website/:domain/${spec.path}`,
        inputKeys: Object.keys(inputs),
      },
      response: truncate(body),
    };
  } catch (error) {
    if (error instanceof PermanentRunError) throw error;
    if ((error as Error).name === "AbortError")
      throw new Error(`Similarweb request timed out after ${timeoutMs}ms`);
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
}) =>
  runSimilarweb(config, action, inputs, credentials.apiKey, timeoutMs, signal);
export const SIMILARWEB_HANDLERS = Object.fromEntries(
  Object.keys(ACTIONS).map((key) => [key, execute]),
) as IntegrationActionHandlers;
