import { EventEmitter } from "node:events";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { NewRunEvent, RunEvent } from "./types.js";

export class EventStore {
  readonly #root: string;
  readonly #emitters = new Map<string, EventEmitter>();
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #sequences = new Map<string, number>();

  public constructor(root: string) {
    this.#root = root;
  }

  public eventPath(runId: string): string {
    return join(this.#root, "runs", runId, "events.jsonl");
  }

  public async append(runId: string, next: NewRunEvent): Promise<RunEvent> {
    const previous = this.#queues.get(runId) ?? Promise.resolve();
    const current = previous.then(async () => {
      const seq = await this.#nextSequence(runId);
      const event: RunEvent = {
        id: randomUUID(),
        runId,
        seq,
        at: new Date().toISOString(),
        type: next.type,
        data: next.data,
      };
      const path = this.eventPath(runId);
      await mkdir(dirname(path), { recursive: true });
      const handle = await open(path, "a");
      try {
        await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.#sequences.set(runId, seq);
      this.#emitter(runId).emit("event", event);
      return event;
    });
    this.#queues.set(runId, current.catch(() => undefined));
    return current;
  }

  public async replay(runId: string): Promise<RunEvent[]> {
    let text: string;
    try {
      text = await readFile(this.eventPath(runId), "utf8");
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const events: RunEvent[] = [];
    for (const [index, line] of text.split("\n").entries()) {
      if (line.length === 0) continue;
      const event = JSON.parse(line) as RunEvent;
      if (event.runId !== runId || event.seq !== events.length + 1) {
        throw new Error(`invalid event sequence at line ${index + 1}`);
      }
      events.push(event);
    }
    return events;
  }

  public subscribe(runId: string, listener: (event: RunEvent) => void): () => void {
    const emitter = this.#emitter(runId);
    emitter.on("event", listener);
    return () => emitter.off("event", listener);
  }

  async #nextSequence(runId: string): Promise<number> {
    const known = this.#sequences.get(runId);
    if (known !== undefined) return known + 1;
    const events = await this.replay(runId);
    const current = events.at(-1)?.seq ?? 0;
    this.#sequences.set(runId, current);
    return current + 1;
  }

  #emitter(runId: string): EventEmitter {
    const existing = this.#emitters.get(runId);
    if (existing !== undefined) return existing;
    const emitter = new EventEmitter();
    this.#emitters.set(runId, emitter);
    return emitter;
  }
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

