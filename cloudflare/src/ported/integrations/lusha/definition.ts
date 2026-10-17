// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.
import type {
  IntegrationActionDefinition,
  IntegrationDefinition,
} from "../types";

const companySignalInputs: IntegrationActionDefinition["inputs"] = [
  {
    key: "companyDomain",
    name: "Company Domain",
    description: "Company website or domain.",
    valueType: "domain",
    acceptedColumnTypes: ["url"],
    required: true,
  },
  {
    key: "startDate",
    name: "Start Date",
    description: "Optional earliest signal date.",
    valueType: "date",
    acceptedColumnTypes: ["date", "text"],
    required: false,
  },
];

const companySignalOutputs: IntegrationActionDefinition["outputs"] = [
  { key: "signals", name: "Signals", columnType: "json" },
  { key: "signalCount", name: "Signal Count", columnType: "number" },
  { key: "companyName", name: "Company Name", columnType: "text" },
  { key: "companyDomain", name: "Company Domain", columnType: "url" },
];

function companySignalAction(
  key: string,
  name: string,
  description: string,
  handlerKey: string,
  tags: string[],
): IntegrationActionDefinition {
  return {
    key,
    name,
    description,
    docsUrl: "https://docs.lusha.com/apis/openapi/signals/getcompanysignals",
    category: "enrich-company-info",
    type: "enrichment",
    tags: ["company signals", ...tags],
    inputs: companySignalInputs,
    outputs: companySignalOutputs,
    handlerKey,
    implemented: true,
    creditsPerRun: 8,
  };
}

export const LUSHA: IntegrationDefinition = {
  key: "lusha",
  name: "Lusha",
  description:
    "Enrich people and companies and retrieve current company and contact signals.",
  websiteUrl: "https://www.lusha.com",
  iconText: "L",
  iconBackground: "#641cff",
  auth: {
    type: "api_key",
    fields: [
      {
        key: "apiKey",
        label: "Lusha API key",
        placeholder: "Paste your Lusha API key",
        inputType: "password",
        required: true,
      },
    ],
    helpUrl:
      "https://docs.lusha.com/guides/advanced-topics/new-getting-started",
  },
  actions: [
    companySignalAction(
      "company-website-traffic-signal",
      "Find company website traffic signal",
      "Find recent increases or decreases in a company's website traffic.",
      "lusha.companyWebsiteTrafficSignal",
      ["website traffic", "intent"],
    ),
    companySignalAction(
      "company-it-spend-signal",
      "Find company IT spend signal",
      "Find recent increases or decreases in a company's IT spending.",
      "lusha.companyItSpendSignal",
      ["IT spend", "intent"],
    ),
    companySignalAction(
      "company-jobs-growth-by-location-signal",
      "Find company jobs growth by location signal",
      "Find hiring surges grouped by location.",
      "lusha.companyJobsGrowthByLocationSignal",
      ["jobs", "hiring", "location"],
    ),
    companySignalAction(
      "company-jobs-growth-by-department-signal",
      "Find company jobs growth by department signal",
      "Find hiring surges grouped by department.",
      "lusha.companyJobsGrowthByDepartmentSignal",
      ["jobs", "hiring", "department"],
    ),
    companySignalAction(
      "company-jobs-growth-signal",
      "Find company jobs growth signal",
      "Find recent company-wide hiring surges.",
      "lusha.companyJobsGrowthSignal",
      ["jobs", "hiring"],
    ),
    companySignalAction(
      "company-headcount-growth-signal",
      "Find company headcount growth signal",
      "Find headcount increases or decreases across supported time windows.",
      "lusha.companyHeadcountGrowthSignal",
      ["headcount", "growth"],
    ),
    companySignalAction(
      "company-news-signal",
      "Find company news signal",
      "Find recent risk, commercial, strategy, financial, people, market, and product news.",
      "lusha.companyNewsSignal",
      ["news", "company activity"],
    ),
    {
      key: "enrich-company",
      name: "Enrich company",
      description:
        "Find and reveal a company's full firmographic profile from its domain.",
      docsUrl:
        "https://docs.lusha.com/apis/openapi/search-and-enrich/searchandenrichcompanies",
      category: "enrich-company-info",
      type: "enrichment",
      tags: ["company", "firmographics", "enrichment"],
      inputs: [
        {
          key: "companyDomain",
          name: "Company Domain",
          description: "Company website or domain.",
          valueType: "domain",
          acceptedColumnTypes: ["url"],
          required: true,
        },
      ],
      outputs: [
        { key: "companyName", name: "Company Name", columnType: "text" },
        { key: "companyDomain", name: "Company Domain", columnType: "url" },
        { key: "website", name: "Website", columnType: "url" },
        { key: "industry", name: "Industry", columnType: "text" },
        { key: "employeeCount", name: "Employee Count", columnType: "number" },
        { key: "linkedinUrl", name: "LinkedIn URL", columnType: "url" },
        { key: "company", name: "Full Company", columnType: "json" },
      ],
      handlerKey: "lusha.enrichCompany",
      implemented: true,
    },
    {
      key: "find-person-signals",
      name: "Find person signals",
      description:
        "Find recent promotions and company changes for a professional profile.",
      docsUrl: "https://docs.lusha.com/apis/openapi/signals/getcontactsignals",
      category: "enrich-person-info",
      type: "enrichment",
      tags: ["person signals", "promotion", "job change"],
      inputs: [
        {
          key: "linkedinUrl",
          name: "LinkedIn URL",
          description: "The person's LinkedIn profile URL.",
          valueType: "url",
          acceptedColumnTypes: ["url"],
          required: true,
        },
        {
          key: "startDate",
          name: "Start Date",
          description: "Optional earliest signal date.",
          valueType: "date",
          acceptedColumnTypes: ["date", "text"],
          required: false,
        },
      ],
      outputs: [
        { key: "signals", name: "Signals", columnType: "json" },
        { key: "signalCount", name: "Signal Count", columnType: "number" },
        { key: "fullName", name: "Full Name", columnType: "text" },
      ],
      handlerKey: "lusha.findPersonSignals",
      implemented: true,
      creditsPerRun: 8,
    },
    {
      key: "enrich-person",
      name: "Enrich person",
      description:
        "Find and reveal a person's profile, emails, and phone numbers from LinkedIn.",
      docsUrl:
        "https://docs.lusha.com/apis/openapi/search-and-enrich/searchandenrichcontacts",
      category: "enrich-person-info",
      type: "enrichment",
      tags: ["person", "email", "phone", "linkedin"],
      inputs: [
        {
          key: "linkedinUrl",
          name: "LinkedIn URL",
          description: "The person's LinkedIn profile URL.",
          valueType: "url",
          acceptedColumnTypes: ["url"],
          required: true,
        },
      ],
      outputs: [
        { key: "fullName", name: "Full Name", columnType: "text" },
        { key: "workEmail", name: "Work Email", columnType: "email" },
        { key: "phoneNumber", name: "Phone Number", columnType: "text" },
        { key: "jobTitle", name: "Job Title", columnType: "text" },
        { key: "companyName", name: "Company Name", columnType: "text" },
        { key: "linkedinUrl", name: "LinkedIn URL", columnType: "url" },
        { key: "person", name: "Full Person", columnType: "json" },
      ],
      handlerKey: "lusha.enrichPerson",
      implemented: true,
    },
  ],
};
