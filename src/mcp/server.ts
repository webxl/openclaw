import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createOpenClawTools } from "../agents/openclaw-tools.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { loadConfig } from "../config/config.js";
import { VERSION } from "../version.js";
import { executeToolForMcp, mapToolsToMcpDefinitions } from "./tool-mapper.js";

export type McpServerOptions = {
  /** Session key for tool execution context (e.g. "agent:main:main"). */
  sessionKey?: string;
};

export type McpHttpOptions = McpServerOptions & {
  /** Port to listen on (default: 9878). */
  port?: number;
  /** Bind address (default: "0.0.0.0"). */
  host?: string;
  /** Bearer token required for incoming HTTP requests. Falls back to OPENCLAW_GATEWAY_TOKEN env var. */
  token?: string;
};

function createMcpServer(tools: AnyAgentTool[]): Server {
  const server = new Server(
    { name: "openclaw", version: VERSION },
    { capabilities: { tools: {} } },
  );

  const mcpTools = mapToolsToMcpDefinitions(tools);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: mcpTools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    return executeToolForMcp(tool, args ?? {});
  });

  return server;
}

function loadTools(opts: McpServerOptions): AnyAgentTool[] {
  const cfg = loadConfig();
  return createOpenClawTools({
    agentSessionKey: opts.sessionKey,
    config: cfg,
  });
}

/**
 * Start an MCP server over stdio.
 * Suitable for local subprocess spawning (e.g. Cursor stdio mode).
 */
export async function serveMcpStdio(opts: McpServerOptions = {}): Promise<void> {
  const tools = loadTools(opts);
  const server = createMcpServer(tools);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  await new Promise<void>((resolve) => {
    // SDK exposes callback properties instead of EventTarget listeners.
    // eslint-disable-next-line unicorn/prefer-add-event-listener
    transport.onclose = () => resolve();
    process.once("SIGINT", () => void server.close());
    process.once("SIGTERM", () => void server.close());
  });
}

function extractBearerToken(req: {
  headers: Record<string, string | string[] | undefined>;
}): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string") {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim();
}

/**
 * Start an MCP server over Streamable HTTP.
 * Exposes OpenClaw tools at /mcp so remote clients (Cursor URL mode) can connect.
 * Tools internally reach the gateway over WebSocket (default ws://127.0.0.1:18789).
 *
 * When a token is configured (via opts, OPENCLAW_MCP_TOKEN, or OPENCLAW_GATEWAY_TOKEN),
 * clients must send `Authorization: Bearer <token>` on every request.
 */
export async function serveMcpHttp(opts: McpHttpOptions = {}): Promise<void> {
  const port = opts.port ?? 9878;
  const host = opts.host ?? "0.0.0.0";
  const requiredToken =
    opts.token?.trim() ||
    process.env.OPENCLAW_MCP_TOKEN?.trim() ||
    process.env.OPENCLAW_GATEWAY_TOKEN?.trim() ||
    undefined;

  const tools = loadTools(opts);

  // Track active transports per session so multiple clients can connect.
  const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: VERSION }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    // Validate bearer token when one is configured.
    if (requiredToken) {
      const provided = extractBearerToken(req);
      if (provided !== requiredToken) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    // Route to existing session if the client sends a session ID header.
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      if (session) {
        await session.transport.handleRequest(req, res);
        return;
      }
    }

    // For initialization requests (no session or unknown session), create a new transport + server.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport });
      },
    });

    // SDK exposes callback properties instead of EventTarget listeners.
    // eslint-disable-next-line unicorn/prefer-add-event-listener
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) {
        sessions.delete(id);
      }
    };

    const server = createMcpServer(tools);
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });

  const shutdown = () => {
    for (const session of sessions.values()) {
      void session.server.close();
    }
    sessions.clear();
    httpServer.close();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await new Promise<void>((resolve, reject) => {
    httpServer.on("error", reject);
    httpServer.listen(port, host, () => {
      const addr = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;
      process.stderr.write(`OpenClaw MCP server listening on ${addr}/mcp\n`);
      resolve();
    });
  });

  // Block until the server closes.
  await new Promise<void>((resolve) => {
    httpServer.on("close", resolve);
  });
}
