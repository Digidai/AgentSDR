// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.
import type { EnrichmentConfig } from "../../grid/types";
import {
  responsePointerFromOutputKey,
  valueAtJsonPointer,
} from "../../grid/json-pointer";

const MAX_AUDIT_BYTES = 256 * 1024;

export function mapConfiguredOutputs(
  config: EnrichmentConfig,
  logicalOutputs: Record<string, unknown>,
  response: unknown,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config.outputs).map(([outputKey, columnKey]) => {
      const pointer = responsePointerFromOutputKey(outputKey);
      const value =
        pointer === null
          ? logicalOutputs[outputKey]
          : valueAtJsonPointer(response, pointer);
      return [columnKey, value ?? null];
    }),
  );
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeDomain(value: string): string {
  const trimmed = value.trim();
  try {
    return new URL(
      trimmed.includes("://") ? trimmed : `https://${trimmed}`,
    ).hostname.replace(/^www\./, "");
  } catch {
    return trimmed
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0];
  }
}

export function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return text;
  }
}

export function errorMessage(body: unknown, fallback: string): string {
  const record = asRecord(body);
  const value = record.error ?? record.message;
  return typeof value === "string"
    ? value.slice(0, 300)
    : fallback.slice(0, 300);
}

export function truncate(value: unknown): unknown {
  try {
    const json = JSON.stringify(value);
    return json.length > MAX_AUDIT_BYTES
      ? { truncated: true, preview: json.slice(0, MAX_AUDIT_BYTES) }
      : value;
  } catch {
    return null;
  }
}
