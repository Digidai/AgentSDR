// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.

import { PermanentRunError } from "../../grid/runners/types";
import type { CellResult } from "../../grid/types";
import {
  asRecord,
  mapConfiguredOutputs,
  normalizeDomain,
  parseJson,
  truncate,
} from "../server/helpers";
import type {
  IntegrationActionContext,
  IntegrationActionHandlers,
} from "../server/types";

const API_BASE = "https://api.leadmagic.io";

function requestFor(context: IntegrationActionContext): {
  endpoint: string;
  body: Record<string, unknown>;
} {
  const { action, inputs } = context;
  switch (action.handlerKey) {
    case "leadmagic.validateEmail":
      return {
        endpoint: "/v1/people/email-validation",
        body: { email: inputs.email },
      };
    case "leadmagic.findWorkEmail":
      return {
        endpoint: "/v1/people/email-finder",
        body: {
          full_name: inputs.fullName,
          domain: normalizeDomain(String(inputs.companyDomain)),
        },
      };
    case "leadmagic.findPersonalEmail":
      return {
        endpoint: "/v1/people/personal-email-finder",
        body: { profile_url: inputs.profileUrl },
      };
    case "leadmagic.findMobileNumber":
      return {
        endpoint: "/v1/people/mobile-finder",
        body: { profile_url: inputs.profileUrl },
      };
    case "leadmagic.findProfessionalProfile":
      return {
        endpoint: "/v1/people/b2b-profile",
        body: { work_email: inputs.email },
      };
    case "leadmagic.findActiveJobOpenings": {
      const title =
        typeof inputs.jobTitle === "string" ? inputs.jobTitle.trim() : "";
      const postedWithin =
        typeof inputs.postedWithinDays === "number"
          ? inputs.postedWithinDays
          : 30;
      return {
        endpoint: "/v3/jobs/search",
        body: {
          ...(title ? { titles: { include: [title] } } : {}),
          companies: {
            include: [normalizeDomain(String(inputs.companyDomain))],
          },
          postedWithin,
          includeCompany: true,
          includeDescription: false,
          limit: 10,
          totalMode: "none",
          mode: "fast",
          autoResolve: true,
        },
      };
    }
    case "leadmagic.enrichCompany":
      return {
        endpoint: "/v1/companies/company-search",
        body: { company_domain: normalizeDomain(String(inputs.companyDomain)) },
      };
    default:
      throw new PermanentRunError(
        `Unknown LeadMagic action: ${action.handlerKey}`,
      );
  }
}

function responseMessage(body: unknown): string {
  const root = asRecord(body);
  if (typeof root.message === "string") return root.message.slice(0, 300);
  const errors = Array.isArray(root.errors) ? root.errors : [];
  const first = asRecord(errors[0]);
  for (const value of [first.detail, first.title, first.code, root.error]) {
    if (typeof value === "string" && value) return value.slice(0, 300);
  }
  return "request failed";
}

function mappedResult(handlerKey: string, body: unknown) {
  const root = asRecord(body);
  if (handlerKey === "leadmagic.validateEmail") {
    return {
      primary: root.email_status,
      outputs: {
        email: root.email,
        status: root.email_status,
        mxProvider: root.mx_provider,
        companyName: root.company_name,
      },
    };
  }
  if (handlerKey === "leadmagic.findWorkEmail") {
    return {
      primary: root.email,
      outputs: {
        email: root.email,
        status: root.status,
        companyName: root.company_name,
        employmentVerified: root.employment_verified,
      },
    };
  }
  if (handlerKey === "leadmagic.findPersonalEmail") {
    return {
      primary: root.first_personal_email,
      outputs: {
        personalEmail: root.first_personal_email,
        personalEmails: root.personal_emails,
        name: root.name,
      },
    };
  }
  if (handlerKey === "leadmagic.findMobileNumber") {
    return {
      primary: root.mobile_number,
      outputs: {
        mobileNumber: root.mobile_number,
        profileUrl: root.profile_url,
      },
    };
  }
  if (handlerKey === "leadmagic.findProfessionalProfile") {
    return {
      primary: root.profile_url,
      outputs: { profileUrl: root.profile_url, message: root.message },
    };
  }
  if (handlerKey === "leadmagic.findActiveJobOpenings") {
    const jobs = Array.isArray(root.signals) ? root.signals : [];
    const firstJob = asRecord(jobs[0]);
    return {
      primary: jobs.length
        ? `${jobs.length} active job${jobs.length === 1 ? "" : "s"}`
        : undefined,
      outputs: {
        jobs,
        jobCount: jobs.length,
        firstJobTitle: firstJob.title,
        firstJobUrl: firstJob.application_url,
      },
    };
  }
  return {
    primary: root.companyName,
    outputs: {
      companyName: root.companyName,
      websiteUrl: root.websiteUrl,
      industry: root.industry,
      employeeCount: root.employeeCount,
      profileUrl: root.b2b_profile_url ?? root.url,
      description: root.description,
    },
  };
}

async function executeLeadMagic(
  context: IntegrationActionContext,
): Promise<CellResult> {
  const { action, config, credentials, inputs, signal, timeoutMs } = context;
  const request = requestFor(context);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort);
  const started = Date.now();

  try {
    const response = await fetch(`${API_BASE}${request.endpoint}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-API-Key": credentials.apiKey,
      },
      body: JSON.stringify(request.body),
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await response.text();
    const body = parseJson(text);

    if (!response.ok) {
      const message = `LeadMagic returned ${response.status}: ${responseMessage(body)}`;
      if (response.status === 429 || response.status >= 500)
        throw new Error(message);
      throw new PermanentRunError(message);
    }

    const mapped = mappedResult(action.handlerKey, body);
    const found =
      mapped.primary !== null &&
      mapped.primary !== undefined &&
      mapped.primary !== "";
    return {
      value: found ? String(mapped.primary) : "Not found",
      outputs: mapConfiguredOutputs(config, mapped.outputs, body),
      provider: "leadmagic",
      outcome: found ? "hit" : "miss",
      costCents: 0,
      latencyMs: Date.now() - started,
      request: {
        method: "POST",
        endpoint: request.endpoint,
        inputKeys: Object.keys(inputs),
      },
      response: truncate(body),
    };
  } catch (error) {
    if (error instanceof PermanentRunError) throw error;
    if ((error as Error).name === "AbortError") {
      throw new Error(`LeadMagic request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

export const LEADMAGIC_HANDLERS = {
  "leadmagic.validateEmail": executeLeadMagic,
  "leadmagic.findWorkEmail": executeLeadMagic,
  "leadmagic.findPersonalEmail": executeLeadMagic,
  "leadmagic.findMobileNumber": executeLeadMagic,
  "leadmagic.findProfessionalProfile": executeLeadMagic,
  "leadmagic.findActiveJobOpenings": executeLeadMagic,
  "leadmagic.enrichCompany": executeLeadMagic,
} satisfies IntegrationActionHandlers;
