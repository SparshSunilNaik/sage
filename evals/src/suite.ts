import { CALC_REPO, type FileMap, task } from "@sage/testkit";

/** Tiny TypeScript fixture repos. Visible tests are protected; hidden tests are never shown to agents. */
export const REPOS: Record<string, FileMap> = {
  calc: CALC_REPO,
  strings: {
    "package.json": JSON.stringify({ name: "strings-fixture", private: true, type: "module" }, null, 2),
    "src/strings.ts": `export function reverse(s: string): string {\n  return [...s].reverse().join("");\n}\n`,
    "tests/strings.test.ts": `import { expect, test } from "bun:test";\nimport { reverse } from "../src/strings.ts";\n\ntest("reverse", () => {\n  expect(reverse("abc")).toBe("cba");\n});\n`,
  },
  todo: {
    "package.json": JSON.stringify({ name: "todo-fixture", private: true, type: "module" }, null, 2),
    "src/todo.ts": `export interface Todo {\n  id: number;\n  title: string;\n  done: boolean;\n}\n\nexport class TodoList {\n  private items: Todo[] = [];\n  private next = 1;\n\n  add(title: string): number {\n    const id = this.next++;\n    this.items.push({ id, title, done: false });\n    return id;\n  }\n\n  list(): Todo[] {\n    return [...this.items];\n  }\n}\n`,
    "tests/todo.test.ts": `import { expect, test } from "bun:test";\nimport { TodoList } from "../src/todo.ts";\n\ntest("add and list", () => {\n  const t = new TodoList();\n  t.add("a");\n  expect(t.list()).toHaveLength(1);\n});\n`,
  },
};

type Action = { tool: string; args: Record<string, unknown> };

export interface EvalTask {
  id: string;
  repo: keyof typeof REPOS;
  goal: string;
  /** Fake mode only: the plan the scripted planner returns and the scripted solution per plan task. */
  fakePlan: ReturnType<typeof task>[];
  fakeSolutions: Record<string, Action[]>;
  /** Hidden acceptance tests, run against the final run branch. Never visible to the agent. */
  hidden: string;
}

const w = (path: string, content: string): Action => ({ tool: "write", args: { path, content } });
const shell = (command: string): Action => ({ tool: "shell", args: { command } });
const MATH_HEAD = `export function add(a: number, b: number): number {\n  return a + b;\n}\n`;
const imp = (names: string, from: string) =>
  `import { expect, test } from "bun:test";\nimport { ${names} } from "../${from}";\n\n`;

