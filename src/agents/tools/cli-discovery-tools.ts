import { execFile } from "node:child_process";
import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const SEARCH_MAX_LIMIT = 50;

const LIST_OUTPUT_MODES = ["brief", "full"] as const;
const HELP_FORMAT_STYLES = ["markdown", "json"] as const;

const CliListCommandsSchema = Type.Object({
  category: Type.Optional(
    Type.String({
      description:
        "Optional category filter (usually the top-level command, e.g. channels, models, nodes, system).",
    }),
  ),
  includeHidden: Type.Optional(
    Type.Boolean({
      description: "Include hidden/internal commands when available.",
      default: false,
    }),
  ),
  outputMode: Type.Optional(
    stringEnum(LIST_OUTPUT_MODES, {
      description:
        "brief returns command + summary. full includes aliases/examples and lightweight parameter hints.",
      default: "brief",
    }),
  ),
});

const CliHelpSchema = Type.Object({
  command: Type.String({
    description: 'Command path to inspect, e.g. "channels status" or "nodes status".',
  }),
  includeExamples: Type.Optional(
    Type.Boolean({
      description: "Include usage examples.",
      default: true,
    }),
  ),
  includeSubcommands: Type.Optional(
    Type.Boolean({
      description: "Include direct child subcommands for command groups.",
      default: true,
    }),
  ),
  formatStyle: Type.Optional(
    stringEnum(HELP_FORMAT_STYLES, {
      description: "Return markdown or json-style response payload.",
      default: "markdown",
    }),
  ),
});

const CliSearchCommandsSchema = Type.Object({
  query: Type.String({
    description:
      'Natural-language or keyword query, e.g. "check channel health", "restart gateway", "list nodes".',
  }),
  category: Type.Optional(
    Type.String({
      description: "Optional category filter.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum number of results (1-50).",
      minimum: 1,
      maximum: SEARCH_MAX_LIMIT,
      default: 10,
    }),
  ),
  includeExamples: Type.Optional(
    Type.Boolean({
      description: "Include runnable examples in search results.",
      default: true,
    }),
  ),
});

type HelpCommandEntry = {
  path: string;
  summary: string;
  category: string;
};

type HelpOptionEntry = {
  flags: string;
  description: string;
};

function resolveEntryArgs(): string[] {
  const argv1 = process.argv[1] ?? "";
  if (argv1.endsWith(".mjs") || argv1.endsWith(".js") || argv1.endsWith(".ts")) {
    return [process.execPath, argv1];
  }
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
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === " " && !inSingle && !inDouble) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) {
    args.push(current);
  }
  return args;
}

