// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.

import type { CellResult, EnrichmentConfig } from "../../grid/types";
import { PermanentRunError } from "../../grid/runners/types";
import type { IntegrationActionDefinition } from "../types";
import type { IntegrationActionHandlers } from "../server/types";
import {
  mapConfiguredOutputs,
  normalizeDomain,
  truncate,
} from "../server/helpers";

type Report = {
  endpoint: string;
  outputKey: string;
  params: Record<string, string>;
};
const TRENDS_BASE = "https://api.semrush.com/analytics/ta/api/v3";

function reportFor(handlerKey: string, domain: string): Report {
  const common = { target: domain, display_limit: "25", display_offset: "0" };
  switch (handlerKey) {
    case "semrush.getTrafficAnalytics":
      return {
        endpoint: `${TRENDS_BASE}/summary`,
        outputKey: "trafficAnalytics",
        params: {
          targets: domain,
          export_columns:
            "target,rank,visits,users,time_on_site,pages_per_visit,bounce_rate,direct,referral,search_organic,search_paid,social_organic,social_paid,mail,display_ad,country,device_type,display_date",
        },
      };
    case "semrush.getCompetitorsInPaidSearch":
      return {
        endpoint: "https://api.semrush.com/",
        outputKey: "competitors",
        params: {
          type: "domain_adwords_adwords",
          domain,
          database: "us",
          display_limit: "25",
          export_columns: "Dn,Cr,Np,Ad,At,Ac,Or",
        },
      };
    case "semrush.getCompanyTrafficSources":
      return {
        endpoint: `${TRENDS_BASE}/sources`,
        outputKey: "trafficSources",
        params: {
          ...common,
          export_columns:
            "target,from_target,display_date,country,device_type,traffic_share,traffic,channel,traffic_type",
        },
      };
    case "semrush.getCompanyTopPages":
      return {
        endpoint: `${TRENDS_BASE}/toppages`,
        outputKey: "topPages",
        params: {
          ...common,
          export_columns:
            "target,page,display_date,country,device_type,traffic_share,users_by_target,traffic,avg_visit_duration,exits,entrance_traffic",
        },
      };
    case "semrush.getCompanySocialMediaEngagement":
      return {
        endpoint: `${TRENDS_BASE}/social_media`,
        outputKey: "socialMedia",
        params: {
          ...common,
          export_columns: "target,social_name,social_domain,users_score,users",
        },
      };
    case "semrush.getCompanyWebsiteTrafficGeographicDistribution":
      return {
        endpoint: `${TRENDS_BASE}/geo`,
        outputKey: "geography",
        params: {
          ...common,
          target_type: "domain",
          geo_type: "country",
          export_columns:
            "target,display_date,device_type,geo,traffic,global_traffic,traffic_share,users,avg_visit_duration,bounce_rate,pages_per_visit",
        },
      };
    default:
      throw new PermanentRunError(`Unknown Semrush action: ${handlerKey}`);
  }
}

function parseDelimited(text: string): Record<string, unknown>[] {
  const lines = text
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  if (lines.length < 2) return [];
  const separator = lines[0].includes(";") ? ";" : ",";
  const parseLine = (line: string) => {
    const values: string[] = [];
    let current = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (quoted && line[i + 1] === '"') {
          current += '"';
          i++;
        } else quoted = !quoted;
      } else if (char === separator && !quoted) {
        values.push(current);
        current = "";
      } else current += char;
    }
    values.push(current);
    return values;
  };
  const headers = parseLine(lines[0]).map((header) =>
    header
      .trim()
      .replace(/[^a-zA-Z0-9]+(.)/g, (_, char: string) => char.toUpperCase())
      .replace(/^./, (char) => char.toLowerCase()),
  );
  return lines
    .slice(1)
    .map((line) =>
      Object.fromEntries(
        parseLine(line).map((value, index) => [
          headers[index] ?? `column${index + 1}`,
          /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value,
        ]),
      ),
    );
}

async function runSemrush(
  config: EnrichmentConfig,
  action: IntegrationActionDefinition,
  inputs: Record<string, unknown>,
  apiKey: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CellResult> {
  const report = reportFor(
    action.handlerKey,
    normalizeDomain(String(inputs.domain)),
  );
  const url = new URL(report.endpoint);
  url.searchParams.set("key", apiKey);
  for (const [key, value] of Object.entries(report.params))
    url.searchParams.set(key, value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: { Accept: "text/csv, text/plain" },
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await response.text();
    if (!response.ok || /^ERROR\s/i.test(text.trim())) {
      const message = `Semrush returned ${response.status}: ${text.trim().slice(0, 300) || "request failed"}`;
      if (
        (response.status >= 400 &&
          response.status < 500 &&
          response.status !== 429) ||
        /WRONG KEY|NOT ENOUGH UNITS|MANDATORY PARAMETER/i.test(text)
      )
        throw new PermanentRunError(message);
      throw new Error(message);
    }
    const rows = parseDelimited(text);
    const first = rows[0] ?? null;
    const logicalOutputs =
      action.handlerKey === "semrush.getTrafficAnalytics" && first
        ? {
            trafficAnalytics: first,
            visits: first.visits,
            users: first.users,
            rank: first.rank,
            pagesPerVisit: first.pagesPerVisit,
            averageVisitDuration: first.timeOnSite,
            bounceRate: first.bounceRate,
          }
        : { [report.outputKey]: rows };
    const found = rows.length > 0;
    return {
      value: found ? "Found" : "Not found",
      outputs: mapConfiguredOutputs(config, logicalOutputs, rows),
      provider: "semrush",
      outcome: found ? "hit" : "miss",
      costCents: 0,
      latencyMs: Date.now() - started,
      request: {
        method: "GET",
        endpoint: new URL(report.endpoint).pathname,
        inputKeys: Object.keys(inputs),
      },
      response: truncate(rows),
    };
  } catch (error) {
    if (error instanceof PermanentRunError) throw error;
    if ((error as Error).name === "AbortError")
      throw new Error(`Semrush request timed out after ${timeoutMs}ms`);
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
}) => runSemrush(config, action, inputs, credentials.apiKey, timeoutMs, signal);
export const SEMRUSH_HANDLERS: IntegrationActionHandlers = {
  "semrush.getTrafficAnalytics": execute,
  "semrush.getCompetitorsInPaidSearch": execute,
  "semrush.getCompanyTrafficSources": execute,
  "semrush.getCompanyTopPages": execute,
  "semrush.getCompanySocialMediaEngagement": execute,
  "semrush.getCompanyWebsiteTrafficGeographicDistribution": execute,
};
