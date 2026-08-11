import { resolve } from "node:path";
import { z } from "zod";
import type { TmshConfig } from "../core/config.js";
import type { EventStore } from "../core/event-store.js";
import type { JsonValue } from "../core/types.js";
import type { ToolRegistry } from "../core/tool-registry.js";
import { ledgerEntrySchema, type LedgerEntry } from "../context/schema.js";
import { fetchWebContent } from "../tools/http-fetch.js";
import {
  ProcessManager,
  type ProcessSnapshot,
} from "../tools/process-manager.js";
import type { ModelRegistry } from "../models/registry.js";

export interface RuntimeToolState {
  readonly workspace: string;
  readonly ledgerUpsert: (entry: LedgerEntry) => void;
  readonly contextStatus: () => JsonValue;
  readonly requestCompaction: () => void;
}

export interface DelegateInput {
  readonly modelId: string;
  readonly task: string;
  readonly maxCalls: number;
}

export interface BuiltinToolServices {
  readonly config: TmshConfig;
  readonly events: EventStore;
  readonly models: ModelRegistry;
  readonly state: (runId: string) => RuntimeToolState;
  readonly delegate: (
    runId: string,
    input: DelegateInput,
  ) => Promise<JsonValue>;
}

const processStartSchema = z.object({
  file: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  shell: z.boolean().optional(),
  background: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  yieldMs: z.number().int().nonnegative().optional(),
  envFrom: z.record(z.string(), z.string()).optional(),
});
const processWaitSchema = z.object({
  processId: z.string().min(1),
  cursor: z.number().int().nonnegative().optional(),
  yieldMs: z.number().int().nonnegative().optional(),
});
const processStdinSchema = z
  .object({
    processId: z.string().min(1),
    text: z.string().optional(),
    textEnv: z.string().optional(),
    end: z.boolean().optional(),
  })
  .refine(
    (value) => (value.text === undefined) !== (value.textEnv === undefined),
    "provide exactly one of text or textEnv",
  );
const processStopSchema = z.object({
  processId: z.string().min(1),
  signal: z.string().optional(),
});
const httpSchema = z.object({
  url: z.string().url(),
  timeoutMs: z.number().int().positive().optional(),
  maxBytes: z.number().int().positive().optional(),
  maxRedirects: z.number().int().nonnegative().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  headerEnv: z.record(z.string(), z.string()).optional(),
});
const delegateSchema = z.object({
  modelId: z.string().min(1),
  task: z.string().min(1),
  maxCalls: z.number().int().positive().max(100).optional(),
});

