import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelMessage, ToolResultPart } from "ai";
import type { AutonomyMode, TmshConfig } from "../core/config.js";
import type { EventStore } from "../core/event-store.js";
import { ToolRegistry } from "../core/tool-registry.js";
import type { JsonValue, RunStatus } from "../core/types.js";
import { ContextCompactor } from "../context/compactor.js";
import { collectGitState } from "../context/git-state.js";
import { PreservationLedger } from "../context/ledger.js";
import { createCompactionSource } from "../context/source.js";
import { decideCompaction } from "../context/threshold.js";
import type { CompactionArtifact, LedgerEntry } from "../context/schema.js";
import type { ModelAdapter } from "../models/adapter.js";
import type { ModelRegistry } from "../models/registry.js";
import { ApprovalGate } from "./approval-gate.js";
import {
  registerBuiltinTools,
  type DelegateInput,
  type RuntimeToolState,
} from "./builtin-tools.js";

export interface StartRunInput {
  readonly goal: string;
  readonly modelId?: string;
  readonly workspace: string;
  readonly autonomy?: AutonomyMode;
  readonly maxCalls?: number;
}

export interface RunSnapshot {
  readonly runId: string;
  readonly parentRunId?: string;
  readonly status: RunStatus;
  readonly goal: string;
  readonly modelId: string;
  readonly workspace: string;
  readonly autonomy: AutonomyMode;
  readonly depth: number;
  readonly modelCalls: number;
  readonly lastInputTokens: number;
  readonly finalText: string;
  readonly error?: string;
  readonly pendingApprovals: readonly string[];
}

interface RunRecord {
  readonly id: string;
  readonly parentRunId: string | undefined;
  readonly goal: string;
  readonly modelId: string;
  readonly workspace: string;
  readonly autonomy: AutonomyMode;
  readonly maxCalls: number;
  readonly depth: number;
  readonly controller: AbortController;
  readonly ledger: PreservationLedger;
  messages: ModelMessage[];
  status: RunStatus;
  modelCalls: number;
  lastInputTokens: number;
  finalText: string;
  error: string | undefined;
  compactionRequested: boolean;
  execution?: Promise<void>;
}

type ToolResultOutput = ToolResultPart["output"];

export class RunEngine {
  readonly #config: TmshConfig;
  readonly #events: EventStore;
  readonly #models: ModelRegistry;
  readonly #tools = new ToolRegistry();
  readonly #approvals = new ApprovalGate();
  readonly #runs = new Map<string, RunRecord>();
  readonly #distributionRoot: string;
  readonly #delegations = new Map<string, number>();

