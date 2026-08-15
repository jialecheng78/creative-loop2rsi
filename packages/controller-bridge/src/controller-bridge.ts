import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

import {
  CONTROLLER_OPERATIONS,
  CONTROLLER_PROTOCOL_VERSION,
  ControllerBridgeError,
  type ControllerBridgeOptions,
  type ControllerExecutable,
  type ControllerInvocation,
  type ControllerInvokeOptions,
  type ControllerOperation,
  type ControllerRequest,
  type ControllerResponse,
  type ControllerWireRequest,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const MAX_TIMEOUT_MS = 900_000;
const MAX_FIXED_ARGUMENT_BYTES = 65_536;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CREDENTIAL_FIELD = /^(?:api[-_]?key|apikey|authorization|bearer|credentials?|key|password|secret|token)$|(?:[-_]api[-_]key|[-_]access[-_]token)$/i;
const OPERATIONS = new Set<ControllerOperation>(CONTROLLER_OPERATIONS);
const RESPONSE_STATUSES = new Set(["BLOCK", "CANDIDATE", "NEEDS_TASTE", "PASS", "WARN"]);

type UnknownRecord = Record<string, unknown>;

function requestError(message: string): never {
  throw new ControllerBridgeError("INVALID_CONTROLLER_REQUEST", message);
}

function asRecord(value: unknown, field: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    requestError(`${field} 必须是普通对象`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    requestError(`${field} 必须是普通对象`);
  }
  return value as UnknownRecord;
}

function exactKeys(record: UnknownRecord, field: string, keys: readonly string[]): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) requestError(`${field}.${key} 不是允许字段`);
  }
}

function requiredText(
  record: UnknownRecord,
  key: string,
  maximum: number,
  options: { multiline?: boolean; measureBytes?: boolean } = {},
): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    requestError(`${key} 必须是非空字符串`);
  }
  const measuredLength = options.measureBytes === true
    ? Buffer.byteLength(value, "utf8")
    : value.length;
  if (measuredLength > maximum) {
    requestError(`${key} 超过 ${maximum} ${options.measureBytes === true ? "UTF-8 字节" : "字符"}`);
  }
  if (value.includes("\0")) requestError(`${key} 不得包含 NUL`);
  if (options.multiline !== true && /[\r\n]/.test(value)) requestError(`${key} 必须是单行文本`);
  return value;
}

function optionalText(
  record: UnknownRecord,
  key: string,
  maximum: number,
  options: { multiline?: boolean } = {},
): string | undefined {
  return record[key] === undefined ? undefined : requiredText(record, key, maximum, options);
}

function requiredId(record: UnknownRecord, key: string): string {
  const value = requiredText(record, key, 120);
  if (!ID_PATTERN.test(value)) requestError(`${key} 必须是 lower-kebab-case`);
  return value;
}

function optionalId(record: UnknownRecord, key: string): string | undefined {
  return record[key] === undefined ? undefined : requiredId(record, key);
}

function projectPath(record: UnknownRecord): string {
  const value = requiredText(record, "project", 32_768);
  if (!isAbsolute(value)) requestError("project 必须是绝对路径");
  return value;
}

function optionalBoolean(record: UnknownRecord, key: string): void {
  if (record[key] !== undefined && typeof record[key] !== "boolean") {
    requestError(`${key} 必须是 boolean`);
  }
}

function optionalEnum(record: UnknownRecord, key: string, allowed: readonly string[]): void {
  if (record[key] === undefined) return;
  const value = requiredText(record, key, 120);
  if (!allowed.includes(value)) requestError(`${key} 不是允许值`);
}

function requiredEnum(record: UnknownRecord, key: string, allowed: readonly string[]): void {
  const value = requiredText(record, key, 120);
  if (!allowed.includes(value)) requestError(`${key} 不是允许值`);
}

function optionalStringArray(record: UnknownRecord, key: string, required = false): void {
  const value = record[key];
  if (value === undefined) {
    if (required) requestError(`${key} 必须是非空数组`);
    return;
  }
  if (!Array.isArray(value) || (required && value.length === 0)) {
    requestError(`${key} 必须是${required ? "非空" : ""}数组`);
  }
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.length === 0 || item.includes("\0")) {
      requestError(`${key}[${index}] 必须是非空字符串`);
    }
  }
}

