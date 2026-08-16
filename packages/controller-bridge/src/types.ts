export const CONTROLLER_PROTOCOL_VERSION = "1" as const;
export const CONTROLLER_MAX_OUTPUT_TOKENS = 32_768 as const;
export const LEGACY_CONTROLLER_MAX_OUTPUT_TOKENS = 16_384 as const;

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export const CONTROLLER_OPERATIONS = [
  "begin_method_candidate_preparation",
  "begin_method_generation",
  "begin_work",
  "bootstrap_intent",
  "candidate_summary",
  "cancel_work",
  "complete_work",
  "create_method_candidate",
  "create_system_lab_candidate",
  "adopt_method_candidate",
  "method_candidate_context",
  "production_context",
  "record_feedback",
  "record_method_generation",
  "record_method_generation_failure",
  "record_method_builder_failure",
  "reject_method_candidate",
  "resume_feedback",
  "rollback_method",
  "seal_feedback",
  "stage_method_comparisons",
  "submit_method_comparison",
  "submit_feedback",
  "system_snapshot",
  "terminate_work",
] as const;

export type ControllerOperation = (typeof CONTROLLER_OPERATIONS)[number];

export interface BootstrapIntentPayload {
  readonly project: string;
  readonly system_id: string;
  readonly display_name: string;
  readonly intent: string;
  readonly domain_skill?: string;
}

export interface BeginWorkPayload {
  readonly project: string;
  readonly work_id: string;
  readonly task: string;
  readonly loop?: string;
  readonly run_id?: string;
  readonly recovery_of?: string;
  readonly dispatch_id?: string;
  readonly context_id?: string;
  readonly context_sha256: string;
}

export interface CancelWorkPayload {
  readonly project: string;
  readonly run_id: string;
  readonly dispatch_id: string;
  readonly reason: string;
  readonly runtime_provenance?: CompleteWorkRuntimeProvenance;
}

export interface TerminateWorkPayload {
  readonly project: string;
  readonly run_id: string;
  readonly dispatch_id: string;
  readonly outcome: "CANCELLED" | "FAILED";
  readonly reason: string;
  readonly error_code?: string;
  readonly runtime_provenance?: TerminationRuntimeProvenance;
}

export interface RuntimeProvenanceParameters {
  readonly thinking: "enabled";
  readonly reasoning_effort: "high";
  readonly max_tokens: typeof CONTROLLER_MAX_OUTPUT_TOKENS;
}

export interface TerminationRuntimeProvenanceParameters {
  readonly thinking: "enabled";
  readonly reasoning_effort: "high";
  /**
   * 16384 is a terminate_work-only protocol compatibility value. Trusted Main
   * uses it only to replay an older TERMINATION_REQUIRED pending-work intent.
   */
  readonly max_tokens:
    | typeof CONTROLLER_MAX_OUTPUT_TOKENS
    | typeof LEGACY_CONTROLLER_MAX_OUTPUT_TOKENS;
}

export interface RuntimeProvenanceUsage {
  readonly cache_hit_tokens?: number;
  readonly cache_miss_tokens?: number;
  readonly completion_tokens?: number;
  readonly prompt_tokens?: number;
  readonly total_tokens?: number;
}

export interface CompleteWorkRuntimeProvenance {
  readonly app_version: string;
  readonly completed_at: string | null;
  readonly controller_version: string;
  readonly context_sha256: string;
  readonly dsh_version: string;
  readonly completed_requests: number;
  readonly failed_requests: number;
  readonly parameters: RuntimeProvenanceParameters;
  readonly profile_sha256: string;
  readonly request_count: number;
  readonly requests: readonly RuntimeRequestProvenance[];
  readonly requested_model: "deepseek-v4-flash" | "deepseek-v4-pro";
  readonly response_id: string | null;
  readonly returned_model: string | null;
  readonly system_fingerprint: string | null;
  readonly usage: RuntimeProvenanceUsage;
}

export type TerminationRuntimeProvenance = Omit<
  CompleteWorkRuntimeProvenance,
  "parameters"
