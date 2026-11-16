export interface ParsedGate {
  passed: boolean;
  summary: string;
  counts: Record<string, number>;
}

const n = (m: RegExpMatchArray | null) => (m ? Number(m[1]) : 0);

/** Parse `bun test` output. A run with zero tests is a failure (nothing was verified). */
export function parseBunTest(out: string, exitCode: number | null): ParsedGate {
  const pass = n(out.match(/^\s*(\d+) pass\b/m));
  const fail = n(out.match(/^\s*(\d+) fail\b/m));
  const errors = n(out.match(/^\s*(\d+) errors?\b/m));
  const counts = { pass, fail, errors };
  if (pass + fail === 0) return { passed: false, summary: "no tests ran", counts };
  const passed = exitCode === 0 && fail === 0 && errors === 0;
  return { passed, summary: `${pass} pass, ${fail} fail${errors ? `, ${errors} errors` : ""}`, counts };
}

export function parseTsc(out: string, exitCode: number | null): ParsedGate {
  const errors = (out.match(/error TS\d+/g) ?? []).length;
  return {
    passed: exitCode === 0 && errors === 0,
    summary: errors
      ? `${errors} type error(s)`
      : exitCode === 0
        ? "no type errors"
        : `tsc exited ${exitCode}`,
    counts: { errors },
  };
}

export function parseBiome(out: string, exitCode: number | null): ParsedGate {
  const errors = n(out.match(/Found (\d+) errors?/)) || n(out.match(/(\d+) problem\(s\)/));
  return {
    passed: exitCode === 0,
    summary: exitCode === 0 ? "clean" : `${errors || "some"} problem(s)`,
    counts: { errors },
  };
}

export function parseExitCode(_out: string, exitCode: number | null): ParsedGate {
  return { passed: exitCode === 0, summary: `exit ${exitCode}`, counts: {} };
}

export const PARSERS = {
  "bun-test": parseBunTest,
  tsc: parseTsc,
  biome: parseBiome,
  "exit-code": parseExitCode,
} as const;
