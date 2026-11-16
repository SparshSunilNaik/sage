/**
 * Verify every relative link in README.md, docs/**\/*.md and the website (docs/*.html):
 *  - the target file exists;
 *  - `#anchors` exist (GitHub heading slugs for Markdown, `id` attributes for HTML);
 *  - HTML pages use no root-absolute paths (the site is served under /sage/ on GitHub Pages).
 * External http(s) links are not fetched (no network); they are listed with --external.
 *
 * Usage: bun run scripts/check-links.ts [--external]
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const showExternal = process.argv.includes("--external");
const SITE = "https://sparshsunilnaik.github.io/sage/";

function walk(dir: string, out: string[]): void {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(md|html)$/.test(n)) out.push(p);
  }
}

/** GitHub's heading anchor algorithm (close enough for our headings). */
export function githubSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~[\]()]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

const anchorCache = new Map<string, Set<string>>();
function anchorsOf(file: string): Set<string> {
  const hit = anchorCache.get(file);
  if (hit) return hit;
  const text = readFileSync(file, "utf8");
  const set = new Set<string>();
  if (file.endsWith(".md")) {
    const counts = new Map<string, number>();
    let inFence = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^```/.test(line)) inFence = !inFence;
      const m = !inFence && line.match(/^#{1,6}\s+(.+?)\s*#*$/);
      if (!m) continue;
      const base = githubSlug(m[1]!);
      const n = counts.get(base) ?? 0;
      counts.set(base, n + 1);
      set.add(n ? `${base}-${n}` : base);
    }
  } else {
    for (const m of text.matchAll(/\sid="([^"]+)"/g)) set.add(m[1]!);
  }
  anchorCache.set(file, set);
  return set;
}

function linksOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".md")) {
    const noCode = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
    return [...noCode.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]!);
  }
  const refs = [...text.matchAll(/\s(?:href|src)="([^"]+)"/g)].map((m) => m[1]!);
  // <meta content="..."> only matters when it is a URL (og:image, og:url, ...).
  const metaUrls = [...text.matchAll(/\scontent="(https?:[^"]+)"/g)].map((m) => m[1]!);
  return [...refs, ...metaUrls];
}

const files: string[] = ["README.md", "PROGRESS.md", "research.md"].map((f) => join(root, f));
walk(join(root, "docs"), files);
const problems: string[] = [];
const external = new Set<string>();
let checked = 0;

for (const file of files) {
  const rel = relative(root, file).replace(/\\/g, "/");
  for (const raw of linksOf(file)) {
    const link = raw.replace(/&amp;/g, "&");
    // Absolute URLs into the published site (og:image, canonical, 404 home link) must exist locally.
    if (link.startsWith(SITE)) {
      checked++;
      const local = resolve(root, "docs", decodeURIComponent(link.slice(SITE.length).split("#")[0] || "index.html"));
      if (!existsSync(local)) problems.push(`${rel}: '${link}' -> missing ${relative(root, local)}`);
      continue;
    }
    if (/^(https?:|mailto:)/i.test(link)) {
      external.add(link);
      continue;
    }
    if (/^(data:|javascript:|tel:)/i.test(link)) continue;
    if (file.endsWith(".html") && link.startsWith("/")) {
      problems.push(`${rel}: root-absolute path '${link}' breaks under /sage/ on GitHub Pages`);
      continue;
    }
    if (!file.endsWith(".html") && !/[./#]/.test(link[0] ?? "") && !/^[\w-]/.test(link)) continue;
    checked++;
    const [pathPart, anchor] = link.split("#") as [string, string | undefined];
    const target = pathPart ? resolve(dirname(file), decodeURIComponent(pathPart)) : file;
    if (!existsSync(target)) {
      problems.push(`${rel}: '${link}' -> missing ${relative(root, target)}`);
      continue;
    }
    const isDir = statSync(target).isDirectory();
    if (anchor && !isDir && /\.(md|html)$/.test(target) && !anchorsOf(target).has(anchor)) {
      problems.push(`${rel}: '${link}' -> no anchor #${anchor} in ${relative(root, target)}`);
    }
  }
}

if (showExternal) for (const e of [...external].sort()) console.log(`external: ${e}`);
for (const p of problems) console.log(`BROKEN  ${p}`);
console.log(
  `links: ${checked} relative checked across ${files.length} files, ${external.size} external (not fetched), ${problems.length} broken`,
);
process.exit(problems.length ? 1 : 0);