export function registerBuiltinTools(
  registry: ToolRegistry,
  services: BuiltinToolServices,
): ProcessManager {
  const processes = new ProcessManager();

  registry.register({
    name: "model.list",
    description:
      "List registered models, capabilities, context capacities, cost notes, and current availability.",
    inputSchema: objectSchema({}),
    effect: "read",
    execute: async () => toJsonValue(services.models.list()),
  });
  registry.register({
    name: "model.delegate",
    description:
      "Delegate a bounded task to a specifically selected registered model. The caller must synthesize the result.",
    inputSchema: objectSchema(
      {
        modelId: { type: "string" },
        task: { type: "string" },
        maxCalls: { type: "integer", minimum: 1, maximum: 100 },
      },
      ["modelId", "task"],
    ),
    effect: "external",
    execute: async (input, context) => {
      const parsed = delegateSchema.parse(input);
      return services.delegate(context.runId, {
        modelId: parsed.modelId,
        task: parsed.task,
        maxCalls: parsed.maxCalls ?? 8,
      });
    },
  });
  registry.register({
    name: "context.status",
    description:
      "Show current input-token use, known capacity, soft/hard compaction thresholds, and trigger decision.",
    inputSchema: objectSchema({}),
    effect: "read",
    execute: async (_input, context) =>
      services.state(context.runId).contextStatus(),
  });
  registry.register({
    name: "context.compact",
    description:
      "Request context compaction now. The runtime will accept it only after lossless ledger and source validation.",
    inputSchema: objectSchema({}),
    effect: "write",
    execute: async (_input, context) => {
      services.state(context.runId).requestCompaction();
      return { requested: true };
    },
  });
  registry.register({
    name: "context.ledger.upsert",
    description:
      "Insert or update one exact preservation record. The runtime supplies timestamp and source event ID.",
    inputSchema: objectSchema(
      {
        id: { type: "string" },
        category: { type: "string" },
        value: { type: "object" },
      },
      ["id", "category", "value"],
    ),
    effect: "write",
    execute: async (input, context) => {
      const raw = asObject(input);
      const entry = ledgerEntrySchema.parse({
        id: raw.id,
        category: raw.category,
        value: raw.value,
        sourceEventIds: context.eventId === undefined ? [] : [context.eventId],
        updatedAt: new Date().toISOString(),
      });
      services.state(context.runId).ledgerUpsert(entry);
      return toJsonValue(entry);
    },
  });
  registry.register({
    name: "process.start",
    description:
      "Start a command with structured argv. Shell parsing is used only when shell=true. Returns after exit or yield; background returns immediately.",
    inputSchema: objectSchema(
      {
        file: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        shell: { type: "boolean" },
        background: { type: "boolean" },
        timeoutMs: { type: "integer" },
        yieldMs: { type: "integer" },
        envFrom: { type: "object" },
      },
      ["file"],
    ),
    effect: "write",
    execute: async (input, context) => {
      const parsed = processStartSchema.parse(input);
      const state = services.state(context.runId);
      const snapshot = await processes.start({
        file: parsed.file,
        ...(parsed.args === undefined ? {} : { args: parsed.args }),
        cwd: resolve(state.workspace, parsed.cwd ?? "."),
        ...(parsed.shell === undefined ? {} : { shell: parsed.shell }),
        ...(parsed.background === undefined
          ? {}
          : { background: parsed.background }),
        timeoutMs: parsed.timeoutMs ?? services.config.process.defaultTimeoutMs,
        yieldMs: parsed.yieldMs ?? services.config.process.defaultYieldMs,
        maxOutputBytes: services.config.process.maxOutputBytes,
        env: resolveEnvironment(parsed.envFrom),
      });
      await emitOutput(services.events, context.runId, snapshot);
      return toJsonValue(snapshot);
    },
  });
  registry.register({
    name: "process.wait",
    description:
      "Wait a bounded time for a background process and return output newer than cursor.",
    inputSchema: objectSchema(
      {
        processId: { type: "string" },
        cursor: { type: "integer" },
        yieldMs: { type: "integer" },
      },
      ["processId"],
    ),
    effect: "read",
    execute: async (input, context) => {
      const parsed = processWaitSchema.parse(input);
      const snapshot = await processes.wait({
        processId: parsed.processId,
        ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
        yieldMs: parsed.yieldMs ?? services.config.process.defaultYieldMs,
      });
      await emitOutput(services.events, context.runId, snapshot);
      return toJsonValue(snapshot);
    },
  });
  registry.register({
    name: "process.stdin",
    description:
      "Write text or the value of a named environment variable to a running process; optionally close stdin.",
    inputSchema: objectSchema(
      {
        processId: { type: "string" },
        text: { type: "string" },
        textEnv: { type: "string" },
        end: { type: "boolean" },
      },
      ["processId"],
    ),
    effect: "write",
    execute: async (input) => {
      const parsed = processStdinSchema.parse(input);
      const text = parsed.text ?? readEnvironment(parsed.textEnv!);
      processes.writeStdin(parsed.processId, text, parsed.end ?? false);
      return {
        writtenBytes: Buffer.byteLength(text, "utf8"),
        ended: parsed.end ?? false,
      };
    },
  });
  registry.register({
    name: "process.stop",
    description: "Stop a running background process.",
    inputSchema: objectSchema(
      { processId: { type: "string" }, signal: { type: "string" } },
      ["processId"],
    ),
    effect: "write",
    execute: async (input) => {
      const parsed = processStopSchema.parse(input);
      return toJsonValue(
        processes.stop(
          parsed.processId,
          (parsed.signal ?? "SIGTERM") as NodeJS.Signals,
        ),
      );
    },
  });
  registry.register({
    name: "http.fetch",
    description:
      "Fetch bounded HTTP/HTTPS page content with explicit redirect, byte, and timeout limits. Secret headers use environment-variable names.",
    inputSchema: objectSchema(
      {
        url: { type: "string" },
        timeoutMs: { type: "integer" },
        maxBytes: { type: "integer" },
        maxRedirects: { type: "integer" },
        headers: { type: "object" },
        headerEnv: { type: "object" },
      },
      ["url"],
    ),
    effect: "external",
    execute: async (input) => {
      const parsed = httpSchema.parse(input);
      return toJsonValue(
        await fetchWebContent({
          url: parsed.url,
          ...(parsed.timeoutMs === undefined
            ? {}
            : { timeoutMs: parsed.timeoutMs }),
          ...(parsed.maxBytes === undefined
            ? {}
            : { maxBytes: parsed.maxBytes }),
          ...(parsed.maxRedirects === undefined
            ? {}
            : { maxRedirects: parsed.maxRedirects }),
          headers: {
            ...(parsed.headers ?? {}),
            ...resolveEnvironment(parsed.headerEnv),
          },
        }),
      );
    },
  });
  return processes;
}

function objectSchema(
  properties: Record<string, JsonValue>,
  required: readonly string[] = [],
): Record<string, JsonValue> {
  return {
    type: "object",
    properties,
    required: [...required],
    additionalProperties: false,
  };
}

function resolveEnvironment(
  mapping: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(mapping ?? {}).map(([name, envName]) => [
      name,
      readEnvironment(envName),
    ]),
  );
}

function readEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined)
    throw new Error(`environment variable is missing: ${name}`);
  return value;
}

async function emitOutput(
  events: EventStore,
  runId: string,
  snapshot: ProcessSnapshot,
): Promise<void> {
  for (const output of snapshot.output) {
    await events.append(runId, {
      type: "process.output",
      data: toJsonValue({ processId: snapshot.processId, ...output }),
    });
  }
}

function asObject(value: JsonValue): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("tool input must be an object");
  return value;
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