export const TASKS: EvalTask[] = [
  {
    id: "calc-multiply",
    repo: "calc",
    goal: "Add an exported function multiply(a: number, b: number): number to src/math.ts.",
    fakePlan: [task("multiply", "add multiply()")],
    fakeSolutions: {
      multiply: [
        w(
          "src/math.ts",
          `${MATH_HEAD}\nexport function multiply(a: number, b: number): number {\n  return a * b;\n}\n`,
        ),
        shell("bun test"),
      ],
    },
    hidden: `${imp("multiply", "src/math.ts")}test("hidden multiply", () => {\n  expect(multiply(6, 7)).toBe(42);\n  expect(multiply(-2, 3)).toBe(-6);\n});\n`,
  },
  {
    id: "calc-divide",
    repo: "calc",
    goal: "Add divide(a: number, b: number): number to src/math.ts. It must throw a RangeError when b is 0.",
    fakePlan: [task("divide", "add divide() with zero check")],
    fakeSolutions: {
      divide: [
        w(
          "src/math.ts",
          `${MATH_HEAD}\nexport function divide(a: number, b: number): number {\n  if (b === 0) throw new RangeError("division by zero");\n  return a / b;\n}\n`,
        ),
      ],
    },
    hidden: `${imp("divide", "src/math.ts")}test("hidden divide", () => {\n  expect(divide(10, 4)).toBe(2.5);\n  expect(() => divide(1, 0)).toThrow(RangeError);\n});\n`,
  },
  {
    id: "calc-stats",
    repo: "calc",
    goal: "Create src/stats.ts with sum(nums: number[]): number and mean(nums: number[]): number (mean of an empty array throws).",
    fakePlan: [task("sum", "add sum()"), task("mean", "add mean() using sum()", { dependsOn: ["sum"] })],
    fakeSolutions: {
      sum: [
        w(
          "src/stats.ts",
          `export function sum(nums: number[]): number {\n  return nums.reduce((a, b) => a + b, 0);\n}\n`,
        ),
      ],
      mean: [
        w(
          "src/stats.ts",
          `export function sum(nums: number[]): number {\n  return nums.reduce((a, b) => a + b, 0);\n}\n\nexport function mean(nums: number[]): number {\n  if (nums.length === 0) throw new Error("mean of empty array");\n  return sum(nums) / nums.length;\n}\n`,
        ),
      ],
    },
    hidden: `${imp("mean, sum", "src/stats.ts")}test("hidden stats", () => {\n  expect(sum([1, 2, 3])).toBe(6);\n  expect(mean([2, 4])).toBe(3);\n  expect(() => mean([])).toThrow();\n});\n`,
  },
  {
    id: "strings-capitalize",
    repo: "strings",
    goal: "Add capitalize(s: string): string to src/strings.ts: upper-case the first character only; empty string stays empty.",
    fakePlan: [task("capitalize", "add capitalize()")],
    fakeSolutions: {
      capitalize: [
        w(
          "src/strings.ts",
          `export function reverse(s: string): string {\n  return [...s].reverse().join("");\n}\n\nexport function capitalize(s: string): string {\n  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;\n}\n`,
        ),
      ],
    },
    hidden: `${imp("capitalize", "src/strings.ts")}test("hidden capitalize", () => {\n  expect(capitalize("hello world")).toBe("Hello world");\n  expect(capitalize("")).toBe("");\n});\n`,
  },
  {
    id: "strings-slugify",
    repo: "strings",
    goal: "Add slugify(s: string): string to src/strings.ts: lower-case, non-alphanumerics become single hyphens, no leading/trailing hyphens.",
    fakePlan: [task("slugify", "add slugify()")],
    fakeSolutions: {
      slugify: [
        w(
          "src/strings.ts",
          `export function reverse(s: string): string {\n  return [...s].reverse().join("");\n}\n\nexport function slugify(s: string): string {\n  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");\n}\n`,
        ),
      ],
    },
    hidden: `${imp("slugify", "src/strings.ts")}test("hidden slugify", () => {\n  expect(slugify("Hello, World!  Foo")).toBe("hello-world-foo");\n  expect(slugify("--A--")).toBe("a");\n});\n`,
  },
  {
    id: "todo-complete",
    repo: "todo",
    goal: "Add complete(id: number): boolean (false for unknown ids) and remaining(): number to TodoList in src/todo.ts.",
    fakePlan: [task("complete", "add complete() and remaining()")],
    fakeSolutions: {
      complete: [
        {
          tool: "edit",
          args: {
            path: "src/todo.ts",
            oldString: "  list(): Todo[] {",
            newString:
              "  complete(id: number): boolean {\n    const t = this.items.find((i) => i.id === id);\n    if (!t) return false;\n    t.done = true;\n    return true;\n  }\n\n  remaining(): number {\n    return this.items.filter((i) => !i.done).length;\n  }\n\n  list(): Todo[] {",
          },
        },
      ],
    },
    hidden: `${imp("TodoList", "src/todo.ts")}test("hidden todo", () => {\n  const t = new TodoList();\n  const a = t.add("a");\n  t.add("b");\n  expect(t.complete(a)).toBe(true);\n  expect(t.complete(999)).toBe(false);\n  expect(t.remaining()).toBe(1);\n});\n`,
  },
  {
    id: "todo-rename",
    repo: "todo",
    goal: "Add rename(id: number, title: string): void to TodoList in src/todo.ts; it throws an Error for unknown ids.",
    fakePlan: [task("rename", "add rename()")],
    fakeSolutions: {
      rename: [
        {
          tool: "edit",
          args: {
            path: "src/todo.ts",
            oldString: "  list(): Todo[] {",
            newString:
              "  rename(id: number, title: string): void {\n    const t = this.items.find((i) => i.id === id);\n    if (!t) throw new Error('unknown todo ' + id);\n    t.title = title;\n  }\n\n  list(): Todo[] {",
          },
        },
      ],
    },
    hidden: `${imp("TodoList", "src/todo.ts")}test("hidden rename", () => {\n  const t = new TodoList();\n  const a = t.add("a");\n  t.rename(a, "b");\n  expect(t.list()[0]?.title).toBe("b");\n  expect(() => t.rename(42, "x")).toThrow();\n});\n`,
  },
];
