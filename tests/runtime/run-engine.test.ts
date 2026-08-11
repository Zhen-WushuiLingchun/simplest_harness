import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/core/config.js";
import { EventStore } from "../../src/core/event-store.js";
import { SessionStore } from "../../src/core/session-store.js";
import type { JsonValue, ModelDescriptor } from "../../src/core/types.js";
import {
  FakeModelAdapter,
  type ModelToolCall,
  type ModelTurnOutput,
} from "../../src/models/adapter.js";
import { ModelRegistry } from "../../src/models/registry.js";
import { RunEngine } from "../../src/runtime/run-engine.js";

const distributionRoot = process.cwd();

function descriptor(id: string): ModelDescriptor {
  return {
    id,
    provider: "fake",
    model: "deterministic",
    maxInputTokens: 100_000,
    maxOutputTokens: 4_000,
    supportsTools: true,
    supportsImages: false,
    capabilities: ["tests"],
  };
}

function toolTurn(call: ModelToolCall, inputTokens = 100): ModelTurnOutput {
  const response: ModelMessage = {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: call.id,
        toolName: call.name,
        input: call.input,
      },
    ],
  };
  return {
    text: "",
    responseMessages: [response],
    toolCalls: [call],
    usage: {
      inputTokens,
      outputTokens: 10,
      totalTokens: inputTokens + 10,
      estimated: false,
    },
    finishReason: "tool-calls",
  };
}

function finalTurn(text: string): ModelTurnOutput {
  return {
    text,
    responseMessages: [{ role: "assistant", content: text }],
    toolCalls: [],
    usage: {
      inputTokens: 120,
      outputTokens: 5,
      totalTokens: 125,
      estimated: false,
    },
    finishReason: "stop",
  };
}

async function fixture(
  adapters: readonly FakeModelAdapter[],
  autonomy: "confirm" | "yolo" = "yolo",
) {
  const root = await mkdtemp(join(tmpdir(), "tmsh-engine-"));
  const models = adapters.map((adapter) => adapter.descriptor);
  const config = resolveConfig({
    dataDir: join(root, ".tmsh"),
    models,
    defaultModel: models[0]!.id,
    autonomy: { mode: autonomy },
  });
  const events = new EventStore(config.dataDir);
  return {
    root,
    events,
    engine: new RunEngine(
      config,
      events,
      new ModelRegistry(models, adapters),
      distributionRoot,
    ),
  };
}

