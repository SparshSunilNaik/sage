/**
 * Biome lint + format check via Biome's official WASM build.
 *
 * Why not the `biome` CLI? On the development machine, Windows Application Control blocks the
 * unsigned native `biome.exe`. The WASM build runs the same rules with the same `biome.json`.
 * CI (Linux/Windows runners) may use either. See docs/adr/0003-tooling-on-windows.md.
 *
 * Usage: bun run scripts/lint.ts [--write]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Biome } from "@biomejs/js-api/nodejs";

const root = join(import.meta.dir, "..");
const write = process.argv.includes("--write");
const ROOTS = ["packages", "evals", "scripts"];
const SKIP = new Set(["node_modules", ".out", "fixtures-tmp"]);

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|json)$/.test(name)) out.push(p);
  }
}

const files: string[] = [];
for (const r of ROOTS) walk(join(root, r), files);

const cfg = JSON.parse(readFileSync(join(root, "biome.json"), "utf8")) as Record<string, unknown>;
delete cfg.$schema;
delete cfg.files;
delete cfg.vcs;

const biome = new Biome();
const { projectKey } = biome.openProject(root);
biome.applyConfiguration(projectKey, cfg);

let problems = 0;
for (const file of files) {
  const rel = relative(root, file).replace(/\\/g, "/");
  const src = readFileSync(file, "utf8");
  let content = src;
  if (write) {
    const fixed = biome.lintContent(projectKey, content, { filePath: rel, fixFileMode: "safeFixes" });
    content = fixed.content;
  }
  const formatted = biome.formatContent(projectKey, content, { filePath: rel });
  if (write) {
    content = formatted.content;
    if (content !== src) writeFileSync(file, content);
  } else if (formatted.content !== src) {
    console.log(`${rel}: not formatted (run: bun run lint:fix)`);
    problems++;
  }
  const lint = biome.lintContent(projectKey, content, { filePath: rel });
  const relevant = lint.diagnostics.filter((d) => d.severity === "error" || d.severity === "warning");
  if (relevant.length) {
    problems += relevant.length;
    const text = biome.printDiagnostics(relevant, { filePath: rel, fileSource: content });
    console.log(
      text
        .replace(/<[^>]+>/g, "")
        .replace(/&gt;/g, ">")
        .replace(/&lt;/g, "<")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&"),
    );
  }
}
biome.shutdown();
console.log(`biome (wasm): ${files.length} files checked, ${problems} problem(s)`);
process.exit(problems ? 1 : 0);