  public constructor(
    config: TmshConfig,
    events: EventStore,
    models: ModelRegistry,
    distributionRoot: string,
  ) {
    this.#config = config;
    this.#events = events;
    this.#models = models;
    this.#distributionRoot = distributionRoot;
    registerBuiltinTools(this.#tools, {
      config,
      events,
      models,
      state: (runId) => this.#toolState(runId),
      delegate: (runId, input) => this.#delegate(runId, input),
    });
  }

  public get tools(): ToolRegistry {
    return this.#tools;
  }

  public async start(input: StartRunInput): Promise<string> {
    return this.#start(input, undefined, 0);
  }

  public snapshot(runId: string): RunSnapshot {
    const run = this.#require(runId);
    return {
      runId,
      ...(run.parentRunId === undefined
        ? {}
        : { parentRunId: run.parentRunId }),
      status: run.status,
      goal: run.goal,
      modelId: run.modelId,
      workspace: run.workspace,
      autonomy: run.autonomy,
      depth: run.depth,
      modelCalls: run.modelCalls,
      lastInputTokens: run.lastInputTokens,
      finalText: run.finalText,
      ...(run.error === undefined ? {} : { error: run.error }),
      pendingApprovals: this.#approvals.list(runId),
    };
  }

  public list(): RunSnapshot[] {
    return [...this.#runs.keys()].map((id) => this.snapshot(id));
  }

  public async wait(runId: string): Promise<RunSnapshot> {
    const run = this.#require(runId);
    await run.execution;
    return this.snapshot(runId);
  }

  public approve(runId: string, toolCallId: string, allowed: boolean): void {
    this.#approvals.resolve(runId, toolCallId, allowed);
  }

  public cancel(runId: string): void {
    const run = this.#require(runId);
    run.controller.abort(new Error("cancelled by user"));
  }

  public requestCompaction(runId: string): void {
    const run = this.#require(runId);
    if (
      run.status === "done" ||
      run.status === "failed" ||
      run.status === "cancelled"
    ) {
      throw new Error(`cannot compact a terminal run: ${run.status}`);
    }
    run.compactionRequested = true;
  }

  async #start(
    input: StartRunInput,
    parentRunId: string | undefined,
    depth: number,
  ): Promise<string> {
    if (typeof input.goal !== "string" || input.goal.trim().length === 0)
      throw new Error("run goal must be a non-empty string");
    if (typeof input.workspace !== "string" || input.workspace.length === 0)
      throw new Error("run workspace must be a non-empty string");
    if (
      input.autonomy !== undefined &&
      input.autonomy !== "confirm" &&
      input.autonomy !== "yolo"
    )
      throw new Error("run autonomy must be confirm or yolo");
    if (
      input.maxCalls !== undefined &&
      (!Number.isInteger(input.maxCalls) || input.maxCalls <= 0)
    )
      throw new Error("run maxCalls must be a positive integer");
    const modelId = input.modelId ?? this.#config.defaultModel;
    if (modelId === undefined)
      throw new Error("no model selected and no defaultModel configured");
    this.#models.get(modelId);
    const id = randomUUID();
    const run: RunRecord = {
      id,
      parentRunId,
      goal: input.goal,
      modelId,
      workspace: input.workspace,
      autonomy: input.autonomy ?? this.#config.autonomy.mode,
      maxCalls: Math.min(
        input.maxCalls ?? this.#config.run.maxModelCalls,
        this.#config.run.maxModelCalls,
      ),
      depth,
      controller: new AbortController(),
      ledger: new PreservationLedger(),
      messages: [{ role: "user", content: input.goal }],
      status: "created",
      modelCalls: 0,
      lastInputTokens: 0,
      finalText: "",
      error: undefined,
      compactionRequested: false,
    };
    this.#runs.set(id, run);
    await this.#events.append(id, {
      type: "run.created",
      data: toJsonValue({
        runId: id,
        parentRunId: parentRunId ?? null,
        goal: input.goal,
        modelId,
        workspace: input.workspace,
        autonomy: run.autonomy,
        depth,
      }),
    });
    run.execution = this.#execute(run);
    return id;
  }

  async #execute(run: RunRecord): Promise<void> {
    run.status = "running";
    await this.#status(run);
    try {
      const adapter = this.#models.get(run.modelId);
      const systemBase = await this.#instructions(run.workspace);
      while (run.modelCalls < run.maxCalls) {
        if (run.controller.signal.aborted) throw run.controller.signal.reason;
        const decision = this.#contextDecision(run);
        if (decision.reason === "hard_trigger") {
          const compacted = await this.#compact(
            run,
            adapter,
            systemBase,
            "hard_trigger",
          );
          if (!compacted)
            throw new Error(
              "hard compaction failed; old context preserved; retry context.compact or increase the configured capacity",
            );
        }
        const softNotice =
          decision.reason === "soft_trigger"
            ? "\n\n[TMSH CONTEXT NOTICE] The soft context threshold is reached. Call context.compact now, or finish exactly one bounded verification step and then compact."
            : "";
        await this.#events.append(run.id, {
          type: "model.request",
          data: { modelId: run.modelId, call: run.modelCalls + 1 },
        });
        const turn = await adapter.complete({
          system: `${systemBase}${softNotice}`,
          messages: run.messages,
          tools: this.#tools.list(),
          signal: run.controller.signal,
          ...(adapter.descriptor.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: adapter.descriptor.maxOutputTokens }),
        });
        run.modelCalls += 1;
        run.lastInputTokens =
          turn.usage.inputTokens ?? estimateTokens(run.messages);
        run.finalText = turn.text || run.finalText;
        run.messages.push(...turn.responseMessages);
        await this.#events.append(run.id, {
          type: "model.response",
          data: toJsonValue({
            modelId: run.modelId,
            text: turn.text,
            finishReason: turn.finishReason,
            toolCalls: turn.toolCalls,
          }),
        });
        await this.#events.append(run.id, {
          type: "usage",
          data: toJsonValue(turn.usage),
        });

        for (const call of turn.toolCalls)
          await this.#executeTool(
            run,
            call.id,
            call.name,
            call.input,
            call.providerName,
          );
        if (run.compactionRequested) {
          run.compactionRequested = false;
          await this.#compact(run, adapter, systemBase, "model_requested");
        }
        if (turn.toolCalls.length === 0) {
          run.status = "done";
          await this.#events.append(run.id, {
            type: "done",
            data: { text: run.finalText },
          });
          return;
        }
      }
      throw new Error(`model call budget exhausted: ${run.maxCalls}`);
    } catch (error) {
      if (run.controller.signal.aborted) {
        run.status = "cancelled";
        run.error = messageOf(run.controller.signal.reason);
      } else {
        run.status = "failed";
        run.error = messageOf(error);
      }
      await this.#events.append(run.id, {
        type: "error",
        data: { message: run.error, status: run.status },
      });
    } finally {
      await this.#status(run);
    }
  }

  async #executeTool(
    run: RunRecord,
    callId: string,
    name: string,
    input: JsonValue,
    providerName?: string,
  ): Promise<void> {
    const definition = this.#tools.get(name);
    const callEvent = await this.#events.append(run.id, {
      type: "tool.call",
      data: toJsonValue({
        toolCallId: callId,
        name,
        input,
        effect: definition?.effect ?? "write",
      }),
    });
    let output: ToolResultOutput;
    if (definition === undefined) {
      output = { type: "error-text", value: `unknown tool: ${name}` };
    } else {
      const effect = definition.effect ?? "write";
      let allowed = true;
      if (run.autonomy !== "yolo" && effect !== "read") {
        run.status = "waiting";
        await this.#events.append(run.id, {
          type: "input.required",
          data: { toolCallId: callId, name, effect },
        });
        allowed = await this.#approvals.wait(
          run.id,
          callId,
          run.controller.signal,
        );
        run.status = "running";
      }
      if (!allowed) {
        output = { type: "execution-denied", reason: "denied by user" };
        await this.#events.append(run.id, {
          type: "tool.result",
          data: { toolCallId: callId, name, ok: false, denied: true },
        });
      } else {
        try {
          const value = await this.#tools.call(name, input, {
            runId: run.id,
            signal: run.controller.signal,
            eventId: callEvent.id,
          });
          output = { type: "json", value };
          await this.#events.append(run.id, {
            type: "tool.result",
            data: toJsonValue({ toolCallId: callId, name, ok: true, value }),
          });
        } catch (error) {
          output = { type: "error-text", value: messageOf(error) };
          await this.#events.append(run.id, {
            type: "tool.result",
            data: {
              toolCallId: callId,
              name,
              ok: false,
              error: messageOf(error),
            },
          });
        }
      }
    }
    run.messages.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: callId,
          toolName: providerName ?? name,
          output,
        },
      ],
    });
  }

  async #compact(
    run: RunRecord,
    adapter: ModelAdapter,
    system: string,
    reason: string,
  ): Promise<boolean> {
    await this.#events.append(run.id, {
      type: "context.compaction.requested",
      data: { reason },
    });
    const git = await collectGitState(run.workspace, []);
    run.ledger.upsert(git);
    await this.#events.append(run.id, {
      type: "context.ledger",
      data: toJsonValue(git),
    });
    const events = await this.#events.replay(run.id);
    const source = createCompactionSource(run.id, events);
    const ledger = run.ledger.snapshot();
    const messages = toJsonValue(run.messages) as JsonValue[];
    const summaryAdapter =
      this.#config.compaction.modelId === undefined
        ? adapter
        : this.#models.get(this.#config.compaction.modelId);
    const compactor = new ContextCompactor(
      this.#config.dataDir,
      async (request) => ({
        summary: await summaryAdapter.summarize({
          messages: request.messages,
          system,
          signal: run.controller.signal,
          ...(summaryAdapter.descriptor.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: summaryAdapter.descriptor.maxOutputTokens }),
        }),
        ledger: request.ledger,
        source: request.source,
      }),
    );
    const result = await compactor.compact({
      runId: run.id,
      messages,
      recentTurns: this.#config.compaction.recentTurns,
      ledger,
      source,
    });
    if (!result.accepted) {
      await this.#events.append(run.id, {
        type: "context.compaction.failed",
        data: { reasons: [...result.reasons] },
      });
      return false;
    }
    run.messages = [artifactMessage(result.artifact)];
    run.lastInputTokens = estimateTokens(run.messages);
    await this.#events.append(run.id, {
      type: "context.compaction.completed",
      data: toJsonValue({
        artifactPath: result.artifactPath,
        artifactDigest: result.artifact.artifactDigest,
        ledgerDigest: result.artifact.ledger.digest,
        source: result.artifact.source,
      }),
    });
    return true;
  }

  #contextDecision(run: RunRecord): ReturnType<typeof decideCompaction> {
    const descriptor = this.#models.descriptor(run.modelId);
    return decideCompaction({
      config: this.#config.compaction,
      ...(descriptor.maxInputTokens === undefined
        ? {}
        : { maxInputTokens: descriptor.maxInputTokens }),
      ...(descriptor.maxOutputTokens === undefined
        ? {}
        : { modelMaxOutputTokens: descriptor.maxOutputTokens }),
      observedInputTokens: run.lastInputTokens,
    });
  }

  #toolState(runId: string): RuntimeToolState {
    const run = this.#require(runId);
    return {
      workspace: run.workspace,
      ledgerUpsert: (entry) => {
        run.ledger.upsert(entry);
      },
      contextStatus: () =>
        toJsonValue({
          inputTokens: run.lastInputTokens,
          ...this.#contextDecision(run),
        }),
      requestCompaction: () => {
        run.compactionRequested = true;
      },
    };
  }

  async #delegate(
    parentRunId: string,
    input: DelegateInput,
  ): Promise<JsonValue> {
    const parent = this.#require(parentRunId);
    if (parent.depth >= this.#config.run.maxDelegationDepth)
      throw new Error("maximum delegation depth reached");
    const active = this.#delegations.get(parentRunId) ?? 0;
    if (active >= this.#config.run.maxConcurrentDelegations)
      throw new Error("maximum concurrent delegations reached");
    this.#delegations.set(parentRunId, active + 1);
    try {
      const childId = await this.#start(
        {
          goal: input.task,
          modelId: input.modelId,
          workspace: parent.workspace,
          autonomy: parent.autonomy,
          maxCalls: input.maxCalls,
        },
        parentRunId,
        parent.depth + 1,
      );
      await this.#events.append(parentRunId, {
        type: "model.delegation",
        data: { childRunId: childId, modelId: input.modelId, task: input.task },
      });
      const child = await this.wait(childId);
      return toJsonValue({
        runId: childId,
        status: child.status,
        modelId: child.modelId,
        output: child.finalText,
        error: child.error ?? null,
        modelCalls: child.modelCalls,
      });
    } finally {
      this.#delegations.set(parentRunId, active);
    }
  }

  async #instructions(workspace: string): Promise<string> {
    const resident = await readFile(
      join(this.#distributionRoot, "TMSH.md"),
      "utf8",
    );
    let project = "";
    try {
      project = await readFile(join(workspace, "AGENTS.md"), "utf8");
    } catch {
      project =
        "No project-local AGENTS.md was found. Perform the research-first bootstrap in TMSH.md before substantive work.";
    }
    return `${resident}\n\n# Opened project instructions\n\n${project}`;
  }

  async #status(run: RunRecord): Promise<void> {
    await this.#events.append(run.id, {
      type: "run.status",
      data: { status: run.status, modelCalls: run.modelCalls },
    });
  }

  #require(id: string): RunRecord {
    const run = this.#runs.get(id);
    if (run === undefined) throw new Error(`unknown run: ${id}`);
    return run;
  }
}

function artifactMessage(artifact: CompactionArtifact): ModelMessage {
  return {
    role: "user",
    content: `TMSH validated compacted state follows. Continue from it without changing exact ledger values.\n${JSON.stringify(artifact)}`,
  };
}

function estimateTokens(messages: readonly ModelMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
