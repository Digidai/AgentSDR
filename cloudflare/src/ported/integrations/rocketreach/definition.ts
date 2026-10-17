// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.
import type {
  IntegrationActionDefinition,
  IntegrationDefinition,
} from "../types";

const linkedInInput = {
  key: "linkedinUrl",
  name: "LinkedIn URL",
  description: "The person's LinkedIn profile URL.",
  valueType: "url" as const,
  acceptedColumnTypes: ["url" as const],
  required: true,
  example: "https://www.linkedin.com/in/example",
};
const personAction = (
  key: string,
  name: string,
  description: string,
  outputs: IntegrationActionDefinition["outputs"],
  creditsPerRun: number,
): IntegrationActionDefinition => ({
  key,
  name,
  description,
  docsUrl: "https://docs.rocketreach.co/reference/people-lookup-api",
  category: "enrich-person-info",
  type: "enrichment",
  tags: ["person", "contact", "rocketreach"],
  inputs: [linkedInInput],
  outputs,
  handlerKey: `rocketreach.${key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())}`,
  implemented: true,
  creditsPerRun,
  async: {
    maxBatchSize: 1,
    pollAfterMs: 3000,
    timeoutMs: 300_000,
    webhookSupported: true,
  },
});

export const ROCKETREACH: IntegrationDefinition = {
  key: "rocketreach",
  name: "RocketReach",
  description:
    "Find verified contact details and enrich people and companies with RocketReach.",
  websiteUrl: "https://rocketreach.co",
  iconText: "RR",
  iconBackground: "#405ca8",
  auth: {
    type: "api_key",
    fields: [
      {
        key: "apiKey",
        label: "RocketReach API key",
        placeholder: "Paste your RocketReach API key",
        inputType: "password",
        required: true,
      },
    ],
    helpUrl: "https://rocketreach.co/account?section=nav_gen_api",
  },
  actions: [
    personAction(
      "find-professional-email",
      "Find professional email",
      "Find a verified professional email from a LinkedIn profile.",
      [
        { key: "email", name: "Professional Email", columnType: "email" },
        { key: "emails", name: "Professional Emails", columnType: "json" },
      ],
      6,
    ),
    personAction(
      "find-personal-email",
      "Find personal email",
      "Find a verified personal email from a LinkedIn profile.",
      [
        { key: "email", name: "Personal Email", columnType: "email" },
        { key: "emails", name: "Personal Emails", columnType: "json" },
      ],
      6,
    ),
    personAction(
      "find-phone-number",
      "Find phone number",
      "Find a phone number from a LinkedIn profile.",
      [
        { key: "phoneNumber", name: "Phone Number", columnType: "text" },
        { key: "phoneNumbers", name: "Phone Numbers", columnType: "json" },
      ],
      5,
    ),
    personAction(
      "enrich-person",
      "Enrich person",
      "Retrieve professional profile, employment, and location data.",
      [
        { key: "name", name: "Full Name", columnType: "text" },
        { key: "jobTitle", name: "Job Title", columnType: "text" },
        { key: "companyName", name: "Company Name", columnType: "text" },
        { key: "companyDomain", name: "Company Domain", columnType: "url" },
        { key: "location", name: "Location", columnType: "text" },
        { key: "linkedinUrl", name: "LinkedIn URL", columnType: "url" },
        { key: "profile", name: "Full Profile", columnType: "json" },
      ],
      1,
    ),
    {
      key: "enrich-company",
      name: "Enrich company",
      description:
        "Retrieve company firmographics and technology data from its domain.",
      docsUrl: "https://docs.rocketreach.co/reference/company-lookup-api",
      category: "enrich-company-info",
      type: "enrichment",
      tags: ["company", "domain", "firmographics"],
      inputs: [
        {
          key: "domain",
          name: "Company Domain",
          description: "Company website or domain.",
          valueType: "domain",
          acceptedColumnTypes: ["url"],
          required: true,
          example: "example.com",
        },
      ],
      outputs: [
        { key: "companyName", name: "Company Name", columnType: "text" },
        { key: "domain", name: "Domain", columnType: "url" },
        { key: "industry", name: "Industry", columnType: "text" },
        { key: "employeeCount", name: "Employee Count", columnType: "number" },
        { key: "revenue", name: "Revenue", columnType: "number" },
        { key: "yearFounded", name: "Year Founded", columnType: "number" },
        { key: "technologies", name: "Technologies", columnType: "json" },
        { key: "company", name: "Full Company", columnType: "json" },
      ],
      handlerKey: "rocketreach.enrichCompany",
      implemented: true,
      creditsPerRun: 8,
    },
  ],
};
