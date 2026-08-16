import type {
  IsoTimestamp,
  JsonValue,
  ProjectRelativePath,
  StableId,
} from "./common.js";
import type { CandidateTargetComponent, CreativeSystemAppViewModel } from "./system.js";

export const PYTHON_GOVERNANCE_SOURCE_OF_TRUTH = "python-controller-on-disk" as const;
export const CURRENT_RUNTIME_MAX_OUTPUT_TOKENS = 32_768 as const;
export type RecordedRuntimeMaxOutputTokens = 16_384 | typeof CURRENT_RUNTIME_MAX_OUTPUT_TOKENS;

export interface GoverningRecordBase<TSchemaVersion extends "0.1" | "1.0"> {
  readonly schema_version: TSchemaVersion;
  readonly kind: string;
}

export interface InitialIntentReceipt extends GoverningRecordBase<"1.0"> {
  readonly kind: "InitialIntentReceipt";
  readonly id: StableId;
  readonly created_at: IsoTimestamp;
  readonly source_refs: readonly [];
  readonly system_id: StableId;
  readonly intent: string;
  readonly authority: "direct-user-input";
  readonly user_action: "start-creation";
  readonly content_hash: string;
}

export interface RuntimeProvenance extends GoverningRecordBase<"1.0"> {
  readonly kind: "RuntimeProvenance";
  readonly id: StableId;
  readonly created_at: IsoTimestamp;
  readonly source_refs: readonly [];
  readonly content_hash: string;
  readonly run_id: StableId;
  readonly requested_model: "deepseek-v4-flash" | "deepseek-v4-pro";
  readonly returned_model: string;
  readonly system_fingerprint: string;
  readonly response_id: string;
  readonly parameters: {
    readonly thinking: "enabled";
    readonly reasoning_effort: "high";
    /** Current records use 32768; 16384 remains readable as sealed historical evidence. */
    readonly max_tokens: RecordedRuntimeMaxOutputTokens;
  };
  readonly usage: {
    readonly cache_hit_tokens?: number;
    readonly cache_miss_tokens?: number;
    readonly completion_tokens?: number;
    readonly prompt_tokens?: number;
    readonly total_tokens?: number;
  };
  readonly app_version: string;
  readonly controller_version: string;
  readonly dsh_version: string;
  readonly profile_sha256: string;
  readonly authority: "main-observed-model-gateway";
  readonly reasoning_content_persisted: false;
}

export interface SystemCandidate extends GoverningRecordBase<"0.1"> {
  readonly kind: "LearningProposal";
  readonly id: StableId;
  readonly level: "L4" | "L5";
  readonly status: "CANDIDATE";
  readonly candidate_class: "PROMOTABLE" | "CANDIDATE_ONLY";
  readonly execution_policy: "isolated-evaluation" | "declarative-or-maintainer-review-only";
  readonly created_at: IsoTimestamp;
  readonly builder_receipt: JsonValue;
  readonly producer_execution_boundary: JsonValue;
  readonly finding_cluster: JsonValue;
  readonly root_cause_hypothesis: string;
  readonly target_component: CandidateTargetComponent;
  readonly candidate_change: JsonValue;
  readonly protected_constraints: readonly ProjectRelativePath[];
  readonly evaluation_matrix: JsonValue;
  readonly budget: { readonly max_evaluation_runs: number };
  readonly rollback_plan: {
    readonly previous_version: StableId;
    readonly action: "restore-active-version-pointer-and-retain-all-evidence";
  };
}

export interface EvaluationBundle extends GoverningRecordBase<"1.0"> {
  readonly kind: "EvaluationBundle";
  readonly candidate_id: StableId;
  readonly targeted: JsonValue;
  readonly regression: JsonValue;
  readonly heldout: JsonValue;
  readonly human_approval: JsonValue;
  readonly run_integrity: JsonValue;
}

export interface PromotionRecord extends GoverningRecordBase<"0.1"> {
  readonly kind: "PromotionRecord";
  readonly action: "promote";
  readonly state: "COMMITTED";
  readonly level: "L4";
  readonly candidate_id: StableId;
  readonly previous_version: StableId;
  readonly new_version: StableId;
  readonly promoted_at: IsoTimestamp;
  readonly approved_by: string;
  readonly evaluation_sha256: string;
  readonly evaluation_evidence_hashes: Readonly<Record<ProjectRelativePath, string>>;
  readonly eval_run_seals: JsonValue;
  readonly eval_open_ledger: JsonValue;
  readonly candidate_change_hashes: Readonly<Record<ProjectRelativePath, string>>;
  readonly rollback_to: StableId;
}

