import { z } from "zod";

const TaskId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "task id must be kebab-case, max 40 chars")
  .describe("short kebab-case identifier");

const RelPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes(".."), {
    message: "path must be relative to the repo root and must not contain '..'",
  });

export const TaskSpec = z.object({
  id: TaskId,
  title: z.string().min(3).max(200),
  description: z.string().min(1).max(8000),
  dependsOn: z.array(TaskId).default([]),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  filesExpected: z.array(RelPath).default([]),
  /** Test files the task is explicitly allowed to create or modify. Everything else under protected paths is read-only. */
  allowedTestFiles: z.array(RelPath).default([]),
});
export type TaskSpec = z.infer<typeof TaskSpec>;

export const Plan = z.object({
  summary: z.string().min(1).max(4000),
  tasks: z.array(TaskSpec).min(1).max(25),
});
export type Plan = z.infer<typeof Plan>;

export type PlanValidation = { ok: true; plan: Plan } | { ok: false; errors: string[] };

/** Validate structure (Zod) and graph properties (unique ids, known deps, acyclic). */
export function validatePlan(input: unknown): PlanValidation {
  const parsed = Plan.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  const plan = parsed.data;
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const t of plan.tasks) {
    if (ids.has(t.id)) errors.push(`duplicate task id '${t.id}'`);
    ids.add(t.id);
  }
  for (const t of plan.tasks) {
    for (const d of t.dependsOn) {
      if (!ids.has(d)) errors.push(`task '${t.id}' depends on unknown task '${d}'`);
      if (d === t.id) errors.push(`task '${t.id}' depends on itself`);
    }
  }
  if (errors.length === 0) {
    const cycle = findCycle(plan.tasks);
    if (cycle) errors.push(`dependency cycle: ${cycle.join(" -> ")}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, plan };
}

function findCycle(tasks: TaskSpec[]): string[] | null {
  const deps = new Map(tasks.map((t) => [t.id, t.dependsOn]));
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    color.set(id, 1);
    stack.push(id);
    for (const d of deps.get(id) ?? []) {
      const c = color.get(d) ?? 0;
      if (c === 1) return [...stack.slice(stack.indexOf(d)), d];
      if (c === 0) {
        const r = visit(d);
        if (r) return r;
      }
    }
    stack.pop();
    color.set(id, 2);
    return null;
  };
  for (const t of tasks) {
    if ((color.get(t.id) ?? 0) === 0) {
      const r = visit(t.id);
      if (r) return r;
    }
  }
  return null;
}

/** Deterministic topological order (stable w.r.t. plan order). */
export function topoOrder(tasks: readonly TaskSpec[]): string[] {
  const done = new Set<string>();
  const out: string[] = [];
  let progressed = true;
  while (out.length < tasks.length && progressed) {
    progressed = false;
    for (const t of tasks) {
      if (done.has(t.id)) continue;
      if (t.dependsOn.every((d) => done.has(d))) {
        done.add(t.id);
        out.push(t.id);
        progressed = true;
      }
    }
  }
  return out;
}
