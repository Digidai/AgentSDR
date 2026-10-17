// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.
import type { IntegrationDefinition } from "../types";

export const HUNTER: IntegrationDefinition = {
  key: "hunter",
  name: "Hunter",
  description:
    "Verify email addresses and discover company and person work emails.",
  websiteUrl: "https://hunter.io",
  iconText: "H",
  iconBackground: "#ff5a2d",
  auth: {
    type: "api_key",
    fields: [
      {
        key: "apiKey",
        label: "Hunter API key",
        placeholder: "Paste your Hunter API key",
        inputType: "password",
        required: true,
      },
    ],
    helpUrl: "https://hunter.io/api-documentation/v2#authentication",
  },
  actions: [
    {
      key: "verify-email",
      name: "Verify email",
      description:
        "Verify the deliverability and risk status of an email address.",
      docsUrl: "https://hunter.io/api-documentation/v2#email-verifier",
      category: "normalize",
      type: "enrichment",
      tags: ["email", "verification", "deliverability"],
      inputs: [
        {
          key: "email",
          name: "Email",
          description: "Email address to verify.",
          valueType: "email",
          acceptedColumnTypes: ["email"],
          required: true,
        },
      ],
      outputs: [
        { key: "email", name: "Email", columnType: "email" },
        { key: "status", name: "Status", columnType: "text" },
        { key: "score", name: "Score", columnType: "number" },
        { key: "acceptAll", name: "Accept All", columnType: "boolean" },
        { key: "disposable", name: "Disposable", columnType: "boolean" },
        { key: "webmail", name: "Webmail", columnType: "boolean" },
      ],
      handlerKey: "hunter.verifyEmail",
      implemented: true,
      creditsPerRun: 0.2,
      async: {
        maxBatchSize: 1,
        pollAfterMs: 2000,
        timeoutMs: 120000,
        webhookSupported: false,
      },
    },
    {
      key: "find-emails-by-company",
      name: "Find emails by company",
      description:
        "Find known email addresses and their contacts for a company domain.",
      docsUrl: "https://hunter.io/api-documentation/v2#domain-search",
      category: "enrich-company-info",
      type: "enrichment",
      tags: ["company", "domain", "emails"],
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
        { key: "emails", name: "Emails", columnType: "json" },
        { key: "emailCount", name: "Email Count", columnType: "number" },
        { key: "firstEmail", name: "First Email", columnType: "email" },
        { key: "organization", name: "Organization", columnType: "text" },
        { key: "pattern", name: "Email Pattern", columnType: "text" },
      ],
      handlerKey: "hunter.findEmailsByCompany",
      implemented: true,
      creditsPerRun: 0.4,
    },
    {
      key: "find-work-email",
      name: "Find work email",
      description:
        "Find a person's work email from their name and company domain.",
      docsUrl: "https://hunter.io/api-documentation/v2#email-finder",
      category: "enrich-person-info",
      type: "enrichment",
      tags: ["work email", "person", "company"],
      inputs: [
        {
          key: "fullName",
          name: "Full Name",
          description: "The person's full name.",
          valueType: "text",
          acceptedColumnTypes: ["text"],
          required: true,
        },
        {
          key: "companyDomain",
          name: "Company Domain",
          description: "The person's company domain.",
          valueType: "domain",
          acceptedColumnTypes: ["url"],
          required: true,
        },
      ],
      outputs: [
        { key: "email", name: "Work Email", columnType: "email" },
        { key: "score", name: "Score", columnType: "number" },
        {
          key: "verificationStatus",
          name: "Verification Status",
          columnType: "text",
        },
        { key: "position", name: "Position", columnType: "text" },
        { key: "linkedinUrl", name: "LinkedIn URL", columnType: "url" },
        { key: "phoneNumber", name: "Phone Number", columnType: "text" },
      ],
      handlerKey: "hunter.findWorkEmail",
      implemented: true,
      creditsPerRun: 0.4,
    },
  ],
};
