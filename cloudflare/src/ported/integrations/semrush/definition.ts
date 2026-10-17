// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.
import type {
  IntegrationActionDefinition,
  IntegrationDefinition,
} from "../types";

const domainInput = {
  key: "domain",
  name: "Company Domain",
  description: "Company website or domain.",
  valueType: "domain" as const,
  acceptedColumnTypes: ["url" as const],
  required: true,
  example: "example.com",
};
const action = (
  key: string,
  name: string,
  description: string,
  docsUrl: string,
  outputKey: string,
  outputName: string,
  creditsPerRun: number,
): IntegrationActionDefinition => ({
  key,
  name,
  description,
  docsUrl,
  category: "enrich-company-info",
  type: "enrichment",
  tags: ["company", "website", "traffic", "semrush"],
  inputs: [domainInput],
  outputs: [{ key: outputKey, name: outputName, columnType: "json" }],
  handlerKey: `semrush.${key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())}`,
  implemented: true,
  creditsPerRun,
});

export const SEMRUSH: IntegrationDefinition = {
  key: "semrush",
  name: "Semrush",
  description:
    "Analyze company traffic, search competitors, audiences, and website performance with Semrush.",
  websiteUrl: "https://www.semrush.com",
  iconText: "S",
  iconBackground: "#b87cff",
  auth: {
    type: "api_key",
    fields: [
      {
        key: "apiKey",
        label: "Semrush API key",
        placeholder: "Paste your Semrush API key",
        inputType: "password",
        required: true,
      },
    ],
    helpUrl: "https://developer.semrush.com/api/v3/get-started/authorization/",
  },
  actions: [
    {
      key: "get-traffic-analytics",
      name: "Get traffic analytics",
      description:
        "Get current traffic and engagement metrics for a company website.",
      docsUrl:
        "https://developer.semrush.com/api/v3/trends/api-reference/#traffic-summary",
      category: "enrich-company-info",
      type: "enrichment",
      tags: ["company", "website", "traffic", "semrush"],
      inputs: [domainInput],
      outputs: [
        { key: "visits", name: "Visits", columnType: "number" },
        { key: "users", name: "Unique Visitors", columnType: "number" },
        { key: "rank", name: "Traffic Rank", columnType: "number" },
        { key: "pagesPerVisit", name: "Pages per Visit", columnType: "number" },
        {
          key: "averageVisitDuration",
          name: "Average Visit Duration",
          columnType: "number",
        },
        { key: "bounceRate", name: "Bounce Rate", columnType: "number" },
        {
          key: "trafficAnalytics",
          name: "Full Traffic Analytics",
          columnType: "json",
        },
      ],
      handlerKey: "semrush.getTrafficAnalytics",
      implemented: true,
      creditsPerRun: 2,
    },
    action(
      "get-competitors-in-paid-search",
      "Get competitors in paid search",
      "Find domains competing with a company in paid search.",
      "https://developer.semrush.com/api/v3/seo/domain-reports/#competitors-in-paid-search",
      "competitors",
      "Paid Search Competitors",
      2,
    ),
    action(
      "get-company-traffic-sources",
      "Get company traffic sources",
      "Get upstream websites and channel traffic sources for a company.",
      "https://developer.semrush.com/api/v3/trends/api-reference/#traffic-sources",
      "trafficSources",
      "Traffic Sources",
      3,
    ),
    action(
      "get-company-top-pages",
      "Get company top pages",
      "Get the most popular pages for a company website.",
      "https://developer.semrush.com/api/v3/trends/api-reference/#top-pages",
      "topPages",
      "Top Pages",
      3,
    ),
    action(
      "get-company-social-media-engagement",
      "Get company social media engagement",
      "Get social-platform audience and engagement data for a company website.",
      "https://developer.semrush.com/api/v3/trends/api-reference/#social-media",
      "socialMedia",
      "Social Media Engagement",
      3,
    ),
    action(
      "get-company-website-traffic-geographic-distribution",
      "Get company website traffic’s geographic distribution",
      "Get company website traffic and engagement broken down by country.",
      "https://developer.semrush.com/api/v3/trends/api-reference/#geo-distribution",
      "geography",
      "Geographic Distribution",
      3,
    ),
  ],
};
