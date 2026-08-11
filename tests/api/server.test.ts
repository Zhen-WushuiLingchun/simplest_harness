import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TmshApiServer } from "../../src/api/server.js";
import { resolveConfig } from "../../src/core/config.js";
import { EventStore } from "../../src/core/event-store.js";
import type { ModelDescriptor } from "../../src/core/types.js";
import {
  FakeModelAdapter,
  type ModelTurnOutput,
} from "../../src/models/adapter.js";
import { ModelRegistry } from "../../src/models/registry.js";
import { RunEngine } from "../../src/runtime/run-engine.js";

const openServers: TmshApiServer[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

describe("TmshApiServer", () => {
  it("starts a run and streams its observed event sequence over SSE", async () => {
    const root = await mkdtemp(join(tmpdir(), "tmsh-api-"));
    const descriptor: ModelDescriptor = {
      id: "fake",
      provider: "fake",
      model: "fixed",
      supportsTools: true,
      supportsImages: false,
      capabilities: [],
    };
    const turn: ModelTurnOutput = {
      text: "API observed done",
      responseMessages: [{ role: "assistant", content: "API observed done" }],
      toolCalls: [],
      usage: {
        inputTokens: 4,
        outputTokens: 3,
        totalTokens: 7,
        estimated: false,
      },
      finishReason: "stop",
    };
    const models = new ModelRegistry(
      [descriptor],
      [new FakeModelAdapter(descriptor, [turn])],
    );
    const config = resolveConfig({
      dataDir: join(root, ".tmsh"),
      host: "127.0.0.1",
      port: 0,
      models: [descriptor],
      defaultModel: descriptor.id,
      autonomy: { mode: "yolo" },
    });
    const events = new EventStore(config.dataDir);
    const engine = new RunEngine(config, events, models, process.cwd());
    const server = new TmshApiServer(config, engine, events, models);
    openServers.push(server);
    const address = await server.start();

    const created = await fetch(`${address.url}/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "API task",
        workspace: root,
        autonomy: "yolo",
      }),
    });
    expect(created.status).toBe(202);
    const { runId } = (await created.json()) as { runId: string };
    await engine.wait(runId);

    const stream = await fetch(`${address.url}/v1/runs/${runId}/events/stream`);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body!.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain("event: run.created");
    expect(text).toContain("event: done");
    await reader.cancel();

    const snapshot = await fetch(`${address.url}/v1/runs/${runId}`);
    await expect(snapshot.json()).resolves.toMatchObject({
      run: { status: "done", finalText: "API observed done" },
    });
  });
});
