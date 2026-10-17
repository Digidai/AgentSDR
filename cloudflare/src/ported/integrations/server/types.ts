// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.
import type {
  CellResult,
  EnrichmentConfig,
  PendingCellResult,
} from "../../grid/types";
import type { IntegrationActionDefinition } from "../types";

export type IntegrationActionContext = {
  config: EnrichmentConfig;
  action: IntegrationActionDefinition;
  inputs: Record<string, unknown>;
  credentials: Record<string, string>;
  connectionId: string;
  providerState?: Record<string, unknown> | null;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type IntegrationActionHandler = (
  context: IntegrationActionContext,
) => Promise<CellResult | PendingCellResult>;

export type IntegrationActionHandlers = Readonly<
  Record<string, IntegrationActionHandler>
>;
