import type { RunEvent } from "../core/types.js";
import type { JsonValue } from "../core/types.js";
import { sha256Json } from "./canonical.js";
import type { CompactionSource } from "./schema.js";

export function createCompactionSource(
  runId: string,
  events: readonly RunEvent[],
): CompactionSource {
  if (events.length === 0)
    throw new Error("cannot compact an empty event range");
  for (const [index, event] of events.entries()) {
    if (event.runId !== runId)
      throw new Error(`event ${event.id} belongs to another run`);
    if (index > 0 && event.seq !== events[index - 1]!.seq + 1) {
      throw new Error(`event sequence is not contiguous at ${event.seq}`);
    }
  }
  return {
    runId,
    fromSeq: events[0]!.seq,
    throughSeq: events.at(-1)!.seq,
    eventDigest: sha256Json(events as unknown as JsonValue),
  };
}