function execCommand(
  command: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const [bin, ...baseArgs] = resolveEntryArgs();
  const userArgs = splitArgs(command);
  const fullArgs = [...baseArgs, ...userArgs];
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      fullArgs,
      {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: {
          ...process.env,
          NO_COLOR: "1",
          FORCE_COLOR: "0",
          OPENCLAW_DISABLE_LAZY_SUBCOMMANDS: "1",
        },
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

async function getHelpText(commandPath: string): Promise<string> {
  const trimmed = commandPath.trim();
  const command = trimmed ? `${trimmed} --help` : "--help";
  const { stdout, stderr, exitCode } = await execCommand(command);
  const text = (stdout || stderr).trim();
  if (!text || exitCode !== 0) {
    throw new Error(`Unable to read help for "${trimmed || "openclaw"}" (exit ${exitCode}).`);
  }
  return text;
}

function parseUsage(helpText: string): string {
  const usageMatch = helpText.match(/^\s*Usage:\s*(.+)$/m);
  return usageMatch?.[1]?.trim() ?? "";
}

function parseCommands(helpText: string, prefix?: string): HelpCommandEntry[] {
  const lines = helpText.split("\n");
  const commands: HelpCommandEntry[] = [];
  let inCommands = false;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (/^\s*Commands:\s*$/i.test(trimmed)) {
      inCommands = true;
      continue;
    }
    if (!inCommands) {
      continue;
    }
    if (/^\s*$/.test(trimmed)) {
      if (commands.length > 0) {
        break;
      }
      continue;
    }
    if (/^\s*(Options|Arguments):\s*$/i.test(trimmed)) {
      break;
    }
    const match = /^\s{2,}(.+?)\s{2,}(.+)$/.exec(line);
    if (!match) {
      continue;
    }
    const left = match[1]?.trim() ?? "";
    const summary = match[2]?.trim() ?? "";
    if (!left) {
      continue;
    }
    const commandName = left.split(" ")[0] ?? left;
    if (!commandName || commandName.startsWith("[") || commandName.startsWith("<")) {
      continue;
    }
    const path = [prefix?.trim(), commandName].filter(Boolean).join(" ");
    commands.push({
      path,
      summary,
      category: path.split(" ")[0] ?? path,
    });
  }
  return commands;
}

function parseOptions(helpText: string): HelpOptionEntry[] {
  const lines = helpText.split("\n");
  const options: HelpOptionEntry[] = [];
  let inOptions = false;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (/^\s*Options:\s*$/i.test(trimmed)) {
      inOptions = true;
      continue;
    }
    if (!inOptions) {
      continue;
    }
    if (/^\s*$/.test(trimmed)) {
      if (options.length > 0) {
        break;
      }
      continue;
    }
    if (/^\s*(Commands|Arguments):\s*$/i.test(trimmed)) {
      break;
    }
    const match = /^\s{2,}(.+?)\s{2,}(.+)$/.exec(line);
    if (!match) {
      continue;
    }
    options.push({
      flags: match[1]?.trim() ?? "",
      description: match[2]?.trim() ?? "",
    });
  }
  return options;
}

function buildExample(path: string): string {
  return `openclaw ${path}`.trim();
}

function scoreMatch(query: string, candidate: HelpCommandEntry): number {
  const q = query.toLowerCase().trim();
  const path = candidate.path.toLowerCase();
  const summary = candidate.summary.toLowerCase();
  if (!q) {
    return 0;
  }
  if (path === q) {
    return 1;
  }
  if (path.startsWith(q)) {
    return 0.95;
  }
  let score = 0;
  const tokens = q.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (path.includes(token)) {
      score += 0.35;
    } else if (summary.includes(token)) {
      score += 0.2;
    }
  }
  if (path.includes(q)) {
    score += 0.25;
  }
  return Math.min(score, 0.99);
}

function normalizeLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) {
    return 10;
  }
  return Math.min(SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(raw)));
}

async function getCommandCatalog(): Promise<HelpCommandEntry[]> {
  const rootHelp = await getHelpText("");
  const topLevel = parseCommands(rootHelp);
  const catalog = new Map<string, HelpCommandEntry>();

  for (const entry of topLevel) {
    catalog.set(entry.path, entry);
  }

  for (const entry of topLevel) {
    try {
      const subHelp = await getHelpText(entry.path);
      const subs = parseCommands(subHelp, entry.path);
      for (const sub of subs) {
        catalog.set(sub.path, sub);
      }
    } catch {
      // Best-effort discovery: not every command emits parseable help in all envs.
    }
  }

  return [...catalog.values()].toSorted((a, b) => a.path.localeCompare(b.path));
}

export function createCliListCommandsTool(): AnyAgentTool {
  return {
    label: "CLI List Commands",
    name: "cli_list_commands",
    description:
      "List discoverable openclaw CLI commands and summaries for environments with limited code context.",
    parameters: CliListCommandsSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const category = readStringParam(params, "category");
      const includeHidden = params.includeHidden === true;
      const outputMode = readStringParam(params, "outputMode") === "full" ? "full" : "brief";
      const catalog = await getCommandCatalog();
      const filtered = category
        ? catalog.filter((entry) => entry.category.toLowerCase() === category.toLowerCase())
        : catalog;

      const commands = filtered.map((entry) => ({
        path: entry.path,
        summary: entry.summary,
        category: entry.category,
        aliases: [],
        hidden: false,
        args: outputMode === "full" ? [] : undefined,
        examples: outputMode === "full" ? [buildExample(entry.path)] : undefined,
      }));

      return jsonResult({
        ok: true,
        generatedAt: new Date().toISOString(),
        filters: {
          category: category ?? null,
          includeHidden,
          outputMode,
        },
        total: commands.length,
        commands,
      });
    },
  };
}

