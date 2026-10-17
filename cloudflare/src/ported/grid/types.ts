// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.
/**
 * Shared types for the enrichment grid — see docs/design/enrichment-plan.md.
 *
 * Kept in a separate file from schema.ts because both the server (runners,
 * queue) and the client (grid rendering, column editors) need them, and
 * schema.ts pulls in drizzle-orm, which has no business in a client bundle.
 */

/** Column types that hold a value the user typed or imported. No runner. */
export type StaticColumnType =
  | "text"
  | "number"
  | "currency"
  | "boolean"
  | "date"
  | "url"
  | "email"
  | "image"
  | "select"
  | "multiselect"
  | "json";

/**
 * Column types whose value is produced by executing something. These mirror
 * the enrichment half of Clay's "Add column" menu; only `http` is implemented
 * (Phase 2), the rest are declared so the menu and the DAG already know about
 * them.
 */
export type RunnerColumnType =
  | "enrichment"
  | "integration_output"
  | "ai_output"
  | "http"
  | "ai"
  | "functions"
  | "message"
  | "waterfall"
  | "formula"
  | "merge";

export type ColumnType = StaticColumnType | RunnerColumnType;

const STATIC_COLUMN_TYPES: readonly StaticColumnType[] = [
  "text",
  "number",
  "currency",
  "boolean",
  "date",
  "url",
  "email",
  "image",
  "select",
  "multiselect",
  "json",
];

const RUNNER_COLUMN_TYPES: readonly RunnerColumnType[] = [
  "enrichment",
  "integration_output",
  "ai_output",
  "http",
  "ai",
  "functions",
  "message",
  "waterfall",
  "formula",
  "merge",
];

export const ALL_COLUMN_TYPES: readonly ColumnType[] = [
  ...STATIC_COLUMN_TYPES,
  ...RUNNER_COLUMN_TYPES,
];

export function isStaticColumnType(t: ColumnType): t is StaticColumnType {
  return (STATIC_COLUMN_TYPES as readonly string[]).includes(t);
}

export function isRunnerColumnType(t: ColumnType): t is RunnerColumnType {
  return (RUNNER_COLUMN_TYPES as readonly string[]).includes(t);
}

// ---------------------------------------------------------------------------
// Per-type column configuration
// ---------------------------------------------------------------------------

export type SelectOption = { value: string; label: string; color?: string };

export type SelectConfig = { options: SelectOption[] };

/** Currency columns render with a symbol; the stored value stays numeric. */
export type CurrencyConfig = { currency: string };

/**
 * A user-configured HTTP call. `url`, `headers` and `body` may contain
 * {{columnKey}} tokens, which resolve against the row's other cells.
 *
 * `authEnvVar` names an environment variable — the credential itself is NEVER
 * stored here, because this row ends up in database dumps that self-hosters
 * share. See docs/design/enrichment-plan.md §6.
 */
export type HttpConfig = {
  method: "GET" | "POST" | "PUT" | "PATCH";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** Dot path into the JSON response, e.g. "data.person.email". */
  responsePath?: string;
  authEnvVar?: string;
  /** Which grid_providers row this call bills against, if any. */
  providerKey?: string;
  /** Flat per-call cost when the provider doesn't report one. */
  costCents?: number;
};

/**
 * What an AI column asks a model to do — the "Use AI" column.
 *
 * Deliberately NOT an integration action: an enrichment has a fixed input and
 * output contract declared by the provider, whereas this is a free-text prompt
 * whose outputs the user defines. They share the credential storage and the
 * runner interface, and nothing else.
 */
export type AiUseCase = "web-research" | "image-generation" | "content";

/** One field the model is asked to return. Becomes its own grid column. */
export type AiOutputField = {
  /** Stable key used in the JSON the model returns. */
  key: string;
  name: string;
  type: StaticColumnType;
  description?: string;
};

/** A worked example, shown to the model to pin down format and tone. */
export type AiExample = {
  /** Column key -> the value that column held in this example. */
  inputs: Record<string, string>;
  response: string;
};

export type AiConfig = {
  useCase: AiUseCase;
  providerKey: string;
  /** Catalog model key, NOT the provider's wire id — see ai/catalog.ts. */
  modelKey: string;
  /** OpenRouter upstream provider slug selected for this model. */
  upstreamProvider?: string;
  connectionId: string;
  /** Prompt template; supports {{columnKey}} tokens. */
  prompt: string;
  /**
   * "fields" asks the model for one JSON object with a key per output field.
   * "json_schema" hands it a schema the user wrote and stores the whole
   * response in a single column.
   */
  outputFormat: "fields" | "json_schema";
  outputs: AiOutputField[];
  jsonSchema?: Record<string, unknown>;
  /** Output field key -> physical grid column key. */
  outputColumns: Record<string, string>;
  examples?: AiExample[];
  maxTokens?: number;
  runCondition?: string;
  delaySeconds?: number;
};

