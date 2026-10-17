// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.
import type {
  CellResult,
  CellValues,
  ColumnConfig,
  ColumnType,
  PendingCellResult,
} from "../types";

/**
 * What every column runner implements — see docs/design/enrichment-plan.md §6.
 *
 * The shape is deliberately wider than the two runners that exist today: the
 * AI column, and each action of each integration (OpenAI → send message /
 * generate image; Apollo → find email / find person), all become runners
 * behind this same interface. That is why `prepare` exists — an integration
 * action needs to resolve credentials and a rate limit once per run rather
 * than once per row.
 */
export interface ColumnRunner<C = ColumnConfig> {
  /** Column type this runner serves. */
  readonly type: ColumnType;

  /**
   * Column keys the config reads, so the DAG can be built. Derived from the
   * config, never taken from the request.
   */
  resolveDeps(config: C): string[];

  /**
   * Optional per-run setup, shared across every row of one run. Where a
   * QuickJS sandbox is created, or an integration's credentials resolved.
   * Whatever it returns is handed to run() as `session`, and disposed after.
   */
  prepare?(config: C, ctx: RunContext): Promise<RunSession>;

  /** Execute for one row. */
  run(
    config: C,
    row: CellValues,
    ctx: RunContext,
    session?: RunSession,
  ): Promise<CellResult | PendingCellResult>;

  /** Cents this will cost for one row, shown before the user commits. */
  estimateCost(config: C): number;
}

export type RunSession = {
  dispose?: () => void | Promise<void>;
  [key: string]: unknown;
};

export type RunContext = {
  tableId: string;
  rowId: string;
  columnKey: string;
  /** Wall-clock budget for one cell. Runners should respect it. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Persisted continuation data supplied when an asynchronous provider is polled. */
  providerState?: Record<string, unknown> | null;
};

/** Thrown by a runner when the failure is the user's config, not a transient
 *  fault — the queue records it and does NOT retry. */
export class PermanentRunError extends Error {
  readonly permanent = true;
  constructor(
    message: string,
    readonly audit?: {
      provider?: string;
      request?: unknown;
      response?: unknown;
    },
  ) {
    super(message);
    this.name = "PermanentRunError";
  }
}

/**
 * A failure the queue should retry with backoff — a rate limit, a 5xx, a
 * timeout. Carries the same audit fields as PermanentRunError so the run log
 * still records what was sent and what came back.
 */
export class RetryableRunError extends Error {
  readonly permanent = false;
  constructor(
    message: string,
    readonly audit?: {
      provider?: string;
      request?: unknown;
      response?: unknown;
    },
  ) {
    super(message);
    this.name = "RetryableRunError";
  }
}

/**
 * The label a run is recorded under. OpenRouter model keys already carry
 * their vendor ("minimax/minimax-m3"), so the upstream slug is only added
 * when the key does not start with it.
 */
export function aiProviderLabel(
  providerKey: string,
  upstreamProvider: string | undefined,
  modelKey: string,
): string {
  const base = `${providerKey}/${modelKey}`;
  return upstreamProvider && !modelKey.startsWith(`${upstreamProvider}/`)
    ? `${base}@${upstreamProvider}`
    : base;
}

/**
 * A row's own value for `key`. Plain `row[key]` also finds inherited
 * properties, so a column called "constructor" or "toString" would read as a
 * function and be written into a prompt.
 */
export function ownCell(row: CellValues, key: string): unknown {
  return Object.hasOwn(row, key) ? row[key] : undefined;
}

const TOKEN_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** Every distinct {{token}} in a string. */
export function tokensIn(text: string | undefined | null): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(TOKEN_RE)) out.push(m[1]);
  return out;
}

/**
 * Replaces {{key}} with the row's value.
 *
 * An unmatched token resolves to "" rather than being left in place, matching
 * how outreach/scheduler.ts already treats merge fields — a literal "{{name}}"
 * arriving at a provider is worse than an empty string.
 */
export function interpolate(template: string, row: CellValues): string {
  return template.replace(TOKEN_RE, (_, key: string) => {
    const v = ownCell(row, key);
    if (v === null || v === undefined) return "";
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

/** Reads "data.person.email" out of a parsed response. */
export function pluck(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let cur = value;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return null;
    if (Array.isArray(cur) && /^\d+$/.test(part)) cur = cur[Number(part)];
    else if (typeof cur === "object")
      cur = (cur as Record<string, unknown>)[part];
    else return null;
  }
  return cur ?? null;
}
