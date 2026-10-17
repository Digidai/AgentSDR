# Ported source

Provider definitions, handlers, verifiers, channel rules, call contracts, CRM defaults/policy/instructions, formula parser and OpenRouter helpers originate from Kandid-ai/AgentSDR commit `bdbf5efd2017347181f5bf549b54d89c1ae6e5f5` under the repository's root MIT license. Imports were adapted to the native runtime; no PostgreSQL or server-only runtime dependency is used here.

`quickjs.wasm` comes from the lockfile-pinned `@jitl/quickjs-wasmfile-release-sync` package. Formula library source in `../features/formula-libraries.ts` is generated from lodash, Moment and FormulaJS. Their license files are included in `licenses/`. Refresh these with `npm run vendor:refresh` and verify with the real workerd smoke test.
