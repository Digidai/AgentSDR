import { build } from "esbuild";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { zipSync } from "fflate";
const root = fileURLToPath(
    new URL("../../extensions/whatsapp-recorder/", import.meta.url),
  ),
  out = fileURLToPath(new URL("../.wrangler/recorder/", import.meta.url));
await mkdir(out, { recursive: true });
await build({
  entryPoints: [
    "background",
    "wa-hook",
    "wa-agent",
    "bridge",
    "options",
    "update",
  ].map((x) => path.join(root, "src", x + ".ts")),
  bundle: true,
  nodePaths: [path.resolve("node_modules")],
  outdir: out,
  target: "chrome116",
  format: "iife",
  minify: true,
});
await cp(path.join(root, "static"), out, { recursive: true });
const manifest = JSON.parse(
  await readFile(path.join(out, "manifest.json"), "utf8"),
);
manifest.version = "0.15.1";
manifest.host_permissions.push("https://sdr.genedai.me/*");
manifest.content_scripts[0].matches.push("https://sdr.genedai.me/*");
await writeFile(
  path.join(out, "manifest.json"),
  JSON.stringify(manifest, null, 2),
);
const files = {};
async function visit(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) await visit(p);
    else
      files["agentsdr-call-recorder/" + path.relative(out, p)] = new Uint8Array(
        await readFile(p),
      );
  }
}
await visit(out);
await mkdir("web/public", { recursive: true });
await writeFile(
  "web/public/recorder.zip",
  zipSync(files, { level: 9, mtime: new Date("2026-10-17T00:00:00Z") }),
);
console.log(
  "Built native-compatible recorder extension: " +
    Object.keys(files).length +
    " files",
);