function optionalPositiveInteger(record: UnknownRecord, key: string): void {
  const value = record[key];
  if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 1)) {
    requestError(`${key} 必须是正安全整数`);
  }
}

function optionalNonNegativeInteger(record: UnknownRecord, key: string): void {
  const value = record[key];
  if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) {
    requestError(`${key} 必须是非负安全整数`);
  }
}

function validateRuntimeProvenance(rawValue: unknown, requireCompleted: boolean): void {
  const provenance = asRecord(rawValue, "runtime_provenance");
  exactKeys(provenance, "runtime_provenance", [
    "app_version",
    "completed_at",
    "completed_requests",
    "controller_version",
    "context_sha256",
    "dsh_version",
    "failed_requests",
    "parameters",
    "profile_sha256",
    "request_count",
    "requests",
    "requested_model",
    "response_id",
    "returned_model",
    "system_fingerprint",
    "usage",
  ]);
  requiredText(provenance, "app_version", 80);
  const completedAt = nullableText(provenance, "completed_at", 80);
  if (requireCompleted && completedAt === null) requestError("成功 runtime_provenance 缺少 completed_at");
  requiredText(provenance, "controller_version", 80);
  requiredText(provenance, "dsh_version", 80);
  requiredEnum(provenance, "requested_model", ["deepseek-v4-pro", "deepseek-v4-flash"]);
  const returnedModel = nullableText(provenance, "returned_model", 160);
  const fingerprint = nullableText(provenance, "system_fingerprint", 300);
  const responseId = nullableText(provenance, "response_id", 300);
  if (requireCompleted && (returnedModel === null || fingerprint === null || responseId === null)) {
    requestError("成功 runtime_provenance 缺少模型来源");
  }
  const profileSha256 = requiredText(provenance, "profile_sha256", 64);
  if (!/^[0-9a-f]{64}$/.test(profileSha256)) {
    requestError("runtime_provenance.profile_sha256 必须是 64 位小写 SHA256");
  }
  const contextSha256 = requiredText(provenance, "context_sha256", 64);
  if (!/^[0-9a-f]{64}$/.test(contextSha256)) {
    requestError("runtime_provenance.context_sha256 必须是 64 位小写 SHA256");
  }

  const parameters = asRecord(provenance.parameters, "runtime_provenance.parameters");
  exactKeys(parameters, "runtime_provenance.parameters", [
    "thinking",
    "reasoning_effort",
    "max_tokens",
  ]);
  if (
    parameters.thinking !== "enabled" ||
    parameters.reasoning_effort !== "high" ||
    parameters.max_tokens !== 16_384
  ) {
    requestError("runtime_provenance.parameters 与固定模型策略不一致");
  }

  const usageFields = [
    "cache_hit_tokens",
    "cache_miss_tokens",
    "completion_tokens",
    "prompt_tokens",
    "total_tokens",
  ] as const;
  validateUsage(provenance.usage, "runtime_provenance.usage", usageFields);

  if (!Array.isArray(provenance.requests)) requestError("runtime_provenance.requests 必须是数组");
  let completedRequests = 0;
  let failedRequests = 0;
  let lastCompleted: UnknownRecord | undefined;
  for (const [index, rawRequest] of provenance.requests.entries()) {
    const request = asRecord(rawRequest, `runtime_provenance.requests[${index}]`);
    exactKeys(request, `runtime_provenance.requests[${index}]`, [
      "request_number",
      "started_at",
      "completed_at",
      "status",
      "http_status",
      "error_code",
      "response_id",
      "returned_model",
      "system_fingerprint",
      "usage",
    ]);
    if (request.request_number !== index + 1) requestError("runtime request_number 必须连续递增");
    requiredText(request, "started_at", 80);
    const requestCompletedAt = nullableText(request, "completed_at", 80);
    requiredEnum(request, "status", ["STARTED", "COMPLETED", "FAILED"]);
    const httpStatus = request.http_status;
    if (httpStatus !== null
      && (!Number.isSafeInteger(httpStatus) || (httpStatus as number) < 100 || (httpStatus as number) > 599)) {
      requestError("runtime request http_status 无效");
    }
    const errorCode = nullableText(request, "error_code", 160);
    const requestResponseId = nullableText(request, "response_id", 300);
    const requestModel = nullableText(request, "returned_model", 160);
    const requestFingerprint = nullableText(request, "system_fingerprint", 300);
    validateUsage(request.usage, `runtime_provenance.requests[${index}].usage`, usageFields);
    if (request.status === "COMPLETED") {
      completedRequests += 1;
      lastCompleted = request;
      if (requestCompletedAt === null
        || errorCode !== null
        || requestResponseId === null
        || requestModel === null
        || requestFingerprint === null) {
        requestError("COMPLETED runtime request 缺少成功来源或含 error");
      }
    } else if (request.status === "FAILED") {
      failedRequests += 1;
      if (requestCompletedAt === null || errorCode === null) {
        requestError("FAILED runtime request 缺少 completed_at 或 error_code");
      }
    } else if (requestCompletedAt !== null) {
      requestError("STARTED runtime request 不得含 completed_at");
    }
  }
  const requestCount = requiredNonNegativeInteger(provenance, "request_count");
  const declaredCompleted = requiredNonNegativeInteger(provenance, "completed_requests");
  const declaredFailed = requiredNonNegativeInteger(provenance, "failed_requests");
  if (requestCount !== provenance.requests.length
    || declaredCompleted !== completedRequests
    || declaredFailed !== failedRequests) {
    requestError("runtime provenance aggregate 与 requests ledger 不一致");
  }
  if (requireCompleted && completedRequests < 1) requestError("成功作品缺少 COMPLETED runtime request");
  if (requireCompleted && lastCompleted !== undefined
    && (lastCompleted.response_id !== responseId
      || lastCompleted.returned_model !== returnedModel
      || lastCompleted.system_fingerprint !== fingerprint)) {
    requestError("runtime provenance 顶层来源与最后 COMPLETED request 不一致");
  }
}

