// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.
import type { IntegrationDefinition } from "../types";

export const ZEROBOUNCE: IntegrationDefinition = {
  key: "zerobounce",
  name: "ZeroBounce",
  description: "Validate email deliverability in real time with ZeroBounce.",
  websiteUrl: "https://www.zerobounce.net",
  iconText: "ZB",
  iconBackground: "#ffffff",
  auth: {
    type: "api_key",
    fields: [
      {
        key: "apiKey",
        label: "ZeroBounce API key",
        placeholder: "Paste your ZeroBounce API key",
        inputType: "password",
        required: true,
      },
    ],
    helpUrl: "https://www.zerobounce.net/docs/email-validation-api-quickstart/",
  },
  actions: [
    {
      key: "validate-email",
      name: "Validate Email",
      description:
        "Check an email address for deliverability, risk, and mailbox type.",
      docsUrl:
        "https://www.zerobounce.net/docs/email-validation-api-quickstart/v2-validate-emails",
      category: "normalize",
      type: "enrichment",
      tags: ["email", "validate", "deliverability", "catch-all", "spamtrap"],
      inputs: [
        {
          key: "email",
          name: "Email",
          description: "The email address to validate.",
          valueType: "email",
          acceptedColumnTypes: ["email"],
          required: true,
          example: "alex@acme.com",
        },
        {
          key: "ipAddress",
          name: "IP Address",
          description:
            "Optional signup IP address used by ZeroBounce for additional context.",
          valueType: "text",
          acceptedColumnTypes: ["text"],
          required: false,
          example: "156.124.12.145",
        },
      ],
      outputs: [
        { key: "email", name: "Validated Email", columnType: "email" },
        {
          key: "status",
          name: "Validation Status",
          columnType: "text",
          example: "valid",
        },
        {
          key: "subStatus",
          name: "Detailed Status",
          columnType: "text",
          example: "role_based",
        },
        {
          key: "isFreeEmail",
          name: "Free Email Provider",
          columnType: "boolean",
        },
        { key: "isCatchAll", name: "Catch-all Domain", columnType: "boolean" },
        { key: "didYouMean", name: "Suggested Email", columnType: "email" },
        { key: "account", name: "Email Account", columnType: "text" },
        { key: "domain", name: "Email Domain", columnType: "text" },
        {
          key: "domainAgeDays",
          name: "Domain Age (days)",
          columnType: "number",
        },
        { key: "activeInDays", name: "Active In Days", columnType: "text" },
        { key: "mxFound", name: "MX Found", columnType: "boolean" },
        { key: "mxRecord", name: "MX Record", columnType: "text" },
        { key: "smtpProvider", name: "SMTP Provider", columnType: "text" },
        { key: "firstName", name: "First Name", columnType: "text" },
        { key: "lastName", name: "Last Name", columnType: "text" },
        { key: "processedAt", name: "Processed At", columnType: "date" },
      ],
      handlerKey: "zerobounce.validateEmail",
      implemented: true,
      creditsPerRun: 1,
    },
  ],
};
