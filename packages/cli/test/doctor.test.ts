import { describe, expect, test } from "bun:test";
import { parseAuthList, parseEngineVersion } from "../src/doctor-util.ts";

describe("doctor helpers", () => {
  test("engine version strips the v prefix (regression: 'v2.3.0' != '2.3.0')", () => {
    expect(parseEngineVersion("opencode v2.3.0\n")).toBe("2.3.0");
    expect(parseEngineVersion("2.3.0")).toBe("2.3.0");
  });
  test("auth list yields integration names only, never secrets", () => {
    expect(parseAuthList("OpenAI  OpenAI                      stored\n")).toEqual(["OpenAI"]);
    expect(parseAuthList("sk-ant-api03-abc stored\nAnthropic  key  stored\n")).toEqual(["Anthropic"]);
    expect(parseAuthList("No integrations configured\n")).toEqual([]);
    expect(parseAuthList("")).toEqual([]);
  });
});
