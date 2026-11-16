/**
 * Serve docs/ under the /sage/ prefix, exactly like GitHub Pages serves the project site
 * (https://sparshsunilnaik.github.io/sage/). Missing paths get docs/404.html with status 404.
 *
 * Usage:
 *   bun run scripts/serve-site.ts [--port 4173]      serve until Ctrl+C
 *   bun run scripts/serve-site.ts --check            crawl every page/asset/link once, report 404s, exit
 */
import { existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const DOCS = resolve(import.meta.dir, "..", "docs");
const PREFIX = "/sage/";
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

function fileFor(pathname: string): string | null {
  if (!pathname.startsWith(PREFIX)) return null;
  const rel = decodeURIComponent(pathname.slice(PREFIX.length));
  const p = normalize(join(DOCS, rel));
  if (!p.startsWith(DOCS)) return null;
  if (existsSync(p) && statSync(p).isDirectory()) {
    const idx = join(p, "index.html");
    return existsSync(idx) ? idx : null;
  }
  return existsSync(p) ? p : null;
}

export function startServer(port: number) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/sage") return Response.redirect(`${url.origin}${PREFIX}`, 301);
      const f = fileFor(url.pathname);
      if (!f) {
        return new Response(Bun.file(join(DOCS, "404.html")), {
          status: 404,
          headers: { "content-type": TYPES[".html"]! },
        });
      }
      return new Response(Bun.file(f), {
        headers: { "content-type": TYPES[extname(f)] ?? "application/octet-stream", "cache-control": "no-store" },
      });
    },
  });
}

/** Crawl the site from /sage/: every same-origin href/src must return 200 and every #anchor must exist. */
export async function crawl(base: string): Promise<string[]> {
  const problems: string[] = [];
  const seen = new Set<string>();
  const queue = [`${base}${PREFIX}`, `${base}${PREFIX}404.html`];
  const ids = new Map<string, Set<string>>();
  const anchorChecks: [string, string, string][] = [];
  while (queue.length) {
    const u = queue.shift()!;
    if (seen.has(u)) continue;
    seen.add(u);
    const res = await fetch(u, { redirect: "manual" });
    if (res.status !== 200) {
      problems.push(`${res.status} ${u.replace(base, "")}`);
      continue;
    }
    if (!(res.headers.get("content-type") ?? "").startsWith("text/html")) continue;
    const html = await res.text();
    ids.set(u, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!)));
    for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
      const raw = m[1]!.replace(/&amp;/g, "&");
      if (/^(https?:|mailto:|data:)/.test(raw) && !raw.startsWith(base)) continue;
      const abs = new URL(raw, u);
      if (abs.origin !== base) continue;
      if (raw.startsWith("/")) problems.push(`root-absolute link '${raw}' in ${u.replace(base, "")} (breaks on GitHub Pages)`);
      const page = abs.href.split("#")[0]!;
      if (abs.hash) anchorChecks.push([u, page, abs.hash.slice(1)]);
      queue.push(page);
    }
  }
  for (const [from, page, id] of anchorChecks) {
    if (!ids.get(page)?.has(id)) problems.push(`missing anchor #${id} (linked from ${from.replace(base, "")})`);
  }
  return problems;
}

if (import.meta.main) {
  const i = process.argv.indexOf("--port");
  const port = i > 0 ? Number(process.argv[i + 1]) : 4173;
  if (process.argv.includes("--check")) {
    const s = startServer(0);
    const problems = await crawl(`http://127.0.0.1:${s.port}`);
    s.stop(true);
    for (const p of problems) console.log(`BROKEN  ${p}`);
    console.log(`site crawl: ${problems.length} problem(s)`);
    process.exit(problems.length ? 1 : 0);
  }
  const s = startServer(port);
  console.log(`serving ${DOCS} at http://127.0.0.1:${s.port}${PREFIX}  (Ctrl+C to stop)`);
}
