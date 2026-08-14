import type {
  ContentDigest,
  EvidenceRef,
  MaturityLevel,
  ProjectRelativePath,
  SchemaVersion,
  StableId,
  StatusAxes,
} from "./common.js";

export const L4_TARGET_COMPONENTS = [
  "prompts",
  "context",
  "loop-graph",
  "memory-policy",
  "recovery-policy",
] as const;
export type L4TargetComponent = (typeof L4_TARGET_COMPONENTS)[number];

export const L5_TARGET_COMPONENTS = [
  "judge",
  "learning-policy",
  "improvement-controller",
  "app-scaffold",
  "controller",
  "model-gateway",
  "runtime-profile",
] as const;
export type L5TargetComponent = (typeof L5_TARGET_COMPONENTS)[number];

export type CandidateTargetComponent = L4TargetComponent | L5TargetComponent;

export interface ProjectDescriptor {
  readonly id: StableId;
  readonly name: string;
  readonly domainSkill: StableId;
  readonly activeVersion: StableId;
}

export interface CharterDescriptor {
  readonly path: ProjectRelativePath;
  readonly confirmed: boolean;
  readonly confirmationReceipt?: EvidenceRef;
}

export interface ArtifactSpec {
  readonly id: StableId;
  readonly path: ProjectRelativePath;
  readonly owner: StableId;
  readonly kind: "input" | "output" | "evidence" | "memory";
  readonly protected: boolean;
}

export interface LoopSpec {
  readonly schemaVersion: SchemaVersion;
  readonly kind: "LoopSpec";
  readonly id: StableId;
  readonly goal: string;
  readonly reads: readonly StableId[];
  readonly writes: readonly StableId[];
  readonly owner: StableId;
  readonly producer: {
    readonly agent: StableId;
    readonly separateFromJudges: true;
  };
  readonly judges: readonly StableId[];
  readonly decisionPolicy: readonly ("hard-block" | "needs-taste" | "revise" | "commit" | "stop" | "escalate")[];
  readonly retryBudget: {
    readonly maxAttempts: number;
    readonly maxNoImprovement: number;
    readonly onBudgetExhausted: "stop" | "escalate";
  };
  readonly stopConditions: readonly string[];
  readonly humanGate: {
    readonly required: boolean;
    readonly when: string;
  };
}

export interface JudgeSpec {
  readonly schemaVersion: SchemaVersion;
  readonly kind: "JudgeSpec";
  readonly id: StableId;
  readonly type: "deterministic" | "model" | "human";
  readonly mode: "shadow" | "warn" | "block";
  readonly agent: StableId;
  readonly rubric: readonly string[];
  readonly evidenceRequirements: readonly ProjectRelativePath[];
  readonly calibration: ProjectRelativePath | null;
}

export interface Finding {
  readonly code: StableId;
  readonly category: "hard-contract" | "soft-quality" | "human-charter" | "runtime";
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly confidence: number;
  readonly evidence: readonly EvidenceRef[];
  readonly owner: StableId;
  readonly suggestedAction: string;
  readonly status: "open" | "resolved" | "accepted-risk";
}

/** Non-governing projection for app and IPC display only. */
export interface CreativeSystemAppViewModel {
  readonly sourceOfTruth: "python-controller-on-disk";
  readonly schemaVersion: SchemaVersion;
  readonly kind: "CreativeSystem";
  readonly project: ProjectDescriptor;
  readonly charter: CharterDescriptor;
  readonly maturity: {
    readonly declared: MaturityLevel;
    readonly evidence: readonly EvidenceRef[];
  };
  readonly loops: readonly ProjectRelativePath[];
  readonly artifacts: readonly ArtifactSpec[];
  readonly judges: readonly ProjectRelativePath[];
  readonly protectedSurfaces: readonly ProjectRelativePath[];
  readonly editableSurfaces: readonly string[];
  readonly statuses: StatusAxes;
}

/** Non-governing authoring DTO. Use SystemCandidate for Python on-disk evidence. */
export interface CandidateProposalAppViewModel {
  readonly schemaVersion: SchemaVersion;
  readonly kind: "LearningProposal";
  readonly id: StableId;
  readonly maturity: "L4" | "L5";
  readonly experimental: boolean;
  readonly sourceFindingCodes: readonly StableId[];
  readonly sourceRunIds: readonly StableId[];
  readonly rootCauseHypothesis: string;
  readonly targetComponent: CandidateTargetComponent;
  readonly changeSummary: string;
  readonly changedPaths: readonly ProjectRelativePath[];
  readonly protectedSurfaces: readonly ProjectRelativePath[];
  readonly rollbackVersion: StableId;
  readonly candidateChanges: readonly ContentDigest[];
}
