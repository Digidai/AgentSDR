// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.
import type { IntegrationDefinition } from "../types";

export const CONTACTOUT: IntegrationDefinition = {
  key: "contactout",
  name: "ContactOut",
  description:
    "Find professional profiles, personal emails, and mobile numbers.",
  websiteUrl: "https://contactout.com",
  iconText: "CO",
  iconBackground: "#38c976",
  auth: {
    type: "api_key",
    fields: [
      {
        key: "apiKey",
        label: "ContactOut API token",
        placeholder: "Paste your ContactOut API token",
        inputType: "password",
        required: true,
      },
    ],
    helpUrl: "https://api.contactout.com/#authentication",
  },
  actions: [
    {
      key: "professional-url-from-personal-email",
      name: "Find professional URL from personal email",
      description:
        "Find a LinkedIn profile URL associated with a personal email address.",
      docsUrl: "https://api.contactout.com/#email-to-linkedin-api",
      category: "enrich-person-info",
      type: "enrichment",
      tags: ["person", "personal email", "linkedin", "profile"],
      inputs: [
        {
          key: "email",
          name: "Personal Email",
          description: "The person's personal email address.",
          valueType: "email",
          acceptedColumnTypes: ["email"],
          required: true,
          example: "alex@example.com",
        },
      ],
      outputs: [
        {
          key: "linkedinUrl",
          name: "Professional URL",
          columnType: "url",
          example: "https://linkedin.com/in/alex",
        },
        {
          key: "email",
          name: "Matched Email",
          columnType: "email",
          example: "alex@example.com",
        },
      ],
      handlerKey: "contactout.professionalUrlFromPersonalEmail",
      implemented: true,
      creditsPerRun: 1,
    },
    {
      key: "mobile-number-from-linkedin",
      name: "Find mobile number from LinkedIn",
      description: "Find mobile numbers associated with a LinkedIn profile.",
      docsUrl: "https://api.contactout.com/#from-linkedin-profile",
      category: "enrich-person-info",
      type: "enrichment",
      tags: ["person", "linkedin", "mobile", "phone"],
      inputs: [
        {
          key: "linkedinUrl",
          name: "LinkedIn URL",
          description:
            "A regular LinkedIn profile URL, not a Sales Navigator or Recruiter URL.",
          valueType: "url",
          acceptedColumnTypes: ["url"],
          required: true,
          example: "https://linkedin.com/in/alex",
        },
      ],
      outputs: [
        {
          key: "mobileNumber",
          name: "Mobile Number",
          columnType: "text",
          example: "+14155552671",
        },
        { key: "phoneNumbers", name: "All Phone Numbers", columnType: "json" },
      ],
      handlerKey: "contactout.mobileNumberFromLinkedIn",
      implemented: true,
      creditsPerRun: 1,
    },
    {
      key: "personal-email-from-linkedin",
      name: "Find personal email from LinkedIn",
      description:
        "Find personal email addresses associated with a LinkedIn profile.",
      docsUrl: "https://api.contactout.com/#from-linkedin-profile",
      category: "enrich-person-info",
      type: "enrichment",
      tags: ["person", "linkedin", "personal email"],
      inputs: [
        {
          key: "linkedinUrl",
          name: "LinkedIn URL",
          description:
            "A regular LinkedIn profile URL, not a Sales Navigator or Recruiter URL.",
          valueType: "url",
          acceptedColumnTypes: ["url"],
          required: true,
          example: "https://linkedin.com/in/alex",
        },
      ],
      outputs: [
        {
          key: "personalEmail",
          name: "Personal Email",
          columnType: "email",
          example: "alex@example.com",
        },
        {
          key: "personalEmails",
          name: "All Personal Emails",
          columnType: "json",
        },
      ],
      handlerKey: "contactout.personalEmailFromLinkedIn",
      implemented: true,
      creditsPerRun: 1,
    },
  ],
};