/** A physical result column written by its parent AI column. */
export type AiOutputConfig = {
  sourceColumnKey: string;
  outputKey: string;
  /** Semantic type of the generated value. */
  valueType: StaticColumnType;
};

export type WaterfallStep = {
  providerKey: string;
  config: HttpConfig;
};

export type WaterfallConfig = {
  /** Run in order, stop at the first non-empty result. Cheapest first. */
  steps: WaterfallStep[];
  /** Abandon the row once cumulative spend crosses this. Runaway-cost guard. */
  maxCostCentsPerRow?: number;
};

export type FormulaLookupRef = {
  tableToken: string;
  lookupColumnToken: string;
  returnColumnToken: string;
  tableId: string;
  lookupColumnKey: string;
  returnColumnKey: string;
};

export type FormulaConfig = {
  /** Single-row scalar expression over {{columnKey}} tokens. */
  expression: string;
  /** Server-resolved stable references for cross-table LOOKUP calls. */
  lookupRefs?: FormulaLookupRef[];
};

export type FormulaLookupRegistry = Record<string, Record<string, unknown>>;

export type IntegrationInputBinding = {
  source: "column";
  columnKey: string;
};

export type EnrichmentConfig = {
  integrationKey: string;
  actionKey: string;
  handlerKey: string;
  inputs: Record<string, IntegrationInputBinding>;
  /** Action output key -> physical grid column key. */
  outputs: Record<string, string>;
  connectionId: string;
  runCondition?: string;
  delaySeconds?: number;
  runInBatches?: boolean;
};

export type IntegrationOutputConfig = {
  integrationKey: string;
  actionKey: string;
  sourceColumnKey: string;
  outputKey: string;
  /** Semantic value type used for icons, formatting, filtering, and sorting. */
  valueType?: StaticColumnType;
};

export type ColumnConfig =
  | Record<string, never>
  | SelectConfig
  | CurrencyConfig
  | HttpConfig
  | AiConfig
  | AiOutputConfig
  | WaterfallConfig
  | FormulaConfig
  | EnrichmentConfig
  | IntegrationOutputConfig;

// ---------------------------------------------------------------------------
// Cell state
// ---------------------------------------------------------------------------

/**
 * `idle` means "never run". Static columns stay idle forever — they have no
 * runner, so absence of metadata is the normal case, not an error state.
 */
export type CellStatus =
  | "idle"
  | "queued"
  | "running"
  | "processing"
  | "success"
  | "error"
  | "skipped";

/**
 * The metadata plane, stored in grid_rows.cellMeta keyed by column key —
 * deliberately NOT inline with the value, which keeps the value plane clean
 * and stops JSONB size tripling. See docs/design/enrichment-plan.md §4.
 */
export type CellMeta = {
  status: CellStatus;
  /** Error message from the last failed run, cleared on success. */
  error?: string;
  /** Which provider produced the value — the winning step, for waterfalls. */
  provider?: string;
  /** Cost of the run that produced this value, in cents. Fractional. */
  costCents?: number;
  /** ISO timestamp of the last completed run. */
  runAt?: string;
  /**
   * What a finished run found. `status` stays "success" for a clean miss, so
   * this is how the grid tells "no result" from "never ran". Absent on cells
   * written before it existed and on static values.
   */
  outcome?: "hit" | "miss";
};

/** The value plane: { [columnKey]: value }. */
export type CellValues = Record<string, unknown>;

/** The metadata plane: { [columnKey]: CellMeta }. */
export type CellMetaMap = Record<string, CellMeta>;

/** What a runner returns for one cell. */
export type CellResult = {
  value: unknown;
  /** Additional physical column keys written by the same paid action call. */
  outputs?: CellValues;
  provider?: string;
  outcome: "hit" | "miss" | "error" | "skipped";
  costCents: number;
  /** Audit fields, appended to grid_cell_runs. Optional: a formula has none. */
  latencyMs?: number;
  request?: unknown;
  response?: unknown;
};

/** A provider accepted the request but has not produced its terminal result. */
export type PendingCellResult = {
  pending: true;
  state: Record<string, unknown>;
  pollAfterMs: number;
};

export type JobStatus =
  "queued" | "running" | "waiting" | "done" | "error" | "cancelled";

export type RunOutcome = "hit" | "miss" | "error" | "skipped";

/**
 * A table's saved view — what the toolbar's "Default view" holds.
 *
 * Filter and sort shapes live in query.ts (which imports from here, so they
 * are referenced structurally rather than imported back, keeping this file
 * free of any query-builder dependency).
 */
export type TableView = {
  /** Column keys hidden in the grid. Hidden columns still hold their data. */
  hiddenColumns?: string[];
  /** Columns locked to the left edge, after the row-number gutter. */
  pinnedColumns?: string[];
  filters?: {
    conjunction: "and" | "or";
    conditions: unknown[];
  };
  sorts?: { columnKey: string; direction: "asc" | "desc" }[];
};
