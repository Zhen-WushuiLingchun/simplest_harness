import { z } from "zod";

const exactText = z.string().min(1);
const sourceFields = {
  id: z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/),
  sourceEventIds: z.array(z.string().min(1)),
  updatedAt: z.iso.datetime(),
} as const;

export const scientificObjectiveEntrySchema = z
  .object({
    ...sourceFields,
    category: z.literal("scientific_objective"),
    value: z
      .object({ objective: exactText, assumptions: z.array(exactText) })
      .strict(),
  })
  .strict();

export const numericalResultEntrySchema = z
  .object({
    ...sourceFields,
    category: z.literal("validated_numerical_result"),
    value: z
      .object({
        quantity: exactText,
        literalValue: exactText,
        unit: exactText,
        parameters: z.record(z.string(), exactText),
        method: exactText,
        evidence: exactText,
      })
      .strict(),
  })
  .strict();

export const discrepancyEntrySchema = z
  .object({
    ...sourceFields,
    category: z.literal("implementation_discrepancy"),
    value: z
      .object({
        approximate: exactText,
        oracle: exactText,
        discrepancy: exactText,
        evidence: exactText,
      })
      .strict(),
  })
  .strict();

export const failedHypothesisEntrySchema = z
  .object({
    ...sourceFields,
    category: z.literal("failed_hypothesis"),
    value: z
      .object({
        hypothesis: exactText,
        outcome: exactText,
        whyFailed: exactText,
        evidence: exactText,
      })
      .strict(),
  })
  .strict();

export const gitStateEntrySchema = z
  .object({
    ...sourceFields,
    category: z.literal("git_state"),
    value: z
      .object({
        available: z.boolean(),
        head: z.string(),
        branch: z.string(),
        status: z.string(),
        modifiedFiles: z.array(z.string()),
        error: z.string().optional(),
      })
      .strict(),
  })
  .strict();

export const correctnessRiskEntrySchema = z
  .object({
    ...sourceFields,
    category: z.literal("correctness_risk"),
    value: z
      .object({ risk: exactText, evidence: exactText, impact: exactText })
      .strict(),
  })
  .strict();

export const nextVerificationEntrySchema = z
  .object({
    ...sourceFields,
    category: z.literal("next_verification"),
    value: z
      .object({
        step: exactText,
        command: z.string().optional(),
        expected: exactText,
        evidenceNeeded: exactText,
      })
      .strict(),
  })
  .strict();

export const ledgerEntrySchema = z.discriminatedUnion("category", [
  scientificObjectiveEntrySchema,
  numericalResultEntrySchema,
  discrepancyEntrySchema,
  failedHypothesisEntrySchema,
  gitStateEntrySchema,
  correctnessRiskEntrySchema,
  nextVerificationEntrySchema,
]);

export const ledgerSectionsSchema = z
  .object({
    scientific_objective: z.array(scientificObjectiveEntrySchema),
    validated_numerical_result: z.array(numericalResultEntrySchema),
    implementation_discrepancy: z.array(discrepancyEntrySchema),
    failed_hypothesis: z.array(failedHypothesisEntrySchema),
    git_state: z.array(gitStateEntrySchema),
    correctness_risk: z.array(correctnessRiskEntrySchema),
    next_verification: z.array(nextVerificationEntrySchema),
  })
  .strict();

export const ledgerSnapshotSchema = z
  .object({
    version: z.literal(1),
    sections: ledgerSectionsSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const retracSummarySchema = z
  .object({
    conclusions: z.array(z.string()),
    evidence: z.array(z.string()),
    openQuestions: z.array(z.string()),
    failedAttempts: z.array(z.string()),
    unfinishedBranches: z.array(z.string()),
    discardedPossibilities: z.array(z.string()),
  })
  .strict();

export const compactionSourceSchema = z
  .object({
    runId: z.string().min(1),
    fromSeq: z.number().int().positive(),
    throughSeq: z.number().int().positive(),
    eventDigest: z.string().regex(/^[a-f0-9]{64}$/),
    priorSession: z
      .object({
        sessionId: z.string().uuid(),
        stateDigest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (source) => source.throughSeq >= source.fromSeq,
    "throughSeq must not precede fromSeq",
  );

export const compactionCandidateSchema = z
  .object({
    summary: retracSummarySchema,
    ledger: ledgerSnapshotSchema,
    source: compactionSourceSchema,
  })
  .strict();

export const compactionArtifactSchema = z
  .object({
    version: z.literal(1),
    createdAt: z.iso.datetime(),
    summary: retracSummarySchema,
    ledger: ledgerSnapshotSchema,
    recentTail: z.array(z.unknown()),
    source: compactionSourceSchema,
    artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;
export type NumericalResultEntry = z.infer<typeof numericalResultEntrySchema>;
export type LedgerSections = z.infer<typeof ledgerSectionsSchema>;
export type LedgerSnapshot = z.infer<typeof ledgerSnapshotSchema>;
export type RetracSummary = z.infer<typeof retracSummarySchema>;
export type CompactionSource = z.infer<typeof compactionSourceSchema>;
export type CompactionCandidate = z.infer<typeof compactionCandidateSchema>;
export type CompactionArtifact = z.infer<typeof compactionArtifactSchema>;
export type LedgerCategory = LedgerEntry["category"];