> & {
  readonly parameters: TerminationRuntimeProvenanceParameters;
};

export interface RuntimeRequestProvenance {
  readonly request_number: number;
  readonly started_at: string;
  readonly completed_at: string | null;
  readonly status: "STARTED" | "COMPLETED" | "FAILED";
  readonly http_status: number | null;
  readonly error_code: string | null;
  readonly response_id: string | null;
  readonly returned_model: string | null;
  readonly system_fingerprint: string | null;
  readonly usage: RuntimeProvenanceUsage;
}

export interface CompleteWorkPayload {
  readonly project: string;
  readonly run_id: string;
  readonly dispatch_id?: string;
  readonly output: string;
  readonly runtime_provenance: CompleteWorkRuntimeProvenance;
}

export interface SystemSnapshotPayload {
  readonly project: string;
}

export interface ProductionContextPayload {
  readonly project: string;
}

export interface MethodCandidateContextPayload {
  readonly project: string;
  readonly candidate_id: string;
  readonly observation_id: string;
}

export interface BeginMethodCandidatePreparationPayload {
  readonly project: string;
  readonly candidate_id: string;
  readonly observation_id: string;
  readonly builder_context_sha256: string;
  readonly expected_epoch_sha256: string;
}

export interface CreateMethodCandidatePayload {
  readonly project: string;
  readonly candidate_id: string;
  readonly observation_id: string;
  readonly guidance: string;
  readonly builder_role_id: string;
  readonly builder_context_id: string;
  readonly builder_task_id: string;
  readonly builder_attested_by: string;
  readonly builder_provenance: CompleteWorkRuntimeProvenance;
}

export interface MethodGeneration {
  readonly output: string;
  readonly runtime_provenance: CompleteWorkRuntimeProvenance;
}

export type MethodGenerationLabel =
  | "targeted_candidate"
  | "regression_candidate"
  | "heldout_baseline"
  | "heldout_candidate";

export type MethodPreparationDurableFailureKind =
  | "ACCOUNT_BALANCE"
  | "CREDENTIAL_REJECTED"
  | "DEEPSEEK_FIRST_EVENT_TIMEOUT"
  | "DEEPSEEK_STREAM_IDLE_TIMEOUT"
  | "DEEPSEEK_TIMEOUT"
  | "DEEPSEEK_TOTAL_TIMEOUT"
  | "DEEPSEEK_UNAVAILABLE"
  | "EMPTY_OUTPUT"
  | "METHOD_EPOCH_CHANGED"
  | "METHOD_EPOCH_UNVERIFIABLE"
  | "OUTPUT_TRUNCATED"
  | "RATE_LIMITED"
  | "RUNTIME_FAILED";

export interface RecordMethodGenerationPayload {
  readonly project: string;
  readonly candidate_id: string;
  readonly label: MethodGenerationLabel;
  readonly generation: MethodGeneration;
}

export interface BeginMethodGenerationPayload {
  readonly project: string;
  readonly candidate_id: string;
  readonly label: MethodGenerationLabel;
  readonly context_sha256: string;
  readonly expected_epoch_sha256: string;
}

export interface RecordMethodGenerationFailurePayload {
  readonly project: string;
  readonly candidate_id: string;
  readonly label: MethodGenerationLabel;
  readonly context_sha256: string;
  readonly expected_epoch_sha256: string;
  readonly observed_evidence_sha256: string;
  readonly observed_epoch_sha256?: string;
  readonly error_code: MethodPreparationDurableFailureKind;
  readonly failure_kind: MethodPreparationDurableFailureKind;
}

export interface RecordMethodBuilderFailurePayload {
  readonly project: string;
  readonly candidate_id: string;
  readonly observation_id: string;
  readonly builder_context_sha256: string;
  readonly expected_epoch_sha256: string;
  readonly observed_evidence_sha256: string;
  readonly observed_epoch_sha256?: string;
  readonly error_code: MethodPreparationDurableFailureKind;
  readonly failure_kind: MethodPreparationDurableFailureKind;
}

