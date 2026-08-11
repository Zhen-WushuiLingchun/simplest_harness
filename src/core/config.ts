import type { ModelDescriptor } from "./types.js";

export type CompactionMode = "auto" | "manual" | "off";
export type AutonomyMode = "confirm" | "yolo";

export interface CompactionConfig {
  readonly mode: CompactionMode;
  readonly modelId?: string;
  readonly triggerRatio: number;
  readonly hardRatio: number;
  readonly triggerTokens?: number;
  readonly reservedOutputTokens?: number;
  readonly recentTurns: number;
  readonly allowModelEarly: boolean;
}

export type McpServerConfig =
  | {
      readonly id: string;
      readonly transport: "stdio";
      readonly command: string;
      readonly args?: readonly string[];
      readonly cwd?: string;
      readonly envFrom?: Readonly<Record<string, string>>;
    }
  | {
      readonly id: string;
      readonly transport: "http";
      readonly url: string;
      readonly headerEnv?: Readonly<Record<string, string>>;
    };

export interface TmshConfig {
  readonly dataDir: string;
  readonly host: string;
  readonly port: number;
  readonly defaultModel?: string;
  readonly models: readonly ModelDescriptor[];
  readonly mcpServers: readonly McpServerConfig[];
  readonly autonomy: {
    readonly mode: AutonomyMode;
  };
  readonly compaction: CompactionConfig;
  readonly process: {
    readonly defaultTimeoutMs: number;
    readonly defaultYieldMs: number;
    readonly maxOutputBytes: number;
  };
  readonly run: {
    readonly maxModelCalls: number;
    readonly maxDelegationDepth: number;
    readonly maxConcurrentDelegations: number;
  };
}

export type DeepPartial<T> = {
  readonly [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export const DEFAULT_CONFIG: TmshConfig = {
  dataDir: ".tmsh",
  host: "127.0.0.1",
  port: 4097,
  models: [],
  mcpServers: [],
  autonomy: {
    mode: "confirm",
  },
  compaction: {
    mode: "auto",
    triggerRatio: 0.75,
    hardRatio: 0.9,
    recentTurns: 4,
    allowModelEarly: true,
  },
  process: {
    defaultTimeoutMs: 120_000,
    defaultYieldMs: 10_000,
    maxOutputBytes: 1_000_000,
  },
  run: {
    maxModelCalls: 100,
    maxDelegationDepth: 4,
    maxConcurrentDelegations: 3,
  },
};

function finitePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
}

export function resolveConfig(input: DeepPartial<TmshConfig> = {}): TmshConfig {
  const config: TmshConfig = {
    ...DEFAULT_CONFIG,
    ...input,
    models: input.models ?? DEFAULT_CONFIG.models,
    mcpServers: input.mcpServers ?? DEFAULT_CONFIG.mcpServers,
    autonomy: { ...DEFAULT_CONFIG.autonomy, ...input.autonomy },
    compaction: { ...DEFAULT_CONFIG.compaction, ...input.compaction },
    process: { ...DEFAULT_CONFIG.process, ...input.process },
    run: { ...DEFAULT_CONFIG.run, ...input.run },
  };

  if (
    config.host !== "127.0.0.1" &&
    config.host !== "::1" &&
    config.host !== "localhost"
  ) {
    throw new Error(
      "non-loopback host requires an explicit future remote-access mode",
    );
  }
  if (
    !Number.isInteger(config.port) ||
    config.port < 0 ||
    config.port > 65_535
  ) {
    throw new Error("port must be an integer from 0 through 65535");
  }
  if (config.autonomy.mode !== "confirm" && config.autonomy.mode !== "yolo") {
    throw new Error("autonomy.mode must be confirm or yolo");
  }
  if (!(
    config.compaction.triggerRatio > 0 && config.compaction.triggerRatio < 1
  )) {
    throw new Error("compaction.triggerRatio must be between 0 and 1");
  }
  if (!(
    config.compaction.hardRatio > config.compaction.triggerRatio &&
    config.compaction.hardRatio < 1
  )) {
    throw new Error(
      "compaction.hardRatio must be greater than triggerRatio and less than 1",
    );
  }
  if (config.compaction.triggerTokens !== undefined) {
    finitePositive(config.compaction.triggerTokens, "compaction.triggerTokens");
  }
  if (
    !Number.isInteger(config.compaction.recentTurns) ||
    config.compaction.recentTurns < 0
  ) {
    throw new Error("compaction.recentTurns must be a non-negative integer");
  }
  finitePositive(config.process.defaultTimeoutMs, "process.defaultTimeoutMs");
  finitePositive(config.process.defaultYieldMs, "process.defaultYieldMs");
  finitePositive(config.process.maxOutputBytes, "process.maxOutputBytes");

  const ids = new Set<string>();
  for (const model of config.models) {
    if (ids.has(model.id)) throw new Error(`duplicate model id: ${model.id}`);
    ids.add(model.id);
  }
  if (config.defaultModel !== undefined && !ids.has(config.defaultModel)) {
    throw new Error(`default model is not registered: ${config.defaultModel}`);
  }
  if (
    config.compaction.modelId !== undefined &&
    !ids.has(config.compaction.modelId)
  ) {
    throw new Error(
      `compaction model is not registered: ${config.compaction.modelId}`,
    );
  }
  const mcpIds = new Set<string>();
  for (const server of config.mcpServers) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(server.id))
      throw new Error(`invalid MCP server id: ${server.id}`);
    if (mcpIds.has(server.id))
      throw new Error(`duplicate MCP server id: ${server.id}`);
    mcpIds.add(server.id);
  }
  return config;
}
