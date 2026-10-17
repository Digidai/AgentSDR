// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.

import type { CellResult, EnrichmentConfig } from "../../grid/types";
import { PermanentRunError } from "../../grid/runners/types";
import type { IntegrationActionDefinition } from "../types";
import type { IntegrationActionHandlers } from "../server/types";
import {
  asRecord,
  errorMessage,
  mapConfiguredOutputs,
  normalizeDomain,
  parseJson,
  truncate,
} from "../server/helpers";

const APOLLO_API_BASE = "https://api.apollo.io/api/v1";

type ApolloRequest = {
  endpoint: string;
  method: "GET" | "POST" | "PATCH";
  query?: URLSearchParams;
  body?: Record<string, unknown>;
};

function textInput(inputs: Record<string, unknown>, key: string): string {
  return String(inputs[key] ?? "").trim();
}

function optionalText(
  inputs: Record<string, unknown>,
  key: string,
): string | undefined {
  return textInput(inputs, key) || undefined;
}

function compactRecord(
  entries: Array<[string, unknown]>,
): Record<string, unknown> {
  return Object.fromEntries(
    entries.filter(([, value]) => value !== undefined && value !== ""),
  );
}

function contactFields(
  inputs: Record<string, unknown>,
): Record<string, unknown> {
  return compactRecord([
    ["first_name", optionalText(inputs, "firstName")],
    ["last_name", optionalText(inputs, "lastName")],
    ["email", optionalText(inputs, "email")],
    ["title", optionalText(inputs, "jobTitle")],
    ["organization_name", optionalText(inputs, "companyName")],
  ]);
}

function buildApolloRequest(
  action: IntegrationActionDefinition,
  inputs: Record<string, unknown>,
): ApolloRequest {
  const query = new URLSearchParams();
  switch (action.handlerKey) {
    case "apollo.findPersonByEmail":
      query.set("email", textInput(inputs, "email"));
      return { endpoint: "/people/match", method: "POST", query };
    case "apollo.findWorkEmail":
      query.set("name", textInput(inputs, "fullName"));
      query.set("domain", normalizeDomain(textInput(inputs, "companyDomain")));
      return { endpoint: "/people/match", method: "POST", query };
    case "apollo.enrichPersonFromLinkedIn":
      query.set("linkedin_url", textInput(inputs, "linkedinUrl"));
      return { endpoint: "/people/match", method: "POST", query };
    case "apollo.enrichCompanyByDomain":
      query.set("domain", normalizeDomain(textInput(inputs, "domain")));
      return { endpoint: "/organizations/enrich", method: "GET", query };
    case "apollo.findUserIdByEmail":
      query.set("page", "1");
      query.set("per_page", "100");
      return { endpoint: "/users/search", method: "GET", query };
    case "apollo.findEmailAccountsForUser":
      return { endpoint: "/email_accounts", method: "GET" };
    case "apollo.updateContactStatusInSequence": {
      const mode = textInput(inputs, "mode");
      if (!["mark_as_finished", "remove", "stop"].includes(mode)) {
        throw new PermanentRunError(
          "Apollo sequence mode must be mark_as_finished, remove, or stop",
        );
      }
      query.append("emailer_campaign_ids[]", textInput(inputs, "sequenceId"));
      query.append("contact_ids[]", textInput(inputs, "contactId"));
      query.set("mode", mode);
      return {
        endpoint: "/emailer_campaigns/remove_or_stop_contact_ids",
        method: "POST",
        query,
      };
    }
    case "apollo.updateContact": {
      const body = contactFields(inputs);
      if (Object.keys(body).length === 0)
        throw new PermanentRunError(
          "Map at least one Apollo contact field to update",
        );
      return {
        endpoint: `/contacts/${encodeURIComponent(textInput(inputs, "contactId"))}`,
        method: "PATCH",
        body,
      };
    }
    case "apollo.findPeopleAtCompanyByJobTitle":
      query.append(
        "q_organization_domains_list[]",
        normalizeDomain(textInput(inputs, "companyDomain")),
      );
      query.append("person_titles[]", textInput(inputs, "jobTitle"));
      query.set("include_similar_titles", "true");
      query.set("page", "1");
      query.set("per_page", "25");
      return { endpoint: "/mixed_people/api_search", method: "POST", query };
    case "apollo.findSavedContacts":
      return {
        endpoint: "/contacts/search",
        method: "POST",
        body: { q_keywords: textInput(inputs, "query"), page: 1, per_page: 25 },
      };
    case "apollo.findContactById":
      return {
        endpoint: `/contacts/${encodeURIComponent(textInput(inputs, "contactId"))}`,
        method: "GET",
      };
    case "apollo.findOpenJobs":
      query.set("page", "1");
      query.set("per_page", "25");
      return {
        endpoint: `/organizations/${encodeURIComponent(textInput(inputs, "organizationId"))}/job_postings`,
        method: "GET",
        query,
      };
    case "apollo.findAccountById":
      return {
        endpoint: `/accounts/${encodeURIComponent(textInput(inputs, "accountId"))}`,
        method: "GET",
      };
    case "apollo.findOrCreateContact":
      return {
        endpoint: "/contacts",
        method: "POST",
        body: { ...contactFields(inputs), run_dedupe: true },
      };
    case "apollo.addContactToSequence": {
      const sequenceId = textInput(inputs, "sequenceId");
      query.set("emailer_campaign_id", sequenceId);
      query.append("contact_ids[]", textInput(inputs, "contactId"));
      query.set(
        "send_email_from_email_account_id",
        textInput(inputs, "emailAccountId"),
      );
      return {
        endpoint: `/emailer_campaigns/${encodeURIComponent(sequenceId)}/add_contact_ids`,
        method: "POST",
        query,
      };
    }
    default:
      throw new PermanentRunError(
        `Unknown Apollo action: ${action.handlerKey}`,
      );
  }
}