export interface StageMethodComparisonsPayload {
  readonly project: string;
  readonly candidate_id: string;
  /** Legacy all-at-once callers may still submit this; Main seals slots one by one. */
  readonly generations?: {
    readonly targeted_candidate: MethodGeneration;
    readonly regression_candidate: MethodGeneration;
    readonly heldout_baseline: MethodGeneration;
    readonly heldout_candidate: MethodGeneration;
  };
}

export interface SubmitMethodComparisonPayload {
  readonly project: string;
  readonly candidate_id: string;
  readonly phase: "targeted" | "regression" | "heldout";
  readonly choice: "A" | "B" | "TIE";
}

export interface MethodCandidateDecisionPayload {
  readonly project: string;
  readonly candidate_id: string;
}

export interface RollbackMethodPayload {
  readonly project: string;
  readonly to_version: string;
}

export interface RecordFeedbackPayload {
  readonly project: string;
  readonly run_id: string;
  readonly event_id: string;
  readonly action: "edit" | "keep" | "reject" | "rewrite";
  readonly feedback_at: string;
  readonly feedback_text?: string;
  readonly edited_text?: string;
}

export interface SealFeedbackPayload {
  readonly project: string;
  readonly feedback_receipt: string;
  readonly dispatch_id?: string;
  readonly execution_status?: "BLOCK" | "PASS";
  readonly quality_status?: "NEEDS_TASTE" | "NOT_EVALUATED" | "PASS" | "WARN";
  readonly release_status?: "BLOCK" | "CANDIDATE" | "NOT_READY" | "PASS";
  readonly decision?: "commit" | "escalate" | "revise" | "stop";
  readonly finding_paths?: readonly string[];
  readonly evidence_paths?: readonly string[];
  readonly machine_direction?: "BLOCK" | "PASS" | "UNKNOWN";
  readonly improved?: "false" | "true" | "unknown";
  readonly stop_reason?: string;
  readonly hard_contract_false_pass?: boolean;
  readonly recovery_exercised?: boolean;
  readonly local_recovery_preserved_upstream?: boolean;
  readonly end_to_end_no_regression?: boolean;
  readonly resolved_observed_problem?: boolean;
}

export interface SubmitFeedbackPayload {
  readonly project: string;
  readonly run_id: string;
  readonly action: "edit" | "keep" | "reject" | "rewrite";
  readonly feedback_at: string;
  readonly feedback_text?: string;
  readonly edited_text?: string;
  readonly machine_direction: "BLOCK" | "PASS" | "UNKNOWN";
}

export interface ResumeFeedbackPayload {
  readonly project: string;
  readonly run_id: string;
}

export type SystemLabTarget =
  | "app-scaffold"
  | "controller"
  | "improvement-controller"
  | "judge"
  | "learning-policy"
  | "model-gateway"
  | "runtime-profile";

export interface CreateSystemLabCandidatePayload {
  readonly project: string;
  readonly candidate_id: string;
  readonly finding_code: string;
  readonly root_cause: string;
  readonly target_component: SystemLabTarget;
  readonly change_summary: string;
  readonly changed_paths: readonly string[];
  readonly evaluation_plan?: string;
  readonly budget?: number;
  readonly builder_role_id: string;
  readonly builder_context_id: string;
  readonly builder_task_id: string;
  readonly builder_attested_by: string;
}

export interface CandidateSummaryPayload {
  readonly project: string;
  readonly candidate_id: string;
}

interface ControllerRequestBase<
  TOperation extends ControllerOperation,
  TPayload extends object,
> {
  readonly request_id: string;
  readonly operation: TOperation;
  readonly payload: TPayload;
}