function nullableText(record: UnknownRecord, key: string, maximum: number): string | null {
  if (record[key] === null) return null;
  return requiredText(record, key, maximum);
}

function requiredNonNegativeInteger(record: UnknownRecord, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) requestError(`${key} 必须是非负安全整数`);
  return value as number;
}

function validateUsage(
  rawValue: unknown,
  field: string,
  allowed: readonly string[],
): void {
  const usage = asRecord(rawValue, field);
  exactKeys(usage, field, allowed);
  for (const key of allowed) optionalNonNegativeInteger(usage, key);
}

function assertNoCredentialFields(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) requestError("请求不得包含循环对象");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertNoCredentialFields(item, seen);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_FIELD.test(key)) requestError("Controller 请求不得包含凭证字段");
    assertNoCredentialFields(child, seen);
  }
}

function validateMethodGeneration(rawValue: unknown, field: string): void {
  const generation = asRecord(rawValue, field);
  exactKeys(generation, field, ["output", "runtime_provenance"]);
  requiredText(generation, "output", 500_000, { multiline: true });
  validateRuntimeProvenance(generation.runtime_provenance, true);
}

function validatePayload(operation: ControllerOperation, rawPayload: unknown): void {
  const payload = asRecord(rawPayload, "payload");
  switch (operation) {
    case "bootstrap_intent":
      exactKeys(payload, "payload", ["project", "system_id", "display_name", "intent", "domain_skill"]);
      projectPath(payload);
      requiredId(payload, "system_id");
      requiredText(payload, "display_name", 120);
      requiredText(payload, "intent", 100_000, { multiline: true, measureBytes: true });
      optionalId(payload, "domain_skill");
      return;
    case "begin_work":
      exactKeys(payload, "payload", [
        "project",
        "work_id",
        "task",
        "loop",
        "run_id",
        "recovery_of",
        "dispatch_id",
        "context_id",
        "context_sha256",
      ]);
      projectPath(payload);
      requiredId(payload, "work_id");
      requiredText(payload, "task", 100_000, { multiline: true, measureBytes: true });
      optionalId(payload, "loop");
      optionalId(payload, "run_id");
      optionalId(payload, "recovery_of");
      optionalId(payload, "dispatch_id");
      optionalText(payload, "context_id", 200);
      const contextSha256 = requiredText(payload, "context_sha256", 64);
      if (!/^[0-9a-f]{64}$/.test(contextSha256)) requestError("context_sha256 必须是 SHA256");
      return;
    case "cancel_work":
      exactKeys(payload, "payload", ["project", "run_id", "dispatch_id", "reason", "runtime_provenance"]);
      projectPath(payload);
      requiredId(payload, "run_id");
      requiredId(payload, "dispatch_id");
      requiredText(payload, "reason", 500);
      if (payload.runtime_provenance !== undefined) validateRuntimeProvenance(payload.runtime_provenance, false);
      return;
    case "complete_work":
      exactKeys(payload, "payload", ["project", "run_id", "dispatch_id", "output", "runtime_provenance"]);
      projectPath(payload);
      requiredId(payload, "run_id");
      optionalId(payload, "dispatch_id");
      requiredText(payload, "output", 500_000, { multiline: true });
      validateRuntimeProvenance(payload.runtime_provenance, true);
      return;
    case "production_context":
    case "system_snapshot":
      exactKeys(payload, "payload", ["project"]);
      projectPath(payload);
      return;
    case "method_candidate_context":
      exactKeys(payload, "payload", ["project", "candidate_id", "observation_id"]);
      projectPath(payload);
      requiredId(payload, "candidate_id");
      requiredText(payload, "observation_id", 100);
      return;
    case "create_method_candidate":
      exactKeys(payload, "payload", [
        "project",
        "candidate_id",
        "observation_id",
        "guidance",
        "builder_role_id",
        "builder_context_id",
        "builder_task_id",
        "builder_attested_by",
        "builder_provenance",
      ]);
      projectPath(payload);
      requiredId(payload, "candidate_id");
      requiredText(payload, "observation_id", 100);
      requiredText(payload, "guidance", 2_000, { multiline: true });
      requiredId(payload, "builder_role_id");
      requiredText(payload, "builder_context_id", 300);
      requiredText(payload, "builder_task_id", 300);
      requiredText(payload, "builder_attested_by", 300);
      validateRuntimeProvenance(payload.builder_provenance, true);
      return;
    case "stage_method_comparisons": {
      exactKeys(payload, "payload", ["project", "candidate_id", "generations"]);
      projectPath(payload);
      requiredId(payload, "candidate_id");
      const generations = asRecord(payload.generations, "generations");
      exactKeys(generations, "generations", [
        "targeted_candidate",
        "regression_candidate",
        "heldout_baseline",
        "heldout_candidate",
      ]);
      for (const key of [
        "targeted_candidate",
        "regression_candidate",
        "heldout_baseline",
        "heldout_candidate",
      ] as const) validateMethodGeneration(generations[key], `generations.${key}`);
      return;
    }
    case "submit_method_comparison":
      exactKeys(payload, "payload", ["project", "candidate_id", "phase", "choice"]);
      projectPath(payload);
      requiredId(payload, "candidate_id");
      requiredEnum(payload, "phase", ["targeted", "regression", "heldout"]);
      requiredEnum(payload, "choice", ["A", "B", "TIE"]);
      return;
    case "adopt_method_candidate":
    case "reject_method_candidate":
      exactKeys(payload, "payload", ["project", "candidate_id"]);
      projectPath(payload);
      requiredId(payload, "candidate_id");
      return;
    case "rollback_method":
      exactKeys(payload, "payload", ["project", "to_version"]);
      projectPath(payload);
      requiredId(payload, "to_version");
      return;
    case "record_feedback": {
      exactKeys(payload, "payload", [
        "project",
        "run_id",
        "event_id",
        "action",
        "feedback_at",
        "feedback_text",
        "edited_text",
      ]);
      projectPath(payload);
      requiredId(payload, "run_id");
      requiredId(payload, "event_id");
      requiredEnum(payload, "action", ["keep", "reject", "rewrite", "edit"]);
      requiredText(payload, "feedback_at", 80);
      optionalText(payload, "feedback_text", 20_000, { multiline: true });
      optionalText(payload, "edited_text", 500_000, { multiline: true });
      if (payload.action === "edit" && payload.edited_text === undefined) {
        requestError("edit 必须提供 edited_text");
      }
      if (payload.action !== "edit" && payload.edited_text !== undefined) {
        requestError("只有 edit 可以提供 edited_text");
      }
      if ((payload.action === "reject" || payload.action === "rewrite") && payload.feedback_text === undefined) {
        requestError(`${String(payload.action)} 必须提供 feedback_text`);
      }
      return;
    }
    case "submit_feedback": {
      exactKeys(payload, "payload", [
        "project",
        "run_id",
        "action",
        "feedback_at",
        "feedback_text",
        "edited_text",
        "machine_direction",
      ]);
      projectPath(payload);
      requiredId(payload, "run_id");
      requiredEnum(payload, "action", ["keep", "reject", "rewrite", "edit"]);
      requiredText(payload, "feedback_at", 80);
      optionalText(payload, "feedback_text", 20_000, { multiline: true });
      optionalText(payload, "edited_text", 500_000, { multiline: true });
      requiredEnum(payload, "machine_direction", ["PASS", "BLOCK", "UNKNOWN"]);
      if (payload.action === "edit" && payload.edited_text === undefined) requestError("edit 必须提供 edited_text");
      if (payload.action !== "edit" && payload.edited_text !== undefined) requestError("只有 edit 可以提供 edited_text");
      if ((payload.action === "reject" || payload.action === "rewrite")
        && payload.feedback_text === undefined) requestError(`${String(payload.action)} 必须提供 feedback_text`);
      return;
    }
    case "resume_feedback":
      exactKeys(payload, "payload", ["project", "run_id"]);
      projectPath(payload);
      requiredId(payload, "run_id");
      return;
    case "seal_feedback":
      exactKeys(payload, "payload", [
        "project",
        "feedback_receipt",
        "dispatch_id",
        "execution_status",
        "quality_status",
        "release_status",
        "decision",
        "finding_paths",
        "evidence_paths",
        "machine_direction",
        "improved",
        "stop_reason",
        "hard_contract_false_pass",
        "recovery_exercised",
        "local_recovery_preserved_upstream",
        "end_to_end_no_regression",
        "resolved_observed_problem",
      ]);
      projectPath(payload);
      requiredText(payload, "feedback_receipt", 4_096);
      optionalId(payload, "dispatch_id");
      optionalEnum(payload, "execution_status", ["PASS", "BLOCK"]);
      optionalEnum(payload, "quality_status", ["NOT_EVALUATED", "PASS", "WARN", "NEEDS_TASTE"]);
      optionalEnum(payload, "release_status", ["NOT_READY", "CANDIDATE", "PASS", "BLOCK"]);
      optionalEnum(payload, "decision", ["commit", "revise", "stop", "escalate"]);
      optionalStringArray(payload, "finding_paths");
      optionalStringArray(payload, "evidence_paths");
      optionalEnum(payload, "machine_direction", ["PASS", "BLOCK", "UNKNOWN"]);
      optionalEnum(payload, "improved", ["true", "false", "unknown"]);
      optionalText(payload, "stop_reason", 1_000, { multiline: true });
      for (const key of [
        "hard_contract_false_pass",
        "recovery_exercised",
        "local_recovery_preserved_upstream",
        "end_to_end_no_regression",
        "resolved_observed_problem",
      ]) optionalBoolean(payload, key);
      return;
    case "create_system_lab_candidate":
      exactKeys(payload, "payload", [
        "project",
        "candidate_id",
        "finding_code",
        "root_cause",
        "target_component",
        "change_summary",
        "changed_paths",
        "evaluation_plan",
        "budget",
        "builder_role_id",
        "builder_context_id",
        "builder_task_id",
        "builder_attested_by",
      ]);
      projectPath(payload);
      requiredId(payload, "candidate_id");
      requiredText(payload, "finding_code", 80);
      requiredText(payload, "root_cause", 1_000, { multiline: true });
      requiredEnum(payload, "target_component", [
        "app-scaffold",
        "controller",
        "improvement-controller",
        "judge",
        "learning-policy",
        "model-gateway",
        "runtime-profile",
      ]);
      requiredText(payload, "change_summary", 2_000, { multiline: true });
      optionalStringArray(payload, "changed_paths", true);
      optionalText(payload, "evaluation_plan", 4_096, { multiline: true });
      optionalPositiveInteger(payload, "budget");
      requiredId(payload, "builder_role_id");
      requiredText(payload, "builder_context_id", 300);
      requiredText(payload, "builder_task_id", 300);
      requiredText(payload, "builder_attested_by", 300);
      return;
    case "candidate_summary":
      exactKeys(payload, "payload", ["project", "candidate_id"]);
      projectPath(payload);
      requiredId(payload, "candidate_id");
      return;
  }
}

