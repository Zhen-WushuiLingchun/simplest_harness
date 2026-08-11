import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/core/config.js";
import { EventStore } from "../../src/core/event-store.js";
import type { ModelDescriptor } from "../../src/core/types.js";
import { createTmshMcpServer } from "../../src/mcp/server.js";
import {
  FakeModelAdapter,
  type ModelTurnOutput,
} from "../../src/models/adapter.js";
import { ModelRegistry } from "../../src/models/registry.js";
import { RunEngine } from "../../src/runtime/run-engine.js";

describe("TMSH MCP server", () => {
  it("exposes run control over an observed in-memory MCP session", async () => {
    const root = await mkdtemp(join(tmpdir(), "tmsh-mcp-server-"));
    const descriptor: ModelDescriptor = {
      id: "fake",
      provider: "fake",
      model: "fixed",
      supportsTools: true,
      supportsImages: false,
      capabilities: [],
    };
    const turn: ModelTurnOutput = {
      text: "MCP done",
      responseMessages: [{ role: "assistant", content: "MCP done" }],
      toolCalls: [],
      usage: {
        inputTokens: 2,
        outputTokens: 2,
        totalTokens: 4,
        estimated: false,
      },
      finishReason: "stop",
    };
    const config = resolveConfig({
      dataDir: join(root, ".tmsh"),
      models: [descriptor],
      defaultModel: descriptor.id,
      autonomy: { mode: "yolo" },
    });
    const events = new EventStore(config.dataDir);
    const models = new ModelRegistry(
      [descriptor],
      [new FakeModelAdapter(descriptor, [turn])],
    );
    const engine = new RunEngine(config, events, models, process.cwd());
    const server = createTmshMcpServer(engine, models);
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listing = await client.listTools();
    expect(listing.tools.map((tool) => tool.name)).toContain("tmsh_start_run");
    const started = await client.callTool({
      name: "tmsh_start_run",
      arguments: { goal: "MCP goal", workspace: root, autonomy: "yolo" },
    });
    const runId = (started.structuredContent as { runId: string }).runId;
    await engine.wait(runId);
    const inspected = await client.callTool({
      name: "tmsh_get_run",
      arguments: { runId },
    });
    expect(inspected.structuredContent).toMatchObject({
      run: { status: "done", finalText: "MCP done" },
    });

    await client.close();
    await server.close();
  });
});
