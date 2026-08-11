import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import { McpClientManager } from "../../src/mcp/client-manager.js";

describe("McpClientManager", () => {
  it("discovers and calls an MCP tool over an observed in-memory connection", async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: "fixture", version: "1.0.0" });
    server.registerTool(
      "echo",
      {
        description: "Echo text",
        inputSchema: z.object({ text: z.string() }),
        annotations: { readOnlyHint: true },
      },
      async ({ text }) => ({
        content: [{ type: "text", text }],
        structuredContent: { text },
      }),
    );
    await server.connect(serverTransport);

    const tools = new ToolRegistry();
    const manager = new McpClientManager(tools);
    await expect(
      manager.connectTransport("fixture", clientTransport),
    ).resolves.toEqual(["mcp.fixture.echo"]);
    expect(tools.list()[0]).toMatchObject({
      name: "mcp.fixture.echo",
      effect: "read",
    });
    await expect(
      tools.call(
        "mcp.fixture.echo",
        { text: "observed" },
        { runId: "run-1", signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({ structuredContent: { text: "observed" } });
    await manager.close();
    await server.close();
  });
});
