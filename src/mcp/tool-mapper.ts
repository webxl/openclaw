import type { AnyAgentTool } from "../agents/tools/common.js";

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type McpTextContent = { type: "text"; text: string };
type McpImageContent = { type: "image"; data: string; mimeType: string };
export type McpContentItem = McpTextContent | McpImageContent;

export type McpToolResult = {
  content: McpContentItem[];
  isError?: boolean;
};

/**
 * Convert an OpenClaw agent tool to an MCP tool definition.
 * TypeBox schemas are already valid JSON Schema, so they can be passed
 * directly as the MCP `inputSchema`.
 */
export function mapToolToMcpDefinition(tool: AnyAgentTool): McpToolDefinition {
  return {
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: (tool.parameters as Record<string, unknown>) ?? {
      type: "object",
      properties: {},
    },
  };
}

export function mapToolsToMcpDefinitions(tools: AnyAgentTool[]): McpToolDefinition[] {
  return tools.map(mapToolToMcpDefinition);
}

/**
 * Execute an OpenClaw tool and convert the result to MCP content format.
 * Agent tool results already use { type: "text"|"image", ... } content blocks,
 * which map 1:1 to MCP content items.
 */
export async function executeToolForMcp(
  tool: AnyAgentTool,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  try {
    const result = await tool.execute(`mcp-${Date.now()}`, args);
    const content: McpContentItem[] = [];

    if (result?.content && Array.isArray(result.content)) {
      for (const item of result.content) {
        if (item.type === "text") {
          content.push({ type: "text", text: String(item.text ?? "") });
        } else if (item.type === "image") {
          content.push({
            type: "image",
            data: String(item.data ?? ""),
            mimeType: String(item.mimeType ?? "image/png"),
          });
        }
      }
    }

    if (content.length === 0) {
      content.push({ type: "text", text: JSON.stringify(result ?? {}, null, 2) });
    }

    return { content };
  } catch (err) {
    return {
      content: [
        { type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
      ],
      isError: true,
    };
  }
}
