// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.
type ParsedLookup = {
  tableToken: string;
  lookupColumnToken: string;
  returnColumnToken: string;
};
export function parseLookupCalls(expression: string): ParsedLookup[] {
  const calls: ParsedLookup[] = [];
  const pattern = /\bLOOKUP\s*\(/gi;
  for (const match of expression.matchAll(pattern)) {
    const start = (match.index ?? 0) + match[0].length;
    const { args } = readArguments(expression, start);
    if (args.length < 4 || args.length > 5)
      throw new Error(
        "LOOKUP expects 4 arguments and an optional default value",
      );
    calls.push({
      tableToken: stringLiteral(args[0], "table"),
      lookupColumnToken: stringLiteral(args[2], "lookup column"),
      returnColumnToken: stringLiteral(args[3], "return column"),
    });
  }
  return calls;
}

function readArguments(
  source: string,
  start: number,
): { args: string[]; end: number } {
  const args: string[] = [];
  let quote = "";
  let escaped = false;
  let depth = 0;
  let current = "";
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      current += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ")") {
      if (depth === 0) {
        args.push(current.trim());
        return { args, end: index };
      }
      depth -= 1;
      current += char;
      continue;
    }
    if (char === "]" || char === "}") {
      depth -= 1;
      current += char;
      continue;
    }
    if (char === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  throw new Error("LOOKUP is missing a closing parenthesis");
}

function stringLiteral(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* handled below */
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  }
  throw new Error(`LOOKUP ${label} must be a quoted name, key, or ID`);
}