export interface RollbackRecord extends GoverningRecordBase<"0.1"> {
  readonly kind: "RollbackRecord";
  readonly action: "rollback";
  readonly state: "COMMITTED";
  readonly rollback_id: StableId;
  readonly candidate_id: StableId;
  readonly previous_active_version: StableId;
  readonly restored_version: StableId;
  readonly reason: string;
  readonly evidence: ProjectRelativePath | null;
  readonly evidence_sha256: string | null;
  readonly rolled_back_at: IsoTimestamp;
  readonly history_retained: true;
}

export type GoverningDocument =
  | InitialIntentReceipt
  | RuntimeProvenance
  | SystemCandidate
  | EvaluationBundle
  | PromotionRecord
  | RollbackRecord;

export interface PythonGovernancePassthrough<TDocument extends GoverningDocument = GoverningDocument> {
  readonly sourceOfTruth: typeof PYTHON_GOVERNANCE_SOURCE_OF_TRUTH;
  readonly document: TDocument;
}

const GOVERNING_KINDS = new Set<GoverningDocument["kind"]>([
  "InitialIntentReceipt",
  "RuntimeProvenance",
  "LearningProposal",
  "EvaluationBundle",
  "PromotionRecord",
  "RollbackRecord",
]);

const GOVERNING_SCHEMA_VERSION_BY_KIND: Readonly<Record<GoverningDocument["kind"], "0.1" | "1.0">> = {
  InitialIntentReceipt: "1.0",
  RuntimeProvenance: "1.0",
  LearningProposal: "0.1",
  EvaluationBundle: "1.0",
  PromotionRecord: "0.1",
  RollbackRecord: "0.1",
};

export function parsePythonGovernanceDocument(value: unknown): GoverningDocument {
  if (!isRecord(value)) {
    throw new TypeError("governance document must be an object");
  }
  if ("schemaVersion" in value) {
    throw new TypeError("camelCase app DTO cannot be used as governing evidence");
  }
  if (typeof value.kind !== "string" || !GOVERNING_KINDS.has(value.kind as GoverningDocument["kind"])) {
    throw new TypeError("unsupported governing document kind");
  }
  const expectedSchemaVersion = GOVERNING_SCHEMA_VERSION_BY_KIND[value.kind as GoverningDocument["kind"]];
  if (value.schema_version !== expectedSchemaVersion) {
    throw new TypeError(`${value.kind}.schema_version must be ${expectedSchemaVersion}`);
  }
  return value as unknown as GoverningDocument;
}

export function passthroughPythonGovernance(value: unknown): PythonGovernancePassthrough {
  return {
    sourceOfTruth: PYTHON_GOVERNANCE_SOURCE_OF_TRUTH,
    document: parsePythonGovernanceDocument(value),
  };
}

export function toCreativeSystemAppViewModel(value: unknown): CreativeSystemAppViewModel {
  if (!isRecord(value) || value.schema_version !== "0.1" || value.kind !== "CreativeSystem") {
    throw new TypeError("expected Python CreativeSystem document");
  }
  const project = requiredRecord(value.project, "project");
  const charter = requiredRecord(value.charter, "charter");
  const maturity = requiredRecord(value.maturity, "maturity");
  const statuses = requiredRecord(value.statuses, "statuses");
  return {
    sourceOfTruth: PYTHON_GOVERNANCE_SOURCE_OF_TRUTH,
    schemaVersion: "0.1",
    kind: "CreativeSystem",
    project: {
      id: requiredString(project.id, "project.id"),
      name: requiredString(project.name, "project.name"),
      domainSkill: requiredString(project.domain_skill, "project.domain_skill"),
      activeVersion: requiredString(project.active_version, "project.active_version"),
    },
    charter: {
      path: requiredString(charter.path, "charter.path"),
      confirmed: charter.confirmed === true,
    },
    maturity: {
      declared: requiredString(maturity.declared, "maturity.declared") as CreativeSystemAppViewModel["maturity"]["declared"],
      evidence: [],
    },
    loops: stringArray(value.loops),
    artifacts: [],
    judges: stringArray(value.judges),
    protectedSurfaces: stringArray(value.protected_surfaces),
    editableSurfaces: stringArray(value.editable_surfaces),
    statuses: {
      execution: requiredString(statuses.execution_status, "statuses.execution_status") as CreativeSystemAppViewModel["statuses"]["execution"],
      quality: requiredString(statuses.quality_status, "statuses.quality_status") as CreativeSystemAppViewModel["statuses"]["quality"],
      release: requiredString(statuses.release_status, "statuses.release_status") as CreativeSystemAppViewModel["statuses"]["release"],
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${field} must be a string`);
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return [];
  return value;
}
