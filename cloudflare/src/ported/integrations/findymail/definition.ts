// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.
import type { IntegrationDefinition } from "../types";

export const FINDYMAIL: IntegrationDefinition = {
  key: "findymail",
  name: "Findymail",
  description:
    "Find and verify work emails and find phone numbers from professional profiles.",
  websiteUrl: "https://www.findymail.com",
  iconText: "FM",
  iconBackground: "#ffffff",
  auth: {
    type: "api_key",
    fields: [
      {
        key: "apiKey",
        label: "Findymail API key",
        placeholder: "Paste your Findymail API key",
        inputType: "password",
        required: true,
      },
    ],
    helpUrl: "https://app.findymail.com/docs/",
  },
  actions: [
    {
      key: "validate-email",
      name: "Validate Email",
      description: "Check whether an email address is valid and deliverable.",
      docsUrl: "https://app.findymail.com/docs/#email-verifier",
      category: "normalize",
      type: "enrichment",
      tags: ["email", "verify", "deliverability"],
      inputs: [
        {
          key: "email",
          name: "Email",
          description: "The email address to validate.",
          valueType: "email",
          acceptedColumnTypes: ["email"],
          required: true,
        },
      ],
      outputs: [
        { key: "email", name: "Email", columnType: "email" },
        { key: "verified", name: "Verified", columnType: "boolean" },
        { key: "provider", name: "Email Provider", columnType: "text" },
      ],
      handlerKey: "findymail.validateEmail",
      implemented: true,
      creditsPerRun: 1,
    },
    {
      key: "work-email-from-profile-url",
      name: "Find work email from profile URL",
      description: "Find a verified work email from a LinkedIn profile URL.",
      docsUrl:
        "https://app.findymail.com/docs/#email-finder-POSTapi-search-business-profile",
      category: "enrich-person-info",
      type: "enrichment",
      tags: ["work email", "linkedin", "profile"],
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
        { key: "email", name: "Work Email", columnType: "email" },
        { key: "fullName", name: "Full Name", columnType: "text" },
        { key: "companyDomain", name: "Company Domain", columnType: "url" },
      ],
      handlerKey: "findymail.workEmailFromProfileUrl",
      implemented: true,
      creditsPerRun: 1,
    },
    {
      key: "find-work-email",
      name: "Find work email",
      description:
        "Find a verified work email from a person's name and company domain.",
      docsUrl:
        "https://app.findymail.com/docs/#email-finder-POSTapi-search-name",
      category: "enrich-person-info",
      type: "enrichment",
      tags: ["work email", "name", "domain"],
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
          description: "The person's company website or domain.",
          valueType: "domain",
          acceptedColumnTypes: ["url"],
          required: true,
        },
      ],
      outputs: [
        { key: "email", name: "Work Email", columnType: "email" },
        { key: "fullName", name: "Full Name", columnType: "text" },
        { key: "companyDomain", name: "Company Domain", columnType: "url" },
      ],
      handlerKey: "findymail.findWorkEmail",
      implemented: true,
      creditsPerRun: 1,
    },
    {
      key: "find-mobile-phone",
      name: "Findymail Find Mobile Phone",
      description: "Find a mobile phone number from a LinkedIn profile URL.",
      docsUrl:
        "https://app.findymail.com/docs/#phone-finder-POSTapi-search-phone",
      category: "enrich-person-info",
      type: "enrichment",
      tags: ["phone", "mobile", "linkedin"],
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
        { key: "phone", name: "Mobile Phone", columnType: "text" },
        { key: "lineType", name: "Line Type", columnType: "text" },
      ],
      handlerKey: "findymail.findMobilePhone",
      implemented: true,
      creditsPerRun: 10,
    },
  ],
};
