// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.
import type { IntegrationDefinition } from "../types";

export const FULLENRICH: IntegrationDefinition = {
  key: "fullenrich",
  name: "FullEnrich",
  description:
    "Find work emails and mobile phone numbers through a provider waterfall.",
  websiteUrl: "https://fullenrich.com",
  iconUrl: "/Integrations%20-%20Icon/fullenrich-symbol-black.svg",
  iconText: "FE",
  iconBackground: "#111111",
  auth: {
    type: "api_key",
    fields: [
      {
        key: "apiKey",
        label: "FullEnrich API key",
        placeholder: "Paste your FullEnrich API key",
        inputType: "password",
        required: true,
      },
    ],
    helpUrl: "https://app.fullenrich.com/app/api",
  },
  actions: [
    {
      key: "find-work-email",
      name: "Find work email",
      description: "Find the most probable work email for a LinkedIn profile.",
      docsUrl: "https://docs.fullenrich.com/api/v2/contact/enrich/bulk/post",
      category: "enrich-person-info",
      type: "enrichment",
      tags: ["work email", "linkedin", "waterfall"],
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
        { key: "workEmail", name: "Work Email", columnType: "email" },
        { key: "emailStatus", name: "Email Status", columnType: "text" },
        { key: "workEmails", name: "All Work Emails", columnType: "json" },
      ],
      handlerKey: "fullenrich.findWorkEmail",
      implemented: true,
      creditsPerRun: 1,
      async: {
        maxBatchSize: 1,
        pollAfterMs: 3000,
        timeoutMs: 300000,
        webhookSupported: true,
      },
    },
    {
      key: "find-mobile-phone",
      name: "Find mobile phone",
      description:
        "Find the most probable mobile phone number for a LinkedIn profile.",
      docsUrl: "https://docs.fullenrich.com/api/v2/contact/enrich/bulk/post",
      category: "enrich-person-info",
      type: "enrichment",
      tags: ["mobile", "phone", "linkedin", "EMEA coverage", "waterfall"],
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
        { key: "phoneNumber", name: "Mobile Phone", columnType: "text" },
        { key: "region", name: "Phone Region", columnType: "text" },
        { key: "phones", name: "All Phone Numbers", columnType: "json" },
      ],
      handlerKey: "fullenrich.findMobilePhone",
      implemented: true,
      creditsPerRun: 10,
      async: {
        maxBatchSize: 1,
        pollAfterMs: 3000,
        timeoutMs: 300000,
        webhookSupported: true,
      },
    },
  ],
};
