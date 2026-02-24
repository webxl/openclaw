import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import {
  executeToolForMcp,
  mapToolToMcpDefinition,
  mapToolsToMcpDefinitions,
} from "./tool-mapper.js";

function makeFakeTool(overrides: Partial<AnyAgentTool> & { name: string }): AnyAgentTool {
  return {
    label: overrides.label ?? overrides.name,
    description: overrides.description ?? `${overrides.name} tool`,
    parameters: overrides.parameters ?? Type.Object({}),
    execute:
      overrides.execute ??
      (async () => ({ content: [{ type: "text" as const, text: "ok" }], details: undefined })),
    ...overrides,
  } as AnyAgentTool;
}

describe("mapToolToMcpDefinition", () => {
  it("maps name, description, and parameters", () => {
    const schema = Type.Object({
      query: Type.String({ description: "Search query" }),
      count: Type.Optional(Type.Number()),
    });
    const tool = makeFakeTool({
      name: "web_search",
      description: "Search the web",
      parameters: schema,
    });

    const def = mapToolToMcpDefinition(tool);
    expect(def.name).toBe("web_search");
    expect(def.description).toBe("Search the web");
    expect(def.inputSchema).toHaveProperty("type", "object");
    expect(def.inputSchema).toHaveProperty("properties");
    const props = def.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("query");
    expect(props).toHaveProperty("count");
  });

  it("falls back to empty object schema when parameters missing", () => {
    const tool = makeFakeTool({ name: "bare", parameters: undefined });
    const def = mapToolToMcpDefinition(tool);
    expect(def.inputSchema).toEqual({ type: "object", properties: {} });
  });

  it("uses empty string when description is undefined", () => {
    const tool = makeFakeTool({ name: "no_desc", description: undefined });
    const def = mapToolToMcpDefinition(tool);
    expect(def.description).toBe("");
  });
});

describe("mapToolsToMcpDefinitions", () => {
  it("maps all tools in array", () => {
    const tools = [
      makeFakeTool({ name: "a" }),
      makeFakeTool({ name: "b" }),
      makeFakeTool({ name: "c" }),
    ];
    const defs = mapToolsToMcpDefinitions(tools);
    expect(defs).toHaveLength(3);
    expect(defs.map((d) => d.name)).toEqual(["a", "b", "c"]);
  });
});

describe("executeToolForMcp", () => {
  it("converts text content from tool result", async () => {
    const tool = makeFakeTool({
      name: "echo",
      execute: async () => ({
        content: [{ type: "text" as const, text: "hello world" }],
        details: undefined,
      }),
    });

    const result = await executeToolForMcp(tool, {});
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: "hello world" }]);
  });

  it("converts image content from tool result", async () => {
    const tool = makeFakeTool({
      name: "screenshot",
      execute: async () => ({
        content: [
          { type: "text" as const, text: "screenshot taken" },
          { type: "image" as const, data: "base64data", mimeType: "image/png" },
        ],
        details: undefined,
      }),
    });

    const result = await executeToolForMcp(tool, {});
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({ type: "text", text: "screenshot taken" });
    expect(result.content[1]).toEqual({ type: "image", data: "base64data", mimeType: "image/png" });
  });

  it("serializes result as JSON when content array is empty", async () => {
    const tool = makeFakeTool({
      name: "raw",
      execute: async () => ({ content: [], details: { count: 42 } }),
    });

    const result = await executeToolForMcp(tool, {});
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.details.count).toBe(42);
  });

  it("returns isError on tool execution failure", async () => {
    const tool = makeFakeTool({
      name: "broken",
      execute: async () => {
        throw new Error("something went wrong");
      },
    });

    const result = await executeToolForMcp(tool, {});
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect((result.content[0] as { text: string }).text).toContain("something went wrong");
  });

  it("passes arguments through to the tool execute function", async () => {
    let receivedArgs: Record<string, unknown> = {};
    const tool = makeFakeTool({
      name: "args_test",
      execute: async (_id, args) => {
        receivedArgs = args as Record<string, unknown>;
        return { content: [{ type: "text" as const, text: "ok" }], details: undefined };
      },
    });

    await executeToolForMcp(tool, { query: "hello", count: 5 });
    expect(receivedArgs).toEqual({ query: "hello", count: 5 });
  });
});
