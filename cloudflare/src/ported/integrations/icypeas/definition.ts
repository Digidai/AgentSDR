// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.
import type {
  IntegrationActionDefinition,
  IntegrationDefinition,
} from "../types";

const emailOutput = [
  { key: "email", name: "Work Email", columnType: "email" as const },
  { key: "certainty", name: "Certainty", columnType: "text" as const },
  { key: "mxProvider", name: "MX Provider", columnType: "text" as const },
];
type IcypeasAction = Omit<
  IntegrationActionDefinition,
  "category" | "type" | "tags" | "implemented"
> & {
  category?: IntegrationActionDefinition["category"];
};

const action = ({
  category = "enrich-person-info",
  ...value
}: IcypeasAction): IntegrationActionDefinition => ({
  ...value,
  category,
  type: "enrichment",
  tags: ["icypeas", "enrichment"],
  implemented: true,
});

export const ICYPEAS: IntegrationDefinition = {
  key: "icypeas",
  name: "Icypeas",
  description:
    "Discover and verify emails, find professional profiles, and enrich people and companies.",
  websiteUrl: "https://www.icypeas.com",
  iconText: "I",
  iconBackground: "#c9fae6",
  auth: {
    type: "api_key",
    fields: [
      {
        key: "apiKey",
        label: "Icypeas API key",
        placeholder: "Paste your Icypeas API key",
        inputType: "password",
        required: true,
      },
    ],
    helpUrl: "https://api-doc.icypeas.com/api-auth/access-keys/",
  },
  actions: [
    action({
      key: "verify-email",
      name: "Verify email",
      description:
        "Verify an email address and return its deliverability status.",
      docsUrl: "https://api-doc.icypeas.com/find-emails/email-verification/",
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
        { key: "status", name: "Verification Status", columnType: "text" },
        { key: "certainty", name: "Certainty", columnType: "text" },
        { key: "details", name: "Verification Details", columnType: "json" },
      ],
      handlerKey: "icypeas.verifyEmail",
    }),
    action({
      key: "find-professional-profile",
      name: "Find professional profile",
      description: "Find a professional profile URL from a name and company.",
      docsUrl: "https://api-doc.icypeas.com/scrape/user-profile-url-search/",
      inputs: [
        {
          key: "firstName",
          name: "First Name",
          description: "Person's first name.",
          valueType: "text",
          acceptedColumnTypes: ["text"],
          required: true,
        },
        {
          key: "lastName",
          name: "Last Name",
          description: "Person's last name.",
          valueType: "text",
          acceptedColumnTypes: ["text"],
          required: true,
        },
        {
          key: "company",
          name: "Company or Domain",
          description: "Company name, domain, or website.",
          valueType: "text",
          acceptedColumnTypes: ["text", "url"],
          required: true,
        },
      ],
      outputs: [
        {
          key: "profileUrl",
          name: "Professional Profile URL",
          columnType: "url",
        },
      ],
      handlerKey: "icypeas.findProfessionalProfile",
      creditsPerRun: 0.5,
    }),
    action({
      key: "find-people-at-company",
      name: "Find people at company",
      description: "Find people currently working at a company.",
      docsUrl: "https://api-doc.icypeas.com/leads-db/find-people/",
      inputs: [
        {
          key: "domain",
          name: "Company Domain",
          description: "Company domain or website.",
          valueType: "domain",
          acceptedColumnTypes: ["url"],
          required: true,
        },
      ],
      outputs: [
        { key: "people", name: "People", columnType: "json" },
        { key: "resultCount", name: "Result Count", columnType: "number" },
      ],
      handlerKey: "icypeas.findPeopleAtCompany",
      creditsPerRun: 0.1,
    }),
    action({
      key: "find-emails-for-domain",
      name: "Find emails for domain",
      description: "Scan a domain for role-based email addresses.",
      docsUrl: "https://api-doc.icypeas.com/find-emails/domain-scan/",
      inputs: [
        {
          key: "domain",
          name: "Company Domain",
          description: "Company domain or website.",
          valueType: "domain",
          acceptedColumnTypes: ["url"],
          required: true,
        },
      ],
      outputs: [
        { key: "emails", name: "Emails", columnType: "json" },
        { key: "resultCount", name: "Result Count", columnType: "number" },
      ],
      handlerKey: "icypeas.findEmailsForDomain",
      creditsPerRun: 0.5,
    }),
    action({
      key: "find-work-email",
      name: "Find work email",
      description: "Find a professional email from a name and company.",
      docsUrl: "https://api-doc.icypeas.com/find-emails/email-discovery/",
      inputs: [
        {
          key: "firstName",
          name: "First Name",
          description: "Person's first name.",
          valueType: "text",
          acceptedColumnTypes: ["text"],
          required: true,
        },
        {
          key: "lastName",
          name: "Last Name",
          description: "Person's last name.",
          valueType: "text",
          acceptedColumnTypes: ["text"],
          required: true,
        },
        {
          key: "company",
          name: "Company or Domain",
          description: "Company name, domain, or website.",
          valueType: "text",
          acceptedColumnTypes: ["text", "url"],
          required: true,
        },
      ],
      outputs: emailOutput,
      handlerKey: "icypeas.findWorkEmail",
      creditsPerRun: 0.2,
    }),
    action({
      key: "find-company-professional-profile",
      name: "Find company professional profile",
      description: "Find a company's professional-network profile URL.",
      docsUrl: "https://api-doc.icypeas.com/scrape/company-profile-url-search/",
      category: "enrich-company-info",
      inputs: [
        {
          key: "company",
          name: "Company or Domain",
          description: "Company name, domain, or website.",
          valueType: "text",
          acceptedColumnTypes: ["text", "url"],
          required: true,
        },
      ],
      outputs: [
        { key: "profileUrl", name: "Company Profile URL", columnType: "url" },
      ],
      handlerKey: "icypeas.findCompanyProfessionalProfile",
      creditsPerRun: 0.5,
    }),
    action({
      key: "enrich-profile",
      name: "Enrich profile",
      description: "Scrape and enrich a professional profile.",
      docsUrl: "https://api-doc.icypeas.com/scrape/scrape-profile-scraper/",
      inputs: [
        {
          key: "profileUrl",
          name: "Professional Profile URL",
          description: "Professional profile URL to enrich.",
          valueType: "url",
          acceptedColumnTypes: ["url"],
          required: true,
        },
      ],
      outputs: [
        { key: "fullName", name: "Full Name", columnType: "text" },
        { key: "jobTitle", name: "Job Title", columnType: "text" },
        { key: "companyName", name: "Company Name", columnType: "text" },
        { key: "location", name: "Location", columnType: "text" },
        { key: "profile", name: "Full Profile", columnType: "json" },
      ],
      handlerKey: "icypeas.enrichProfile",
      creditsPerRun: 1,
    }),
    action({
      key: "enrich-company",
      name: "Enrich company",
      description: "Scrape and enrich a company profile.",
      docsUrl: "https://api-doc.icypeas.com/scrape/scrape-company-scraper/",
      category: "enrich-company-info",
      inputs: [
        {
          key: "profileUrl",
          name: "Company Profile URL",
          description: "Company professional profile URL.",
          valueType: "url",
          acceptedColumnTypes: ["url"],
          required: true,
        },
      ],
      outputs: [
        { key: "companyName", name: "Company Name", columnType: "text" },
        { key: "domain", name: "Domain", columnType: "url" },
        { key: "industry", name: "Industry", columnType: "text" },
        { key: "employeeCount", name: "Employee Count", columnType: "number" },
        { key: "location", name: "Location", columnType: "text" },
        { key: "company", name: "Full Company", columnType: "json" },
      ],
      handlerKey: "icypeas.enrichCompany",
      creditsPerRun: 0.5,
    }),
  ],
};
