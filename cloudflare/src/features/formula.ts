import { parseLookupCalls } from "../ported/formula-lookups";
import variant from "@jitl/quickjs-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import { formulaLibraries } from "./formula-libraries";
import type { Env, Row } from "../types";
import { json } from "../core";
let wasmModule: WebAssembly.Module | undefined,
  cached: Promise<QuickJSWASMModule> | undefined;
export function configureFormulaWasm(module: WebAssembly.Module) {
  wasmModule = module;
  cached = undefined;
}
export function formulaTokens(
  expression: string,
  row: Row,
  textKeys: ReadonlySet<string> = new Set(),
) {
  return expression.replace(
    /\{\{\s*([\w]+)\s*\}\}/g,
    (_, key) =>
      JSON.stringify(
        row[key] === undefined || row[key] === null || row[key] === ""
          ? textKeys.has(key)
            ? ""
            : null
          : Object.hasOwn(row, key)
            ? row[key]
            : null,
      ) ?? "null",
  );
}
export async function evaluateFormula(
  expression: string,
  row: Row = {},
  registry: Row = {},
  syntaxOnly = false,
  textKeys: ReadonlySet<string> = new Set(),
) {
  cached ??= newQuickJSWASMModuleFromVariant(
    wasmModule ? newVariant(variant, { wasmModule }) : variant,
  );
  const module = await cached,
    runtime = module.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const until = Date.now() + 1000;
  runtime.setInterruptHandler(() => Date.now() > until);
  const ctx = runtime.newContext();
  try {
    if (!syntaxOnly) {
      const boot = ctx.evalCode(
        formulaLibraries +
          `;if(typeof formulajs==='object')Object.assign(globalThis,formulajs);globalThis.ISBLANK=v=>v===null||v===undefined||v==='';globalThis.LOOKUP=(table,value,lookupColumn,returnColumn,defaultValue=null)=>{const rows=(${JSON.stringify(registry)})[String(table).toLowerCase()]||[];if(value===null||value===undefined||(typeof value==='string'&&!value.trim()))return defaultValue;const k=String(lookupColumn).toLowerCase(),out=String(returnColumn).toLowerCase();const row=rows.find(r=>(r[k]??r[lookupColumn])===value);return row&&(Object.hasOwn(row,out)||Object.hasOwn(row,returnColumn))?(row[out]??row[returnColumn]):defaultValue;};`,
      );
      if (boot.error) {
        const error = ctx.dump(boot.error);
        boot.error.dispose();
        throw new Error(
          "Formula libraries could not load: " +
            String(error?.message || error),
        );
      }
      boot.value.dispose();
    }
    const source = syntaxOnly
      ? `(function(row){"use strict";return (\n${formulaTokens(expression, {})}\n);})`
      : `(function(row){"use strict";return (\n${formulaTokens(expression, row, textKeys)}\n);})(${JSON.stringify(row)})`;
    const result = ctx.evalCode(source);
    if (result.error) {
      const error = ctx.dump(result.error);
      result.error.dispose();
      throw new Error(String(error?.message || error));
    }
    const value = syntaxOnly ? true : ctx.dump(result.value);
    result.value.dispose();
    return value === undefined ? null : value;
  } finally {
    ctx.dispose();
    runtime.dispose();
  }
}
export async function lookupRegistry(
  env: Env,
  org: string,
  expression: string,
) {
  const refs = parseLookupCalls(expression);
  const names = refs.map((r) => r.tableToken);
  const registry: Row = {};
  for (const name of new Set(names)) {
    const tables = await env.DB.prepare(
      "SELECT * FROM enrichment_tables WHERE org_id=? AND (id=? OR lower(name)=lower(?))",
    )
      .bind(org, name, name)
      .all<Row>();
    if (tables.results.length !== 1)
      throw new Error(`LOOKUP table ${name} is unknown or ambiguous`);
    const table = tables.results[0],
      columns = json<Row[]>(table.columns, []),
      rows = await env.DB.prepare(
        "SELECT cells FROM table_rows WHERE org_id=? AND table_id=? LIMIT 50001",
      )
        .bind(org, table.id)
        .all<{ cells: string }>();
    if (rows.results.length > 50000)
      throw new Error("LOOKUP source table exceeds 50,000 rows");
    for (const ref of refs.filter((r) => r.tableToken === name))
      for (const token of [ref.lookupColumnToken, ref.returnColumnToken]) {
        const matching = columns.filter(
          (c) =>
            c.key === token || c.name.toLowerCase() === token.toLowerCase(),
        );
        if (matching.length !== 1)
          throw new Error(`LOOKUP column ${token} is unknown or ambiguous`);
      }
    registry[name.toLowerCase()] = rows.results.map((r) => {
      const cells = json<Row>(r.cells, {});
      return {
        ...cells,
        ...Object.fromEntries(
          columns.flatMap((c) => [
            [c.name.toLowerCase(), cells[c.key]],
            [c.key.toLowerCase(), cells[c.key]],
          ]),
        ),
      };
    });
  }
  return registry;
}
