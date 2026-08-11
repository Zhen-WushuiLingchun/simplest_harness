import type {
  CompactionCandidate,
  CompactionSource,
  LedgerEntry,
  LedgerSnapshot,
  NumericalResultEntry,
} from "../../src/context/schema.js";
import { PreservationLedger } from "../../src/context/ledger.js";

export const source: CompactionSource = {
  runId: "run-1",
  fromSeq: 1,
  throughSeq: 12,
  eventDigest: "a".repeat(64),
};

export function numericalEntry(overrides: Partial<NumericalResultEntry> = {}): NumericalResultEntry {
  return {
    id: "num.speed",
    category: "validated_numerical_result",
    sourceEventIds: ["event-7"],
    updatedAt: "2026-08-11T01:02:03.000Z",
    value: {
      quantity: "wave speed",
      literalValue: "299792458",
      unit: "m s^-1",
      parameters: { medium: "vacuum", temperature: "0 K (parameter retained literally)" },
      method: "defined SI constant",
      evidence: "event-7",
    },
    ...overrides,
  } as NumericalResultEntry;
}

export function ledgerWith(...entries: LedgerEntry[]): LedgerSnapshot {
  const ledger = new PreservationLedger();
  for (const entry of entries) ledger.upsert(entry);
  return ledger.snapshot();
}

export function validCandidate(ledger: LedgerSnapshot): CompactionCandidate {
  return {
    summary: {
      conclusions: ["The exact result is retained by ledger ID."],
      evidence: ["event-7"],
      openQuestions: ["Independent reproduction remains."],
      failedAttempts: ["Approximate calculation rounded the value."],
      unfinishedBranches: ["Run oracle comparison."],
      discardedPossibilities: ["Dropping the negative result was rejected."],
    },
    ledger,
    source,
  };
}
