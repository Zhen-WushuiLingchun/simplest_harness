import { canonicalJson, sha256Json } from "./canonical.js";
import {
  ledgerEntrySchema,
  ledgerSnapshotSchema,
  type LedgerCategory,
  type LedgerEntry,
  type LedgerSections,
  type LedgerSnapshot,
} from "./schema.js";
import type { JsonValue } from "../core/types.js";

export const LEDGER_CATEGORIES: readonly LedgerCategory[] = [
  "scientific_objective",
  "validated_numerical_result",
  "implementation_discrepancy",
  "failed_hypothesis",
  "git_state",
  "correctness_risk",
  "next_verification",
];

export class PreservationLedger {
  readonly #entries = new Map<string, LedgerEntry>();

  public upsert(input: unknown): LedgerEntry {
    const entry = ledgerEntrySchema.parse(input);
    const previous = this.#entries.get(entry.id);
    if (previous !== undefined && previous.category !== entry.category) {
      throw new Error(`ledger entry category is immutable for id: ${entry.id}`);
    }
    this.#entries.set(entry.id, entry);
    return entry;
  }

  public snapshot(): LedgerSnapshot {
    const sections = emptySections();
    for (const entry of [...this.#entries.values()].sort((left, right) => left.id.localeCompare(right.id))) {
      pushEntry(sections, entry);
    }
    const content = { version: 1 as const, sections };
    return { ...content, digest: sha256Json(content as JsonValue) };
  }

  public load(snapshotInput: unknown): void {
    const snapshot = verifyLedgerSnapshot(snapshotInput);
    const replacement = new Map<string, LedgerEntry>();
    for (const category of LEDGER_CATEGORIES) {
      for (const entry of snapshot.sections[category]) {
        if (replacement.has(entry.id)) throw new Error(`duplicate ledger entry id: ${entry.id}`);
        replacement.set(entry.id, entry);
      }
    }
    this.#entries.clear();
    for (const [id, entry] of replacement) this.#entries.set(id, entry);
  }
}

export function verifyLedgerSnapshot(input: unknown): LedgerSnapshot {
  const snapshot = ledgerSnapshotSchema.parse(input);
  const expected = sha256Json({ version: snapshot.version, sections: snapshot.sections } as JsonValue);
  if (snapshot.digest !== expected) throw new Error("ledger digest mismatch");

  const ids = new Set<string>();
  for (const category of LEDGER_CATEGORIES) {
    const entries = snapshot.sections[category];
    const sorted = [...entries].sort((left, right) => left.id.localeCompare(right.id));
    if (canonicalJson(entries as JsonValue) !== canonicalJson(sorted as JsonValue)) {
      throw new Error(`ledger section is not sorted: ${category}`);
    }
    for (const entry of entries) {
      if (ids.has(entry.id)) throw new Error(`duplicate ledger entry id: ${entry.id}`);
      ids.add(entry.id);
    }
  }
  return snapshot;
}

function emptySections(): LedgerSections {
  return {
    scientific_objective: [],
    validated_numerical_result: [],
    implementation_discrepancy: [],
    failed_hypothesis: [],
    git_state: [],
    correctness_risk: [],
    next_verification: [],
  };
}

function pushEntry(sections: LedgerSections, entry: LedgerEntry): void {
  switch (entry.category) {
    case "scientific_objective":
      sections.scientific_objective.push(entry);
      break;
    case "validated_numerical_result":
      sections.validated_numerical_result.push(entry);
      break;
    case "implementation_discrepancy":
      sections.implementation_discrepancy.push(entry);
      break;
    case "failed_hypothesis":
      sections.failed_hypothesis.push(entry);
      break;
    case "git_state":
      sections.git_state.push(entry);
      break;
    case "correctness_risk":
      sections.correctness_risk.push(entry);
      break;
    case "next_verification":
      sections.next_verification.push(entry);
      break;
  }
}
