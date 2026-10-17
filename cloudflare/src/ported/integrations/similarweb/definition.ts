// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.
import type {
  IntegrationActionDefinition,
  IntegrationDefinition,
} from "../types";

const domainInput = {
  key: "domain",
  name: "Website Domain",
  description: "Company website or domain.",
  valueType: "domain" as const,
  acceptedColumnTypes: ["url" as const],
  required: true,
  example: "example.com",
};
const metric = (
  key: string,
  name: string,
  description: string,
  docsUrl: string,
  outputKey: string,
  outputName: string,
  columnType: "number" | "json",
  creditsPerRun: number,
): IntegrationActionDefinition => ({
  key,
  name,
  description,
  docsUrl,
  category: "enrich-company-info",
  type: "enrichment",
  tags: ["website", "traffic", "similarweb"],
  inputs: [domainInput],
  outputs:
    columnType === "json"
      ? [{ key: outputKey, name: outputName, columnType }]
      : [
          { key: outputKey, name: outputName, columnType },
          { key: "month", name: "Data Month", columnType: "date" },
        ],
  handlerKey: `similarweb.${key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())}`,
  implemented: true,
  creditsPerRun,
});

export const SIMILARWEB: IntegrationDefinition = {
  key: "similarweb",
  name: "Similarweb",
  description:
    "Enrich companies with website traffic, engagement, geography, rank, and technology data.",
  websiteUrl: "https://www.similarweb.com",
  iconText: "SW",
  iconBackground: "#ff6b35",
  auth: {
    type: "api_key",
    fields: [
      {
        key: "apiKey",
        label: "Similarweb API key",
        placeholder: "Paste your Similarweb API key",
        inputType: "password",
        required: true,
      },
    ],
    helpUrl: "https://developers.similarweb.com/docs/api-keys",
  },
  actions: [
    metric(
      "get-monthly-website-visits",
      "Get monthly website visits",
      "Get estimated desktop and mobile visits for the latest complete month.",
      "https://developers.similarweb.com/reference/visits",
      "visits",
      "Monthly Visits",
      "number",
      6.5,
    ),
    metric(
      "get-traffic-distribution-by-geography",
      "Get traffic distribution by geography",
      "Get website traffic share and engagement by country.",
      "https://developers.similarweb.com/reference/geography-total",
      "countries",
      "Traffic by Country",
      "json",
      0,
    ),
    metric(
      "get-website-pages-per-visit",
      "Get website pages per visit",
      "Get average pages viewed per visit for the latest complete month.",
      "https://developers.similarweb.com/reference/pages-per-visit",
      "pagesPerVisit",
      "Pages per Visit",
      "number",
      6.5,
    ),
    metric(
      "get-website-bounce-rate",
      "Get website bounce rate",
      "Get website bounce rate for the latest complete month.",
      "https://developers.similarweb.com/reference/bounce-rate",
      "bounceRate",
      "Bounce Rate",
      "number",
      6.5,
    ),
    metric(
      "get-website-average-visit-duration",
      "Get website average visit duration",
      "Get average visit duration in seconds for the latest complete month.",
      "https://developers.similarweb.com/reference/average-visit-duration-all-traffic",
      "averageVisitDuration",
      "Average Visit Duration (seconds)",
      "number",
      6.5,
    ),
    metric(
      "get-global-website-traffic-rank",
      "Get global website traffic rank",
      "Get the website's global rank for the latest complete month.",
      "https://developers.similarweb.com/reference/global-rank",
      "globalRank",
      "Global Rank",
      "number",
      6.5,
    ),
    metric(
      "find-website-technologies",
      "Find website technologies",
      "Find technologies detected on a website.",
      "https://developers.similarweb.com/reference/website-technologies",
      "technologies",
      "Technologies",
      "json",
      32,
    ),
  ],
};
