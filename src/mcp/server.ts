import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import type { AutonomyMode } from "../core/config.js";
import type { ModelRegistry } from "../models/registry.js";
import type { RunEngine } from "../runtime/run-engine.js";

export function createTmshMcpServer(
  engine: RunEngine,
  models: ModelRegistry,
): McpServer {
  const server = new McpServer({ name: "tmsh", version: "0.1.0" });
  server.registerTool(
    "tmsh_list_models",
    {
      description: "List registered TMSH models and availability",
      inputSchema: z.object({}),
    },
    async () => result({ models: models.list() }),
  );
  server.registerTool(
    "tmsh_list_tools",
    { description: "List model-visible TMSH tools", inputSchema: z.object({}) },
    async () => result({ tools: engine.tools.list() }),
  );
  server.registerTool(
    "tmsh_start_run",
    {
      description:
        "Start a TMSH run. Set autonomy=yolo explicitly to bypass per-call approval.",
      inputSchema: z.object({
        goal: z.string().min(1),
        workspace: z.string().min(1),
        modelId: z.string().optional(),
        autonomy: z.enum(["confirm", "yolo"]).optional(),
        maxCalls: z.number().int().positive().optional(),
      }),
    },
    async ({ goal, workspace, modelId, autonomy, maxCalls }) => {
      const runId = await engine.start({
        goal,
        workspace,
        ...(modelId === undefined ? {} : { modelId }),
        ...(autonomy === undefined
          ? {}
          : { autonomy: autonomy as AutonomyMode }),
        ...(maxCalls === undefined ? {} : { maxCalls }),
      });
      return result({ runId, run: engine.snapshot(runId) });
    },
  );
  server.registerTool(
    "tmsh_get_run",
    {
      description: "Get current TMSH run state",
      inputSchema: z.object({ runId: z.string().uuid() }),
    },
    async ({ runId }) => result({ run: engine.snapshot(runId) }),
  );
  server.registerTool(
    "tmsh_approve",
    {
      description: "Resolve a pending TMSH tool approval",
      inputSchema: z.object({
        runId: z.string().uuid(),
        toolCallId: z.string().min(1),
        allowed: z.boolean(),
      }),
    },
    async ({ runId, toolCallId, allowed }) => {
      engine.approve(runId, toolCallId, allowed);
      return result({ resolved: true, allowed });
    },
  );
  server.registerTool(
    "tmsh_cancel",
    {
      description: "Cancel a TMSH run",
      inputSchema: z.object({ runId: z.string().uuid() }),
    },
    async ({ runId }) => {
      engine.cancel(runId);
      return result({ cancelled: true });
    },
  );
  server.registerTool(
    "tmsh_compact",
    {
      description:
        "Request validated context compaction at the next model boundary",
      inputSchema: z.object({ runId: z.string().uuid() }),
    },
    async ({ runId }) => {
      engine.requestCompaction(runId);
      return result({ requested: true });
    },
  );
  return server;
}

export async function serveTmshMcpStdio(
  engine: RunEngine,
  models: ModelRegistry,
): Promise<void> {
  const server = createTmshMcpServer(engine, models);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    server.server.onclose = resolve;
    const close = (): void => {
      void server.close().finally(resolve);
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}

function result(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}
