import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ContextCompactor, validateCompactionCandidate } from "../../src/context/compactor.js";
import { ledgerWith, numericalEntry, source, validCandidate } from "./fixtures.js";

describe("ContextCompactor", () => {
  it("writes a validated artifact atomically and retains the recent tail verbatim", async () => {
    const root = await mkdtemp(join(tmpdir(), "tmsh-compaction-"));
    const ledger = ledgerWith(numericalEntry());
    const compactor = new ContextCompactor(root, async () => validCandidate(ledger));
    const result = await compactor.compact({
      runId: "run-1",
      messages: [{ role: "user", text: "old" }, { role: "assistant", text: "one" }, { role: "user", text: "exact tail" }],
      recentTurns: 1,
      ledger,
      source,
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.artifact.recentTail).toEqual([{ role: "assistant", text: "one" }, { role: "user", text: "exact tail" }]);
    expect(JSON.parse(await readFile(result.artifactPath, "utf8"))).toEqual(result.artifact);
  });

  it("rejects a missing ledger entry and writes no artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "tmsh-compaction-"));
    const ledger = ledgerWith(numericalEntry());
    const empty = ledgerWith();
    const compactor = new ContextCompactor(root, async () => validCandidate(empty));
    const result = await compactor.compact({ runId: "run-1", messages: [], recentTurns: 0, ledger, source });
    expect(result).toMatchObject({ accepted: false });
    await expect(access(join(root, "runs", "run-1", "compactions"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects paraphrased numeric values even if the candidate recomputes its digest", () => {
    const ledger = ledgerWith(numericalEntry());
    const changedLedger = ledgerWith(numericalEntry({
      value: { ...numericalEntry().value, literalValue: "approximately 3e8" },
    }));
    const result = validateCompactionCandidate(validCandidate(changedLedger), ledger, source);
    expect(result).toMatchObject({ ok: false });
  });

  it("rejects an incorrect source boundary and a summarizer failure", async () => {
    const ledger = ledgerWith(numericalEntry());
    expect(validateCompactionCandidate({ ...validCandidate(ledger), source: { ...source, throughSeq: 11 } }, ledger, source)).toMatchObject({ ok: false });

    const root = await mkdtemp(join(tmpdir(), "tmsh-compaction-"));
    const compactor = new ContextCompactor(root, async () => {
      throw new Error("provider limit");
    });
    await expect(compactor.compact({ runId: "run-1", messages: [], recentTurns: 0, ledger, source })).resolves.toEqual({
      accepted: false,
      reasons: ["summarizer failed: provider limit"],
    });
  });
});
