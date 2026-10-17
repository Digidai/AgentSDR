// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.
import type { StaticColumnType } from "../grid/types";

export type ActionCategory =
  | "ai"
  | "enrich-company-info"
  | "enrich-person-info"
  | "extract"
  | "normalize"
  | "score"
  | "organize"
  | "summarize"
  | "tools";

export type ActionExecutionType =
  "enrichment" | "waterfall" | "ai" | "function";

export type InputValueType =
  "text" | "email" | "url" | "domain" | "number" | "boolean" | "date" | "json";

export type ActionInputDefinition = {
  key: string;
  name: string;
  description: string;
  valueType: InputValueType;
  /** Grid column types accepted by the mapping UI and server validator. */
  acceptedColumnTypes: StaticColumnType[];
  required: boolean;
  example?: string;
  /** Optional presentation group for actions that expose an addable filter builder. */
  group?: "filter" | "advanced";
  /** Accept a scalar cell or a list-valued cell and normalize it provider-side. */
  multiple?: boolean;
  /** Retain a persisted input contract without offering it for new mappings. */
  hidden?: boolean;
};

export type ActionOutputDefinition = {
  key: string;
  name: string;
  description?: string;
  columnType: StaticColumnType;
  example?: string;
};

export type IntegrationActionDefinition = {
  key: string;
  name: string;
  description: string;
  /** Official provider documentation for this specific action. */
  docsUrl: string;
  category: ActionCategory;
  type: ActionExecutionType;
  tags: string[];
  inputs: ActionInputDefinition[];
  outputs: ActionOutputDefinition[];
  handlerKey: string;
  /** False until the provider-specific server handler is registered. */
  implemented: boolean;
  /** Render named filter inputs as addable rows and require this many mappings. */
  filterBuilder?: {
    minFilters: number;
  };
  creditsPerRun?: number;
  async?: {
    maxBatchSize: number;
    pollAfterMs: number;
    timeoutMs: number;
    webhookSupported: boolean;
  };
};

export type IntegrationDefinition = {
  key: string;
  name: string;
  description: string;
  /** Canonical provider website. Used for the favicon fallback. */
  websiteUrl: string;
  /** Preferred local or remote SVG/logo asset. */
  iconUrl?: string;
  iconText: string;
  iconBackground: string;
  auth: {
    type: "api_key" | "oauth2";
    fields: Array<{
      key: string;
      label: string;
      placeholder?: string;
      inputType: "text" | "password";
      required: boolean;
    }>;
    helpUrl?: string;
  };
  actions: IntegrationActionDefinition[];
};
