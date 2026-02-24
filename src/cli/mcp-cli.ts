import type { Command } from "commander";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";

export function registerMcpCli(program: Command) {
  const mcp = program
    .command("mcp")
    .description("Model Context Protocol (MCP) server for IDE integration");

  mcp
    .command("serve")
    .description("Start an MCP server exposing OpenClaw tools")
    .option("--session <key>", "Session key for tool context (e.g. agent:main:main)")
    .option("--port <port>", "Serve over HTTP on this port (default: 3100 when used)")
    .option("--host <host>", "Bind address for HTTP mode (default: 0.0.0.0)")
    .option(
      "--token <token>",
      "Bearer token for HTTP auth (default: OPENCLAW_MCP_TOKEN or OPENCLAW_GATEWAY_TOKEN env)",
    )
    .addHelpText(
      "after",
      () => `
${theme.muted("Stdio mode (Cursor spawns the process):")}
  openclaw mcp serve

${theme.muted("HTTP mode (connect Cursor to a running instance):")}
  openclaw mcp serve --port 3100

${theme.muted("Cursor config for HTTP mode (~/.cursor/mcp.json):")}
  {
    "mcpServers": {
      "openclaw": {
        "url": "http://localhost:3100/mcp",
        "headers": {
          "Authorization": "Bearer <your-token>"
        }
      }
    }
  }
`,
    )
    .action(async (opts) => {
      try {
        if (opts.port !== undefined || opts.host !== undefined) {
          const { serveMcpHttp } = await import("../mcp/server.js");
          const port = opts.port ? Number(opts.port) : undefined;
          if (opts.port !== undefined && (Number.isNaN(port) || port! < 1 || port! > 65535)) {
            defaultRuntime.error(`Invalid port: ${String(opts.port)}`);
            defaultRuntime.exit(1);
            return;
          }
          await serveMcpHttp({
            sessionKey: opts.session as string | undefined,
            port,
            host: opts.host as string | undefined,
            token: opts.token as string | undefined,
          });
        } else {
          const { serveMcpStdio } = await import("../mcp/server.js");
          await serveMcpStdio({
            sessionKey: opts.session as string | undefined,
          });
        }
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });
}