export function createCliHelpTool(): AnyAgentTool {
  return {
    label: "CLI Help",
    name: "cli_help",
    description:
      "Return detailed help for a single openclaw CLI command, including usage, options, and examples.",
    parameters: CliHelpSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const command = readStringParam(params, "command", { required: true });
      const includeExamples = params.includeExamples !== false;
      const includeSubcommands = params.includeSubcommands !== false;
      const formatStyle = readStringParam(params, "formatStyle") === "json" ? "json" : "markdown";
      const helpText = await getHelpText(command);
      const usage = parseUsage(helpText);
      const options = parseOptions(helpText);
      const subcommands = includeSubcommands ? parseCommands(helpText, command) : [];
      const examples = includeExamples ? [`openclaw ${command}`, `openclaw ${command} --help`] : [];
      const payload = {
        ok: true,
        generatedAt: new Date().toISOString(),
        command,
        resolvedCommand: command,
        summary: `Help for "${command}"`,
        usage,
        description: "",
        aliases: [],
        args: [],
        options,
        subcommands: subcommands.map((entry) => ({ path: entry.path, summary: entry.summary })),
        examples,
        formatStyle,
        rendered:
          formatStyle === "markdown"
            ? [
                `### ${command}`,
                usage ? `- Usage: \`${usage}\`` : "",
                options.length > 0
                  ? `- Options:\n${options.map((opt) => `  - \`${opt.flags}\`: ${opt.description}`).join("\n")}`
                  : "",
                includeSubcommands && subcommands.length > 0
                  ? `- Subcommands:\n${subcommands.map((sub) => `  - \`${sub.path}\`: ${sub.summary}`).join("\n")}`
                  : "",
                includeExamples && examples.length > 0
                  ? `- Examples:\n${examples.map((example) => `  - \`${example}\``).join("\n")}`
                  : "",
              ]
                .filter(Boolean)
                .join("\n")
            : undefined,
      };
      return jsonResult(payload);
    },
  };
}

export function createCliSearchCommandsTool(): AnyAgentTool {
  return {
    label: "CLI Search Commands",
    name: "cli_search_commands",
    description:
      "Search openclaw CLI commands by intent or keywords and return ranked matches with reasons.",
    parameters: CliSearchCommandsSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const category = readStringParam(params, "category");
      const limit = normalizeLimit(readNumberParam(params, "limit"));
      const includeExamples = params.includeExamples !== false;
      const catalog = await getCommandCatalog();
      const filtered = category
        ? catalog.filter((entry) => entry.category.toLowerCase() === category.toLowerCase())
        : catalog;
      const scored = filtered
        .map((entry) => ({ entry, score: scoreMatch(query, entry) }))
        .filter((entry) => entry.score > 0)
        .toSorted((a, b) => b.score - a.score)
        .slice(0, limit);

      const results = scored.map(({ entry, score }) => ({
        path: entry.path,
        summary: entry.summary,
        category: entry.category,
        score: Number(score.toFixed(3)),
        reason: entry.path.toLowerCase().includes(query.toLowerCase())
          ? "Path matches query"
          : "Summary/tokens match query",
        aliases: [],
        examples: includeExamples ? [buildExample(entry.path)] : undefined,
      }));

      return jsonResult({
        ok: true,
        generatedAt: new Date().toISOString(),
        query,
        category: category ?? null,
        limit,
        totalMatches: scored.length,
        results,
        suggestedNextTool: results.length === 1 ? "cli_help" : "cli_list_commands",
      });
    },
  };
}
