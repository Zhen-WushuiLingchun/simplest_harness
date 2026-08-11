import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PreservationLedger, verifyLedgerSnapshot } from "../../src/context/ledger.js";
import { numericalEntry } from "./fixtures.js";

describe("PreservationLedger", () => {
  it("keeps exact numerical strings, units, parameters, and negative records", () => {
    const ledger = new PreservationLedger();
    ledger.upsert(numericalEntry());
    ledger.upsert({
      id: "failed.rounding",
      category: "failed_hypothesis",
      sourceEventIds: ["event-8"],
      updatedAt: "2026-08-11T01:03:03.000Z",
      value: {
        hypothesis: "A rounded approximation is oracle-equivalent.",
        outcome: "Failed: 2.9979e8 != 299792458 m s^-1.",
        whyFailed: "Rounding erased 2458 m s^-1.",
        evidence: "event-8",
      },
    });
    const restored = new PreservationLedger();
    restored.load(ledger.snapshot());
    expect(restored.snapshot()).toEqual(ledger.snapshot());
  });

  it("rejects a changed digest for arbitrary literal values", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (literalValue) => {
        const ledger = new PreservationLedger();
        ledger.upsert(numericalEntry({
          value: { ...numericalEntry().value, literalValue },
        }));
        const snapshot = ledger.snapshot();
        const corrupted = structuredClone(snapshot);
        corrupted.sections.validated_numerical_result[0]!.value.literalValue += " changed";
        expect(() => verifyLedgerSnapshot(corrupted)).toThrow(/digest mismatch/);
      }),
    );
  });

  it("keeps an ID in one category", () => {
    const ledger = new PreservationLedger();
    ledger.upsert(numericalEntry());
    expect(() =>
      ledger.upsert({
        id: "num.speed",
        category: "correctness_risk",
        sourceEventIds: [],
        updatedAt: "2026-08-11T01:04:03.000Z",
        value: { risk: "conflict", evidence: "test", impact: "ambiguous state" },
      }),
    ).toThrow(/category is immutable/);
  });
});