describe("RunEngine", () => {
  it("executes a model-selected process in YOLO mode and observes output before completion", async () => {
    const model = new FakeModelAdapter(descriptor("main"), [
      toolTurn({
        id: "call-process",
        name: "process.start",
        input: {
          file: process.execPath,
          args: ["-e", "process.stdout.write('observed')"],
          background: false,
        },
      }),
      finalTurn("verified done"),
    ]);
    const { root, events, engine } = await fixture([model]);
    const runId = await engine.start({
      goal: "Run the observed command",
      workspace: root,
      autonomy: "yolo",
    });
    await expect(engine.wait(runId)).resolves.toMatchObject({
      status: "done",
      finalText: "verified done",
      modelCalls: 2,
    });
    const types = (await events.replay(runId)).map((event) => event.type);
    expect(types).toContain("process.output");
    expect(types).toContain("tool.result");
    expect(types.at(-2)).toBe("done");
    expect(
      model.inputs[1]!.messages.some((message) => message.role === "tool"),
    ).toBe(true);
  });

  it("pauses mutating tools for approval outside YOLO mode", async () => {
    const model = new FakeModelAdapter(descriptor("main"), [
      toolTurn({
        id: "approve-me",
        name: "process.start",
        input: {
          file: process.execPath,
          args: ["-e", "process.stdout.write('approved')"],
        },
      }),
      finalTurn("approved done"),
    ]);
    const { root, engine } = await fixture([model], "confirm");
    const runId = await engine.start({
      goal: "Needs approval",
      workspace: root,
    });
    await until(() =>
      engine.snapshot(runId).pendingApprovals.includes("approve-me"),
    );
    expect(engine.snapshot(runId).status).toBe("waiting");
    engine.approve(runId, "approve-me", true);
    await expect(engine.wait(runId)).resolves.toMatchObject({
      status: "done",
      finalText: "approved done",
    });
  });

  it("validates a model-requested compaction and resumes from the artifact", async () => {
    const model = new FakeModelAdapter(
      descriptor("main"),
      [
        toolTurn({ id: "compact-now", name: "context.compact", input: {} }),
        finalTurn("resumed"),
      ],
      {
        conclusions: ["Continue after a validated boundary."],
        evidence: ["tool call compact-now"],
        openQuestions: [],
        failedAttempts: ["No negative results were removed."],
        unfinishedBranches: ["Finish the fake run."],
        discardedPossibilities: [],
      },
    );
    const { root, events, engine } = await fixture([model]);
    const runId = await engine.start({
      goal: "Compact then finish",
      workspace: root,
    });
    await expect(engine.wait(runId)).resolves.toMatchObject({
      status: "done",
      finalText: "resumed",
    });
    const replay = await events.replay(runId);
    expect(
      replay.some((event) => event.type === "context.compaction.completed"),
    ).toBe(true);
    expect(JSON.stringify(model.inputs[1]!.messages)).toContain(
      "validated compacted state",
    );
  });

  it("lets the model select and delegate to another registered model", async () => {
    const main = new FakeModelAdapter(descriptor("main"), [
      toolTurn({
        id: "delegate",
        name: "model.delegate",
        input: { modelId: "reviewer", task: "independent review", maxCalls: 2 },
      }),
      finalTurn("synthesized reviewer result"),
    ]);
    const reviewer = new FakeModelAdapter(descriptor("reviewer"), [
      finalTurn("review found one risk"),
    ]);
    const { root, events, engine } = await fixture([main, reviewer]);
    const runId = await engine.start({
      goal: "Choose a reviewer",
      workspace: root,
    });
    await expect(engine.wait(runId)).resolves.toMatchObject({
      status: "done",
      finalText: "synthesized reviewer result",
    });
    const delegation = (await events.replay(runId)).find(
      (event) => event.type === "model.delegation",
    );
    expect(delegation?.data as Record<string, JsonValue>).toMatchObject({
      modelId: "reviewer",
      task: "independent review",
    });
    expect(engine.list()).toHaveLength(2);
  });

  it("continues a durable session with prior messages intact", async () => {
    const model = new FakeModelAdapter(descriptor("main"), [
      finalTurn("first answer"),
      finalTurn("second answer"),
    ]);
    const root = await mkdtemp(join(tmpdir(), "tmsh-engine-session-"));
    const config = resolveConfig({
      dataDir: join(root, ".tmsh"),
      models: [model.descriptor],
      defaultModel: model.descriptor.id,
      autonomy: { mode: "yolo" },
    });
    const sessions = new SessionStore(config.dataDir);
    const session = await sessions.create({
      title: "two turns",
      workspace: root,
      modelId: "main",
    });
    const engine = new RunEngine(
      config,
      new EventStore(config.dataDir),
      new ModelRegistry([model.descriptor], [model]),
      distributionRoot,
      sessions,
    );
    const first = await engine.start({
      goal: "first question",
      workspace: root,
      sessionId: session.id,
    });
    await engine.wait(first);
    const second = await engine.start({
      goal: "second question",
      workspace: root,
      sessionId: session.id,
    });
    await engine.wait(second);

    expect(model.inputs[1]!.messages).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
    ]);
    const persisted = await sessions.load(session.id);
    expect(persisted.messages.at(-1)).toEqual({
      role: "assistant",
      content: "second answer",
    });
  });
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
