import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runProcess } from "../packages/workspace/src/index.ts";
import { crawl, startServer } from "./serve-site.ts";

setDefaultTimeout(60_000);
const ROOT = join(import.meta.dir, "..");

describe("project website (docs/)", () => {
  test("every page, asset and #anchor resolves when served under /sage/ like GitHub Pages", async () => {
    const s = startServer(0);
    try {
      expect(await crawl(`http://127.0.0.1:${s.port}`)).toEqual([]);
      const missing = await fetch(`http://127.0.0.1:${s.port}/sage/no/such/page`);
      expect(missing.status).toBe(404);
      expect(await missing.text()).toContain("There is no page at this address");
    } finally {
      s.stop(true);
    }
  });

  test("relative links in README, docs and the site resolve", async () => {
    const r = await runProcess([process.execPath, join(ROOT, "scripts", "check-links.ts")], { cwd: ROOT });
    expect(r.stdout).toContain(" 0 broken");
    expect(r.code).toBe(0);
  });

  test("site uses no external scripts, trackers or root-absolute asset paths", () => {
    for (const f of ["docs/index.html", "docs/404.html"]) {
      const html = readFileSync(join(ROOT, f), "utf8");
      expect(html).not.toMatch(/<script[^>]+src="https?:/);
      expect(html).not.toMatch(/googletagmanager|google-analytics|plausible|gtag\(/);
      expect(html).not.toMatch(/\s(?:href|src)="\/(?!\/)/);
    }
    expect(readFileSync(join(ROOT, "docs", ".nojekyll"), "utf8")).toBe("");
  });
});
