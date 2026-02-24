import { describe, expect, it } from "vitest";
import { createCliTool } from "./cli-tool.js";

describe("createCliTool", () => {
  const tool = createCliTool();

  it("has correct metadata", () => {
    expect(tool.name).toBe("cli");
    expect(tool.description).toContain("openclaw CLI command");
    expect(tool.parameters).toBeDefined();
  });

  it("rejects empty command", async () => {
    await expect(tool.execute("test-call", { command: "" })).rejects.toThrow("command is required");
    await expect(tool.execute("test-call", {})).rejects.toThrow("command is required");
  });

  it("blocks dangerous subcommands", async () => {
    for (const cmd of [
      "gateway run",
      "daemon start",
      "node run",
      "sandbox start",
      "tui",
      "acp serve",
      "mcp serve",
    ]) {
      await expect(tool.execute("test-call", { command: cmd })).rejects.toThrow(
        /not available through the cli tool/,
      );
    }
  });

  it("runs --help and returns output", async () => {
    const result = await tool.execute("test-call", { command: "--help" });
    expect(result.content).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
    const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
    expect(text).toContain("openclaw");
  });

  it("runs --version and returns output", async () => {
    const result = await tool.execute("test-call", { command: "--version" });
    expect(result.content.length).toBeGreaterThan(0);
    const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
    // Version output should contain a version-like string
    expect(text).toMatch(/\d/);
  });
});
