// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.
import type { IntegrationDefinition } from "../types";

export const MILLIONVERIFIER: IntegrationDefinition = {
  key: "millionverifier",
  name: "MillionVerifier",
  description: "Verify email deliverability in real time with MillionVerifier.",
  websiteUrl: "https://www.millionverifier.com",
  iconText: "MV",
  iconBackground: "#635bff",
  auth: {
    type: "api_key",
    fields: [
      {
        key: "apiKey",
        label: "MillionVerifier API key",
        placeholder: "Paste your MillionVerifier API key",
        inputType: "password",
        required: true,
      },
    ],
    helpUrl: "https://app.millionverifier.com/api",
  },
  actions: [
    {
      key: "verify-email",
      name: "Verify email",
      description:
        "Check an email address for deliverability, risk, and mailbox type.",
      docsUrl:
        "https://developer.millionverifier.com/#operation/single-verification",
      category: "normalize",
      type: "enrichment",
      tags: ["email", "verify", "deliverability", "disposable", "catch-all"],
      inputs: [
        {
          key: "email",
          name: "Email",
          description: "The email address to verify.",
          valueType: "email",
          acceptedColumnTypes: ["email"],
          required: true,
          example: "alex@acme.com",
        },
      ],
      outputs: [
        {
          key: "email",
          name: "Verified Email",
          columnType: "email",
          example: "alex@acme.com",
        },
        {
          key: "result",
          name: "Verification Result",
          columnType: "text",
          example: "ok",
        },
        {
          key: "quality",
          name: "Email Quality",
          columnType: "text",
          example: "good",
        },
        {
          key: "resultCode",
          name: "Result Code",
          columnType: "number",
          example: "1",
        },
        {
          key: "subresult",
          name: "Detailed Result",
          columnType: "text",
          example: "ok",
        },
        {
          key: "isFreeEmail",
          name: "Free Email Provider",
          columnType: "boolean",
        },
        { key: "isRoleBased", name: "Role-based Email", columnType: "boolean" },
        {
          key: "didYouMean",
          name: "Suggested Email",
          columnType: "email",
          example: "alex@gmail.com",
        },
        {
          key: "creditsRemaining",
          name: "Credits Remaining",
          columnType: "number",
        },
        {
          key: "executionTimeMs",
          name: "Execution Time (ms)",
          columnType: "number",
        },
        { key: "liveMode", name: "Live Mode", columnType: "boolean" },
      ],
      handlerKey: "millionverifier.verifyEmail",
      implemented: true,
      creditsPerRun: 1,
    },
  ],
};
