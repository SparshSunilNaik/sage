import { type EngineSession, type ModelCall, type Plan, validatePlan } from "@sage/core";
import { plannerPrompt, type RepoContext, replanPrompt } from "./prompts.ts";

/** Extract the first JSON object from model output (handles ```json fences and surrounding prose). */
export function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1]! : text;
  const start = candidate.indexOf("{");
  if (start === -1) throw new Error("no JSON object found in planner output");
  let depth = 0;
  let inStr = false;
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(candidate.slice(start, i + 1));
  }
  throw new Error("unterminated JSON object in planner output");
}

export interface PlanRequest {
  session: EngineSession;
  goal: string;
  context: RepoContext;
  gateNames: string[];
  maxAttempts: number;
  onInvalid?: (attempt: number, errors: string[]) => void;
  onModelCall?: (c: ModelCall) => void;
}

export type PlanOutcome =
  | { ok: true; plan: Plan; attempts: number }
  | { ok: false; errors: string[]; attempts: number };

/**
 * Ask the planner agent for a task graph; validate with Zod + graph checks; on failure feed the
 * validator errors back and retry up to `maxAttempts`. Invalid plans never reach the journal as tasks.
 */
export async function planGoal(req: PlanRequest): Promise<PlanOutcome> {
  let prompt = plannerPrompt(req.goal, req.context, req.gateNames);
  let errors: string[] = [];
  for (let attempt = 1; attempt <= req.maxAttempts; attempt++) {
    const turn = await req.session.prompt(prompt, { onModelCall: req.onModelCall });
    if (turn.status !== "completed") {
      errors = [`planner turn ${turn.status}: ${turn.error ?? ""}`];
    } else {
      try {
        const v = validatePlan(extractJson(turn.text));
        if (v.ok) return { ok: true, plan: v.plan, attempts: attempt };
        errors = v.errors;
      } catch (e) {
        errors = [(e as Error).message];
      }
    }
    req.onInvalid?.(attempt, errors);
    prompt = replanPrompt(errors);
  }
  return { ok: false, errors, attempts: req.maxAttempts };
}
