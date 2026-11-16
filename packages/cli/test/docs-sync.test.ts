import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runProcess } from "@sage/workspace";

setDefaultTimeout(120_000);
const ROOT = join(import.meta.dir, "..", "..", "..");
const BIN = join(ROOT, "packages", "cli", "src", "bin.ts");

/** Rows of the README "Command reference" table: command name -> long flags it documents. */
function readmeCommands(): Map<string, Set<string>> {
  const md = readFileSync(join(ROOT, "README.md"), "utf8");
  const section = md.slice(md.indexOf("## Command reference"), md.indexOf("Developer scripts"));
  const rows = new Map<string, Set<string>>();
  for (const m of section.matchAll(/^\| `sage (\w+)([^`]*)` \|/gm)) {
    rows.set(m[1]!, new Set([...m[2]!.matchAll(/--[a-z][a-z-]*/g)].map((x) => x[0])));
  }
  return rows;
}

describe("README command reference matches `--help`", () => {
  const rows = readmeCommands();
  test("every CLI command is documented and every documented command exists", async () => {
    const help = await runProcess([process.execPath, BIN, "--help"], { cwd: ROOT });
    const cmds = new Set(
      [...help.stdout.matchAll(/^ {2}(\w+)(?: \[options\])?[ <[]/gm)]
        .map((m) => m[1]!)
        .filter((c) => c !== "help"),
    );
    expect([...rows.keys()].sort()).toEqual([...cmds].sort());
  });

  for (const [cmd, documented] of readmeCommands()) {
    test(`sage ${cmd}: documented flags == --help flags`, async () => {
      const r = await runProcess([process.execPath, BIN, cmd, "--help"], { cwd: ROOT });
      expect(r.code).toBe(0);
      const actual = new Set(
        [...r.stdout.matchAll(/--[a-z][a-z-]*/g)].map((x) => x[0]).filter((f) => f !== "--help"),
      );
      expect([...documented].sort()).toEqual([...actual].sort());
      // Every option has a description in --help.
      for (const line of r.stdout.split(/\r?\n/).filter((l) => /^\s+-/.test(l) && !l.includes("--help"))) {
        expect(line.trim().split(/\s{2,}/).length).toBeGreaterThanOrEqual(2);
      }
    });
  }
});
