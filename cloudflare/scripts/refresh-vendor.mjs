import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
const sources=['lodash/lodash.min.js','moment/min/moment.min.js','@formulajs/formulajs/lib/browser/formula.min.js'];
const parts=await Promise.all(sources.map(file=>readFile('node_modules/'+file,'utf8')));
await writeFile('src/features/formula-libraries.ts','// MIT-licensed lodash, Moment and FormulaJS browser distributions, evaluated only inside QuickJS.\nexport const formulaLibraries = '+JSON.stringify(parts.join('\n'))+';\n');
await copyFile('node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm','src/ported/quickjs.wasm');
await mkdir('src/ported/licenses',{recursive:true});
for(const name of ['lodash','moment','@formulajs/formulajs','@jitl/quickjs-wasmfile-release-sync'])await copyFile('node_modules/'+name+'/LICENSE','src/ported/licenses/'+name.replaceAll('/','-').replaceAll('@','')+'.txt');