export type ControllerRequest =
  | ControllerRequestBase<"begin_method_candidate_preparation", BeginMethodCandidatePreparationPayload>
  | ControllerRequestBase<"begin_method_generation", BeginMethodGenerationPayload>
  | ControllerRequestBase<"begin_work", BeginWorkPayload>
  | ControllerRequestBase<"bootstrap_intent", BootstrapIntentPayload>
  | ControllerRequestBase<"candidate_summary", CandidateSummaryPayload>
  | ControllerRequestBase<"cancel_work", CancelWorkPayload>
  | ControllerRequestBase<"complete_work", CompleteWorkPayload>
  | ControllerRequestBase<"create_method_candidate", CreateMethodCandidatePayload>
  | ControllerRequestBase<"create_system_lab_candidate", CreateSystemLabCandidatePayload>
  | ControllerRequestBase<"adopt_method_candidate", MethodCandidateDecisionPayload>
  | ControllerRequestBase<"method_candidate_context", MethodCandidateContextPayload>
  | ControllerRequestBase<"production_context", ProductionContextPayload>
  | ControllerRequestBase<"record_feedback", RecordFeedbackPayload>
  | ControllerRequestBase<"record_method_generation", RecordMethodGenerationPayload>
  | ControllerRequestBase<"record_method_generation_failure", RecordMethodGenerationFailurePayload>
  | ControllerRequestBase<"record_method_builder_failure", RecordMethodBuilderFailurePayload>
  | ControllerRequestBase<"reject_method_candidate", MethodCandidateDecisionPayload>
  | ControllerRequestBase<"resume_feedback", ResumeFeedbackPayload>
  | ControllerRequestBase<"rollback_method", RollbackMethodPayload>
  | ControllerRequestBase<"seal_feedback", SealFeedbackPayload>
  | ControllerRequestBase<"stage_method_comparisons", StageMethodComparisonsPayload>
  | ControllerRequestBase<"submit_method_comparison", SubmitMethodComparisonPayload>
  | ControllerRequestBase<"submit_feedback", SubmitFeedbackPayload>
  | ControllerRequestBase<"system_snapshot", SystemSnapshotPayload>
  | ControllerRequestBase<"terminate_work", TerminateWorkPayload>;

export type ControllerWireRequest = ControllerRequest & {
  readonly protocol_version: typeof CONTROLLER_PROTOCOL_VERSION;
};

export type ControllerStatus = "BLOCK" | "CANDIDATE" | "NEEDS_TASTE" | "PASS" | "WARN";

export interface ControllerErrorPayload extends JsonObject {
  readonly code: string;
  readonly message: string;
}

export interface ControllerResponse extends JsonObject {
  readonly protocol_version: typeof CONTROLLER_PROTOCOL_VERSION;
  readonly request_id: string | null;
  readonly operation: ControllerOperation | null;
  readonly status: ControllerStatus;
  readonly error?: ControllerErrorPayload;
}

export interface ControllerInvocation<T extends ControllerResponse = ControllerResponse> {
  readonly exitCode: number;
  readonly payload: T;
}

export interface ControllerExecutable {
  /** Trusted absolute path to the bundled sidecar or a development interpreter. */
  readonly file: string;
  /** Trusted fixed argv, e.g. ["-m", "creative_loop2rsi"] during development. */
  readonly fixedArguments?: readonly string[];
  /** Trusted working directory; never populate this from Renderer input. */
  readonly cwd?: string;
}

export interface ControllerBridgeOptions {
  readonly maxOutputBytes?: number;
  readonly maxRequestBytes?: number;
  readonly timeoutMs?: number;
}

export interface ControllerInvokeOptions {
  readonly signal?: AbortSignal;
}

export type ControllerBridgeErrorCode =
  | "CONTROLLER_ABORTED"
  | "CONTROLLER_NOT_FOUND"
  | "CONTROLLER_OUTPUT_LIMIT"
  | "CONTROLLER_PROCESS_ERROR"
  | "CONTROLLER_PROTOCOL_ERROR"
  | "CONTROLLER_REQUEST_LIMIT"
  | "CONTROLLER_TIMEOUT"
  | "INVALID_CONTROLLER_REQUEST";

export class ControllerBridgeError extends Error {
  readonly code: ControllerBridgeErrorCode;
  readonly exitCode: number | null;

  constructor(code: ControllerBridgeErrorCode, message: string, exitCode: number | null = null) {
    super(message);
    this.name = "ControllerBridgeError";
    this.code = code;
    this.exitCode = exitCode;
  }
}