async function runApollo(
  config: EnrichmentConfig,
  action: IntegrationActionDefinition,
  inputs: Record<string, unknown>,
  apiKey: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CellResult> {
  const request = buildApolloRequest(action, inputs);
  const queryString = request.query?.toString();
  const url = `${APOLLO_API_BASE}${request.endpoint}${queryString ? `?${queryString}` : ""}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: request.method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: request.body ? JSON.stringify(request.body) : undefined,
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await response.text();
    const body = parseJson(text);
    if (!response.ok) {
      const providerMessage = errorMessage(body, text);
      const message = `Apollo returned ${response.status}${providerMessage ? `: ${providerMessage}` : ""}`;
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 429
      )
        throw new PermanentRunError(message);
      throw new Error(message);
    }
    const logicalOutputs = extractApolloOutputs(
      action.handlerKey,
      body,
      inputs,
    );
    const outputs = mapConfiguredOutputs(config, logicalOutputs, body);
    const found = hasApolloResult(action.handlerKey, logicalOutputs);
    return {
      value: found ? "Found" : "Not found",
      outputs,
      provider: "apollo",
      outcome: found ? "hit" : "miss",
      costCents: 0,
      latencyMs: Date.now() - started,
      request: {
        method: request.method,
        endpoint: request.endpoint,
        inputKeys: Object.keys(inputs),
      },
      response: truncate(body),
    };
  } catch (error) {
    if (error instanceof PermanentRunError) throw error;
    if ((error as Error).name === "AbortError")
      throw new Error(`Apollo request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

function hasApolloResult(
  handlerKey: string,
  outputs: Record<string, unknown>,
): boolean {
  if (handlerKey === "apollo.findPeopleAtCompanyByJobTitle")
    return records(outputs.people).length > 0;
  if (handlerKey === "apollo.findSavedContacts")
    return records(outputs.contacts).length > 0;
  if (handlerKey === "apollo.findOpenJobs")
    return records(outputs.jobs).length > 0;
  if (handlerKey === "apollo.findEmailAccountsForUser")
    return records(outputs.emailAccounts).length > 0;
  return Object.values(outputs).some(
    (value) =>
      value !== null &&
      value !== undefined &&
      value !== "" &&
      value !== false &&
      (!Array.isArray(value) || value.length > 0),
  );
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function contactOutput(
  contact: Record<string, unknown>,
): Record<string, unknown> {
  return {
    contactId: contact.id,
    name:
      contact.name ??
      [contact.first_name, contact.last_name].filter(Boolean).join(" "),
    email: contact.email,
    jobTitle: contact.title,
    companyName:
      contact.organization_name ?? asRecord(contact.organization).name,
  };
}

function extractApolloOutputs(
  handlerKey: string,
  body: unknown,
  inputs: Record<string, unknown>,
): Record<string, unknown> {
  const root = asRecord(body);
  if (handlerKey === "apollo.enrichCompanyByDomain") {
    const organization = asRecord(root.organization);
    return {
      companyName: organization.name,
      industry: organization.industry,
      employeeCount: organization.estimated_num_employees,
      linkedinUrl: organization.linkedin_url,
    };
  }
  if (
    [
      "apollo.findPersonByEmail",
      "apollo.findWorkEmail",
      "apollo.enrichPersonFromLinkedIn",
    ].includes(handlerKey)
  ) {
    const person = asRecord(root.person);
    const organization = asRecord(person.organization);
    return {
      firstName: person.first_name,
      lastName: person.last_name,
      jobTitle: person.title,
      companyName: organization.name,
      linkedinUrl: person.linkedin_url,
      email: person.email,
      emailStatus: person.email_status,
    };
  }
  if (handlerKey === "apollo.findUserIdByEmail") {
    const expected = textInput(inputs, "email").toLowerCase();
    const user =
      records(root.users).find(
        (candidate) => String(candidate.email ?? "").toLowerCase() === expected,
      ) ?? {};
    return {
      userId: user.id,
      name:
        user.name ??
        [user.first_name, user.last_name].filter(Boolean).join(" "),
      email: user.email,
    };
  }
  if (handlerKey === "apollo.findEmailAccountsForUser") {
    const matches = records(root.email_accounts).filter(
      (account) =>
        String(account.user_id ?? "") === textInput(inputs, "userId"),
    );
    const preferred =
      matches.find((account) => account.default === true) ?? matches[0] ?? {};
    return {
      emailAccountId: preferred.id,
      email: preferred.email,
      emailAccounts: matches,
    };
  }
  if (handlerKey === "apollo.updateContactStatusInSequence")
    return { updated: true };
  if (
    [
      "apollo.updateContact",
      "apollo.findContactById",
      "apollo.findOrCreateContact",
    ].includes(handlerKey)
  ) {
    const output = contactOutput(asRecord(root.contact));
    return handlerKey === "apollo.findOrCreateContact"
      ? { ...output, created: root.created ?? root.was_created ?? null }
      : output;
  }
  if (handlerKey === "apollo.findPeopleAtCompanyByJobTitle") {
    const people = Array.isArray(root.people) ? root.people : [];
    return { people, resultCount: people.length };
  }
  if (handlerKey === "apollo.findSavedContacts") {
    const contacts = Array.isArray(root.contacts) ? root.contacts : [];
    return { contacts, resultCount: contacts.length };
  }
  if (handlerKey === "apollo.findOpenJobs") {
    const jobs = Array.isArray(root.organization_job_postings)
      ? root.organization_job_postings
      : [];
    return { jobs, jobCount: jobs.length };
  }
  if (handlerKey === "apollo.findAccountById") {
    const account = asRecord(root.account);
    return {
      accountId: account.id,
      companyName: account.name,
      domain: account.primary_domain ?? account.domain ?? account.website_url,
      industry: account.industry,
      employeeCount: account.estimated_num_employees,
    };
  }
  if (handlerKey === "apollo.addContactToSequence") return { added: true };
  return {};
}

const executeApollo: IntegrationActionHandlers[string] = ({
  config,
  action,
  inputs,
  credentials,
  timeoutMs,
  signal,
}) => runApollo(config, action, inputs, credentials.apiKey, timeoutMs, signal);

export const APOLLO_HANDLERS = {
  "apollo.findPersonByEmail": executeApollo,
  "apollo.findWorkEmail": executeApollo,
  "apollo.enrichPersonFromLinkedIn": executeApollo,
  "apollo.enrichCompanyByDomain": executeApollo,
  "apollo.findUserIdByEmail": executeApollo,
  "apollo.findEmailAccountsForUser": executeApollo,
  "apollo.updateContactStatusInSequence": executeApollo,
  "apollo.updateContact": executeApollo,
  "apollo.findPeopleAtCompanyByJobTitle": executeApollo,
  "apollo.findSavedContacts": executeApollo,
  "apollo.findContactById": executeApollo,
  "apollo.findOpenJobs": executeApollo,
  "apollo.findAccountById": executeApollo,
  "apollo.findOrCreateContact": executeApollo,
  "apollo.addContactToSequence": executeApollo,
} satisfies IntegrationActionHandlers;
