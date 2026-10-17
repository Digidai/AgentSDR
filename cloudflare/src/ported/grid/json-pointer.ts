// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.
export const RESPONSE_OUTPUT_PREFIX = "response:";

export function responseOutputKey(pointer: string): string {
  return `${RESPONSE_OUTPUT_PREFIX}${pointer}`;
}
export function isResponseOutputKey(key: string): boolean {
  return key.startsWith(`${RESPONSE_OUTPUT_PREFIX}/`);
}

export function responsePointerFromOutputKey(key: string): string | null {
  return isResponseOutputKey(key)
    ? key.slice(RESPONSE_OUTPUT_PREFIX.length)
    : null;
}

/** Resolve an RFC 6901 JSON Pointer against a provider response. */
export function valueAtJsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) return undefined;

  let current = value;
  for (const rawPart of pointer.slice(1).split("/")) {
    const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(part)) return undefined;
      current = current[Number(part)];
      continue;
    }
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
