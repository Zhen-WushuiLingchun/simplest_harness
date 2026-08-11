import {
  Client,
  StreamableHTTPClientTransport,
  type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpServerConfig } from "../core/config.js";
import type { JsonValue } from "../core/types.js";
import type { ToolRegistry } from "../core/tool-registry.js";

interface ConnectedServer {
  readonly id: string;
  readonly client: Client;
  readonly transport: Transport;
  readonly toolNames: readonly string[];
}

export class McpClientManager {
  readonly #tools: ToolRegistry;
  readonly #servers = new Map<string, ConnectedServer>();

  public constructor(tools: ToolRegistry) {
    this.#tools = tools;
  }

  public async connect(config: McpServerConfig): Promise<readonly string[]> {
    if (config.transport === "stdio") {
      const transport = new StdioClientTransport({
        command: config.command,
        ...(config.args === undefined ? {} : { args: [...config.args] }),
        ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
        ...(config.envFrom === undefined
          ? {}
          : { env: resolveNamedEnvironment(config.envFrom) }),
        stderr: "pipe",
      });
      return this.connectTransport(config.id, transport);
    }
    const headers = resolveHeaderEnvironment(config.headerEnv);
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      ...(Object.keys(headers).length === 0
        ? {}
        : { requestInit: { headers } }),
    });
    return this.connectTransport(config.id, transport);
  }

  public async connectTransport(
    id: string,
    transport: Transport,
  ): Promise<readonly string[]> {
    if (this.#servers.has(id))
      throw new Error(`MCP server is already connected: ${id}`);
    const client = new Client({ name: "tmsh", version: "0.1.0" });
    await client.connect(transport);
    const listing = await client.listTools();
    const registered: string[] = [];
    for (const tool of listing.tools) {
      const exposedName = `mcp.${id}.${tool.name}`;
      this.#tools.register({
        name: exposedName,
        description: tool.description ?? `MCP tool ${tool.name} from ${id}`,
        inputSchema: toJsonValue(tool.inputSchema) as Record<string, JsonValue>,
        effect: tool.annotations?.readOnlyHint === true ? "read" : "external",
        execute: async (input) =>
          toJsonValue(
            await client.callTool({
              name: tool.name,
              arguments:
                input !== null &&
                typeof input === "object" &&
                !Array.isArray(input)
                  ? input
                  : {},
            }),
          ),
      });
      registered.push(exposedName);
    }
    this.#servers.set(id, { id, client, transport, toolNames: registered });
    return registered;
  }

  public list(): readonly { id: string; toolNames: readonly string[] }[] {
    return [...this.#servers.values()]
      .map(({ id, toolNames }) => ({ id, toolNames }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  public async close(): Promise<void> {
    await Promise.all(
      [...this.#servers.values()].map(({ client }) => client.close()),
    );
    this.#servers.clear();
  }
}

function resolveHeaderEnvironment(
  headerEnv: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [header, envName] of Object.entries(headerEnv ?? {})) {
    const value = process.env[envName];
    if (value === undefined)
      throw new Error(`MCP header environment variable is missing: ${envName}`);
    headers[header] = value;
  }
  return headers;
}

function resolveNamedEnvironment(
  envFrom: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(envFrom).map(([childName, envName]) => {
      const value = process.env[envName];
      if (value === undefined)
        throw new Error(
          `MCP process environment variable is missing: ${envName}`,
        );
      return [childName, value];
    }),
  );
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
