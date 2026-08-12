export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type RunEventType =
  | "run.created"
  | "run.status"
  | "model.request"
  | "model.delta"
  | "model.response"
  | "model.delegation"
  | "tool.call"
  | "tool.result"
  | "process.output"
  | "context.ledger"
  | "context.compaction.requested"
  | "context.compaction.completed"
  | "context.compaction.failed"
  | "context.compaction.skipped"
  | "usage"
  | "input.required"
  | "error"
  | "done";

export interface RunEvent<TData extends JsonValue = JsonValue> {
  readonly id: string;
  readonly runId: string;
  readonly seq: number;
  readonly at: string;
  readonly type: RunEventType;
  readonly data: TData;
}

export interface NewRunEvent<TData extends JsonValue = JsonValue> {
  readonly type: RunEventType;
  readonly data: TData;
}

export type RunStatus =
  | "created"
  | "running"
  | "waiting"
  | "compacting"
  | "failed"
  | "cancelled"
  | "done";

export interface ModelDescriptor {
  readonly id: string;
  readonly provider: "openai" | "anthropic" | "openai-compatible" | "fake";
  readonly model: string;
  readonly apiKeyEnv?: string;
  readonly baseUrl?: string;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly supportsTools: boolean;
  readonly supportsImages: boolean;
  readonly relativeCost?: "low" | "medium" | "high";
  readonly capabilities: readonly string[];
}

export interface TokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheMissTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly estimated: boolean;
}
