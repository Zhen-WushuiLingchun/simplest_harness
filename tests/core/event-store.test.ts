import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventStore } from "../../src/core/event-store.js";

describe("EventStore", () => {
  it("serializes concurrent appends and replays valid JSONL", async () => {
    const root = await mkdtemp(join(tmpdir(), "tmsh-events-"));
    const store = new EventStore(root);
    const observed: number[] = [];
    const unsubscribe = store.subscribe("run-1", (event) =>
      observed.push(event.seq),
    );

    const events = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.append("run-1", { type: "run.status", data: { index } }),
      ),
    );
    unsubscribe();

    expect(events.map((event) => event.seq).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(observed).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect((await store.replay("run-1")).map((event) => event.seq)).toEqual(
      observed,
    );

    const raw = await readFile(store.eventPath("run-1"), "utf8");
    for (const line of raw.trim().split("\n"))
      expect(() => JSON.parse(line)).not.toThrow();
  });

  it("returns an empty replay for an unknown run", async () => {
    const root = await mkdtemp(join(tmpdir(), "tmsh-events-"));
    await expect(new EventStore(root).replay("missing")).resolves.toEqual([]);
  });
});