/** Validate and construct the exact JSON object accepted by the Python app service. */
export function buildControllerWireRequest(request: ControllerRequest): ControllerWireRequest {
  assertNoCredentialFields(request);
  const envelope = asRecord(request, "request");
  exactKeys(envelope, "request", ["request_id", "operation", "payload"]);
  const requestId = requiredId(envelope, "request_id");
  const operation = requiredText(envelope, "operation", 80) as ControllerOperation;
  if (!OPERATIONS.has(operation)) requestError("operation 不在允许列表");
  validatePayload(operation, envelope.payload);

  try {
    const payload = JSON.parse(JSON.stringify(envelope.payload)) as ControllerRequest["payload"];
    return {
      protocol_version: CONTROLLER_PROTOCOL_VERSION,
      request_id: requestId,
      operation,
      payload,
    } as ControllerWireRequest;
  } catch {
    return requestError("payload 必须是可序列化 JSON");
  }
}

function safeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };
  for (const key of [
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "TZ",
    "WINDIR",
  ]) {
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function parseResponse(
  stdout: Buffer,
  exitCode: number,
  request: ControllerWireRequest,
): ControllerResponse {
  const text = stdout.toString("utf8").trim();
  if (text.length === 0) {
    throw new ControllerBridgeError("CONTROLLER_PROTOCOL_ERROR", "Controller 未返回 JSON 对象", exitCode);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ControllerBridgeError(
      "CONTROLLER_PROTOCOL_ERROR",
      "Controller stdout 不是唯一、完整的 JSON 值",
      exitCode,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ControllerBridgeError(
      "CONTROLLER_PROTOCOL_ERROR",
      "Controller stdout 顶层必须是 JSON 对象",
      exitCode,
    );
  }
  const response = parsed as Record<string, unknown>;
  if (
    response.protocol_version !== CONTROLLER_PROTOCOL_VERSION ||
    response.request_id !== request.request_id ||
    response.operation !== request.operation ||
    typeof response.status !== "string" ||
    !RESPONSE_STATUSES.has(response.status)
  ) {
    throw new ControllerBridgeError(
      "CONTROLLER_PROTOCOL_ERROR",
      "Controller response envelope 与请求不匹配",
      exitCode,
    );
  }
  if ((exitCode === 0) === (response.status === "BLOCK")) {
    throw new ControllerBridgeError(
      "CONTROLLER_PROTOCOL_ERROR",
      "Controller exit code 与 status 不一致",
      exitCode,
    );
  }
  return parsed as ControllerResponse;
}

function validateExecutable(executable: ControllerExecutable): void {
  if (typeof executable.file !== "string" || !isAbsolute(executable.file) || executable.file.includes("\0")) {
    requestError("executable.file 必须是可信绝对路径");
  }
  if (executable.cwd !== undefined && (!isAbsolute(executable.cwd) || executable.cwd.includes("\0"))) {
    requestError("executable.cwd 必须是可信绝对路径");
  }
  for (const [index, argument] of (executable.fixedArguments ?? []).entries()) {
    if (
      typeof argument !== "string" ||
      argument.includes("\0") ||
      Buffer.byteLength(argument, "utf8") > MAX_FIXED_ARGUMENT_BYTES
    ) {
      requestError(`executable.fixedArguments[${index}] 无效`);
    }
  }
}

export class ControllerBridge {
  readonly #executable: ControllerExecutable;
  readonly #maxOutputBytes: number;
  readonly #maxRequestBytes: number;
  readonly #timeoutMs: number;

  constructor(executable: ControllerExecutable, options: ControllerBridgeOptions = {}) {
    validateExecutable(executable);
    this.#executable = Object.freeze({
      file: executable.file,
      ...(executable.fixedArguments === undefined
        ? {}
        : { fixedArguments: Object.freeze([...executable.fixedArguments]) }),
      ...(executable.cwd === undefined ? {} : { cwd: executable.cwd }),
    });
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    this.#maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > MAX_TIMEOUT_MS) {
      requestError(`timeoutMs 必须在 1..${MAX_TIMEOUT_MS} 之间`);
    }
    for (const [field, value] of [
      ["maxRequestBytes", this.#maxRequestBytes],
      ["maxOutputBytes", this.#maxOutputBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) requestError(`${field} 必须是正安全整数`);
    }
  }

  invoke<T extends ControllerResponse = ControllerResponse>(
    request: ControllerRequest,
    options: ControllerInvokeOptions = {},
  ): Promise<ControllerInvocation<T>> {
    const wireRequest = buildControllerWireRequest(request);
    const requestBytes = Buffer.from(`${JSON.stringify(wireRequest)}\n`, "utf8");
    if (requestBytes.byteLength > this.#maxRequestBytes) {
      return Promise.reject(
        new ControllerBridgeError("CONTROLLER_REQUEST_LIMIT", "Controller 请求超过结构化桥接上限"),
      );
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(new ControllerBridgeError("CONTROLLER_ABORTED", "Controller 调用已取消"));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let outputBytes = 0;
      const stdoutChunks: Buffer[] = [];
      const child = spawn(this.#executable.file, [...(this.#executable.fixedArguments ?? [])], {
        ...(this.#executable.cwd === undefined ? {} : { cwd: this.#executable.cwd }),
        env: safeEnvironment(process.env),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      const finishWithError = (error: ControllerBridgeError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (child.exitCode === null) child.kill();
        reject(error);
      };
      const accountOutput = (chunk: Buffer, retain: boolean): void => {
        outputBytes += chunk.byteLength;
        if (outputBytes > this.#maxOutputBytes) {
          finishWithError(
            new ControllerBridgeError("CONTROLLER_OUTPUT_LIMIT", "Controller 输出超过结构化桥接上限"),
          );
        } else if (retain) {
          stdoutChunks.push(Buffer.from(chunk));
        }
      };
      const abort = (): void => {
        finishWithError(new ControllerBridgeError("CONTROLLER_ABORTED", "Controller 调用已取消"));
      };
      const timer = setTimeout(() => {
        finishWithError(new ControllerBridgeError("CONTROLLER_TIMEOUT", "Controller 调用超时"));
      }, this.#timeoutMs);

      options.signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => accountOutput(chunk, true));
      child.stderr.on("data", (chunk: Buffer) => accountOutput(chunk, false));
      child.stdin.on("error", () => {
        // close/error provides the structured transport outcome; never expose raw EPIPE text.
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        finishWithError(
          new ControllerBridgeError(
            error.code === "ENOENT" ? "CONTROLLER_NOT_FOUND" : "CONTROLLER_PROCESS_ERROR",
            error.code === "ENOENT" ? "Controller sidecar 不存在" : "Controller sidecar 无法启动",
          ),
        );
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (code === null) {
          reject(new ControllerBridgeError("CONTROLLER_PROCESS_ERROR", "Controller 未返回退出码"));
          return;
        }
        try {
          const payload = parseResponse(Buffer.concat(stdoutChunks), code, wireRequest);
          resolve({ exitCode: code, payload: payload as T });
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(requestBytes);
    });
  }
}
