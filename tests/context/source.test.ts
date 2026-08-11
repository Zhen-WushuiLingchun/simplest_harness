import { describe, expect, it } from "vitest";
import { createCompactionSource } from "../../src/context/source.js";
import type { RunEvent } from "../../src/core/types.js";

function event(seq: number, runId = "run-1"): RunEvent {
  return { id: `event-${seq}`, runId, seq, at: "2026-08-11T01:00:00.000Z", type: "run.status", data: { seq } };
}

describe("createCompactionSource", () => {
  it("binds an exact contiguous event range to a digest", () => {
    const first = createCompactionSource("run-1", [event(2), event(3)]);
    const changed = createCompactionSource("run-1", [event(2), { ...event(3), data: { seq: 999 } }]);
    expect(first).toMatchObject({ fromSeq: 2, throughSeq: 3 });
    expect(first.eventDigest).not.toBe(changed.eventDigest);
  });

  it("rejects empty, cross-run, and non-contiguous ranges", () => {
    expect(() => createCompactionSource("run-1", [])).toThrow(/empty/);
    expect(() => createCompactionSource("run-1", [event(1, "run-2")])).toThrow(/another run/);
    expect(() => createCompactionSource("run-1", [event(1), event(3)])).toThrow(/not contiguous/);
  });
});
