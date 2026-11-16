import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { runTask, TASKS } from "../src/index.ts";

setDefaultTimeout(120_000);

describe("eval harness", () => {
  test("a fake-mode task resolves against its hidden acceptance tests", async () => {
    const t = TASKS.find((x) => x.id === "calc-stats")!;
    const r = await runTask(t, false, 0);
    expect(r.state).toBe("AWAITING_MERGE_APPROVAL");
    expect(r.resolved).toBe(true);
    expect(r.traceable).toBe(1);
    expect(r.attempts).toBe(2); // two planned tasks, one attempt each
  });

  test("every task has a hidden test and a scripted solution for each planned task", () => {
    expect(TASKS.length).toBeGreaterThanOrEqual(5);
    for (const t of TASKS) {
      expect(t.hidden).toContain("bun:test");
      for (const p of t.fakePlan) expect(t.fakeSolutions[p.id]).toBeDefined();
    }
  });
});
