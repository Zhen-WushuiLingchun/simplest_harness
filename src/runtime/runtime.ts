import type { TmshConfig } from "../core/config.js";
import { EventStore } from "../core/event-store.js";
import { SessionStore } from "../core/session-store.js";
import { McpClientManager } from "../mcp/client-manager.js";
import { ModelRegistry } from "../models/registry.js";
import { RunEngine } from "./run-engine.js";

export interface TmshRuntime {
  readonly config: TmshConfig;
  readonly events: EventStore;
  readonly models: ModelRegistry;
  readonly sessions: SessionStore;
  readonly engine: RunEngine;
  readonly mcp: McpClientManager;
  close(): Promise<void>;
}

export async function createRuntime(
  config: TmshConfig,
  distributionRoot: string,
): Promise<TmshRuntime> {
  const events = new EventStore(config.dataDir);
  const sessions = new SessionStore(config.dataDir);
  const models = new ModelRegistry(config.models);
  const engine = new RunEngine(
    config,
    events,
    models,
    distributionRoot,
    sessions,
  );
  const mcp = new McpClientManager(engine.tools);
  for (const server of config.mcpServers) await mcp.connect(server);
  return {
    config,
    events,
    models,
    sessions,
    engine,
    mcp,
    close: () => mcp.close(),
  };
}
