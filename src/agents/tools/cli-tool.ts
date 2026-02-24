import { execFile } from "node:child_process";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

const MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

const BLOCKED_COMMANDS = new Set(["gateway", "daemon", "node", "sandbox", "tui", "acp", "mcp"]);

const CliToolSchema = Type.Object({
  command: Type.String({
    description:
      "The openclaw subcommand and its arguments as a single string. " +
      'Example: "logs --limit 50", "channels list --json", "models status --json".',
  }),
  timeoutMs: Type.Optional(
    Type.Number({
      description: `Timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS}).`,
    }),
  ),
});

function resolveEntryArgs(): string[] {
  const argv1 = process.argv[1] ?? "";
  if (argv1.endsWith(".mjs") || argv1.endsWith(".js") || argv1.endsWith(".ts")) {
    return [process.execPath, argv1];
  }
  // Fallback: assume argv[1] is the binary itself (e.g. global install)
  return [argv1 || "openclaw"];
}

function splitArgs(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === " " && !inSingle && !inDouble) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) {
    args.push(current);
  }
  return args;
}

function execCommand(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      },
      (err, stdout, stderr) => {
        const exitCode =
          err && "code" in err && typeof err.code === "number" ? err.code : (child.exitCode ?? 0);
        resolve({
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
          exitCode,
        });
      },
    );
  });
}

export function createCliTool(): AnyAgentTool {
  return {
    label: "CLI",
    name: "cli",
    description:
      "Run an openclaw CLI command and return its output. " +
      "Useful for logs, channels, models, cron, system, nodes, plugins, skills, and other read/management commands. " +
      "Append --json where supported for structured output.",
    parameters: CliToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as { command?: string; timeoutMs?: number };
      const raw = (typeof params.command === "string" ? params.command : "").trim();
      if (!raw) {
        throw new Error("command is required");
      }

      const userArgs = splitArgs(raw);
      const subcommand = userArgs[0]?.toLowerCase() ?? "";

      if (BLOCKED_COMMANDS.has(subcommand)) {
        throw new Error(
          `The "${subcommand}" subcommand is not available through the cli tool. ` +
            "Use the dedicated tool or control plane instead.",
        );
      }

      const timeoutMs =
        typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
          ? Math.max(1000, params.timeoutMs)
          : DEFAULT_TIMEOUT_MS;

      const [bin, ...baseArgs] = resolveEntryArgs();
      const fullArgs = [...baseArgs, ...userArgs];

      const { stdout, stderr, exitCode } = await execCommand(bin, fullArgs, timeoutMs);

      const output = [stdout, stderr].filter(Boolean).join("\n").trim();
      if (!output) {
        return jsonResult({ ok: exitCode === 0, exitCode, output: "(no output)" });
      }

      // Try to parse as JSON for structured results
      try {
        const parsed = JSON.parse(output);
        return jsonResult({ ok: exitCode === 0, exitCode, result: parsed });
      } catch {
        // plain text output
      }

      return {
        content: [
          {
            type: "text" as const,
            text: exitCode === 0 ? output : `Exit code ${exitCode}\n${output}`,
          },
        ],
        details: { exitCode },
      };
    },
  };
}
