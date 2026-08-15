import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  CONTROLLER_OPERATIONS,
  ControllerBridge,
  ControllerBridgeError,
  buildControllerWireRequest,
  type ControllerRequest,
} from "../src/index.js";

const mockController = fileURLToPath(new URL("./mock-controller.mjs", import.meta.url));
const projectPath = resolve("synthetic-controller-project");
const originalDeepSeekEnvironment = process.env.DEEPSEEK_API_KEY;

afterEach(() => {
  if (originalDeepSeekEnvironment === undefined) {
    delete process.env.DEEPSEEK_API_KEY;
  } else {
    process.env.DEEPSEEK_API_KEY = originalDeepSeekEnvironment;
  }
});

function request(): ControllerRequest {
  return {
    request_id: "request-one",
    operation: "candidate_summary",
    payload: { project: projectPath, candidate_id: "candidate-one" },
  };
}

function completeWorkRequest(): ControllerRequest {
  return {
    request_id: "request-complete",
    operation: "complete_work",
    payload: {
      project: projectPath,
      run_id: "run-one",
      output: "synthetic completed work",
      runtime_provenance: {
        app_version: "1.0.0",
        completed_at: "2026-08-15T00:00:00Z",
        completed_requests: 1,
        controller_version: "1.0.0",
        context_sha256: "b".repeat(64),
        dsh_version: "1.0.0",
        failed_requests: 0,
        parameters: {
          thinking: "enabled",
          reasoning_effort: "high",
          max_tokens: 16_384,
        },
        profile_sha256: "a".repeat(64),
        request_count: 1,
        requests: [{
          request_number: 1,
          started_at: "2026-08-14T23:59:00Z",
          completed_at: "2026-08-15T00:00:00Z",
          status: "COMPLETED",
          http_status: null,
          error_code: null,
          response_id: "response-synthetic",
          returned_model: "deepseek-returned-synthetic",
          system_fingerprint: "fingerprint-synthetic",
          usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
        }],
        requested_model: "deepseek-v4-pro",
        response_id: "response-synthetic",
        returned_model: "deepseek-returned-synthetic",
        system_fingerprint: "fingerprint-synthetic",
        usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
      },
    },
  };
}

function mockBridge(mode: string, options: { maxOutputBytes?: number; maxRequestBytes?: number; timeoutMs?: number } = {}) {
  return new ControllerBridge(
    { file: process.execPath, fixedArguments: [mockController, mode] },
    options,
  );
}

describe("buildControllerWireRequest", () => {
  it("exports the exact Python app-service operation set", () => {
    expect(CONTROLLER_OPERATIONS).toEqual([
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
      "reject_method_candidate",
      "resume_feedback",
      "rollback_method",
      "seal_feedback",
      "stage_method_comparisons",
      "submit_method_comparison",
      "submit_feedback",
      "system_snapshot",
    ]);
  });

  it("adds the fixed protocol version to an allowlisted operation", () => {
    expect(buildControllerWireRequest(request())).toEqual({
      protocol_version: "1",
      request_id: "request-one",
      operation: "candidate_summary",
      payload: { project: projectPath, candidate_id: "candidate-one" },
    });
  });

  it("rejects unknown operations, extra fields, relative project paths and credentials", () => {
    expect(() =>
      buildControllerWireRequest({
        request_id: "request-one",
        operation: "run_anything",
        payload: {},
      } as never),
    ).toThrowError(/operation 不在允许列表/);

    expect(() =>
      buildControllerWireRequest({
        ...request(),
        payload: { project: projectPath, candidate_id: "candidate-one", arbitrary: true },
      } as never),
    ).toThrowError(/不是允许字段/);

    expect(() =>
      buildControllerWireRequest({
        request_id: "request-one",
        operation: "candidate_summary",
        payload: { project: "relative/project", candidate_id: "candidate-one" },
      }),
    ).toThrowError(/绝对路径/);

    expect(() =>
      buildControllerWireRequest({
        ...request(),
        payload: { project: projectPath, candidate_id: "candidate-one", api_key: "synthetic-value" },
      } as never),
    ).toThrowError(/不得包含凭证字段/);
  });

  it("enforces feedback action invariants before starting Python", () => {
    expect(() =>
      buildControllerWireRequest({
        request_id: "request-two",
        operation: "record_feedback",
        payload: {
          project: projectPath,
          run_id: "run-one",
          event_id: "event-one",
          action: "edit",
          feedback_at: "2026-08-15T00:00:00Z",
        },
      }),
    ).toThrowError(/edit 必须提供 edited_text/);
  });

  it("accepts complete_work and system_snapshot with their exact payload contracts", () => {
    expect(buildControllerWireRequest(completeWorkRequest())).toMatchObject({
      protocol_version: "1",
      operation: "complete_work",
      payload: {
        runtime_provenance: {
          parameters: { thinking: "enabled", reasoning_effort: "high", max_tokens: 16_384 },
        },
      },
    });
    expect(buildControllerWireRequest({
      request_id: "request-snapshot",
      operation: "system_snapshot",
      payload: { project: projectPath },
    })).toEqual({
      protocol_version: "1",
      request_id: "request-snapshot",
      operation: "system_snapshot",
      payload: { project: projectPath },
    });
  });

  it("accepts explicit dispatch identity and the bounded cancel operation", () => {
    expect(buildControllerWireRequest({
      request_id: "request-begin",
      operation: "begin_work",
      payload: {
        project: projectPath,
        work_id: "work-one",
        task: "synthetic work",
        run_id: "run-one",
        dispatch_id: "dispatch-one",
        context_id: "context-one",
        context_sha256: "b".repeat(64),
      },
    })).toMatchObject({ payload: { dispatch_id: "dispatch-one", context_id: "context-one" } });
    expect(buildControllerWireRequest({
      request_id: "request-cancel",
      operation: "cancel_work",
      payload: {
        project: projectPath,
        run_id: "run-one",
        dispatch_id: "dispatch-one",
        reason: "user-cancelled",
      },
    })).toMatchObject({ operation: "cancel_work", payload: { reason: "user-cancelled" } });
  });

  it("resumes feedback only by the persisted run identity", () => {
    expect(buildControllerWireRequest({
      request_id: "request-resume-feedback",
      operation: "resume_feedback",
      payload: {
        project: projectPath,
        run_id: "run-synthetic",
      },
    })).toMatchObject({
      operation: "resume_feedback",
      payload: { run_id: "run-synthetic" },
    });
    expect(() => buildControllerWireRequest({
      request_id: "request-resume-feedback-original",
      operation: "resume_feedback",
      payload: {
        project: projectPath,
        run_id: "run-synthetic",
        edited_text: "不得由 Renderer 重传的原文",
      },
    } as never)).toThrowError(/edited_text 不是允许字段/);
  });

  it("enforces the creative input limit in UTF-8 bytes", () => {
    const valid = {
      request_id: "request-begin-byte-limit",
      operation: "begin_work",
      payload: {
        project: projectPath,
        work_id: "work-byte-limit",
        task: "文".repeat(33_334),
        context_sha256: "b".repeat(64),
      },
    } as const;
    expect(() => buildControllerWireRequest(valid)).toThrowError(/100000 UTF-8 字节/);
  });

  it("rejects provenance policy drift, hidden reasoning and unknown usage counters", () => {
    const valid = completeWorkRequest();
    if (valid.operation !== "complete_work") throw new Error("fixture operation mismatch");
    expect(() => buildControllerWireRequest({
      ...valid,
      payload: {
        ...valid.payload,
        runtime_provenance: {
          ...valid.payload.runtime_provenance,
          parameters: {
            ...valid.payload.runtime_provenance.parameters,
            reasoning_effort: "medium",
          },
        },
      },
    } as never)).toThrowError(/固定模型策略/);

    expect(() => buildControllerWireRequest({
      ...valid,
      payload: {
        ...valid.payload,
        runtime_provenance: {
          ...valid.payload.runtime_provenance,
          reasoning_content: "must not enter controller evidence",
        },
      },
    } as never)).toThrowError(/不是允许字段/);

    expect(() => buildControllerWireRequest({
      ...valid,
      payload: {
        ...valid.payload,
        runtime_provenance: {
          ...valid.payload.runtime_provenance,
          usage: { total_tokens: 19, billed_tokens: 19 },
        },
      },
    } as never)).toThrowError(/不是允许字段/);
  });
});

describe("ControllerBridge", () => {
  it("sends one JSON stdin frame and strips credential environment variables", async () => {
    process.env.DEEPSEEK_API_KEY = "synthetic-value";
    const result = await mockBridge("echo").invoke(request());

    expect(result.exitCode).toBe(0);
    expect(result.payload).toMatchObject({
      protocol_version: "1",
      request_id: "request-one",
      operation: "candidate_summary",
      status: "PASS",
      inheritedCredentialEnvironment: false,
      received: buildControllerWireRequest(request()),
    });
  });

  it("returns a structured BLOCK emitted with a non-zero exit code", async () => {
    const result = await mockBridge("block").invoke(request());
    expect(result.exitCode).toBe(2);
    expect(result.payload).toMatchObject({
      status: "BLOCK",
      error: { code: "SyntheticBlock" },
    });
  });

  it("rejects multiple frames and mismatched response envelopes", async () => {
    await expect(mockBridge("double-json").invoke(request())).rejects.toMatchObject({
      code: "CONTROLLER_PROTOCOL_ERROR",
    });
    await expect(mockBridge("mismatch").invoke(request())).rejects.toMatchObject({
      code: "CONTROLLER_PROTOCOL_ERROR",
    });
  });

  it("enforces request and combined response byte budgets", async () => {
    await expect(mockBridge("echo", { maxRequestBytes: 32 }).invoke(request())).rejects.toMatchObject({
      code: "CONTROLLER_REQUEST_LIMIT",
    });
    await expect(mockBridge("large", { maxOutputBytes: 128 }).invoke(request())).rejects.toMatchObject({
      code: "CONTROLLER_OUTPUT_LIMIT",
    });
  });

  it("terminates a timed-out sidecar without returning partial output", async () => {
    await expect(mockBridge("sleep", { timeoutMs: 20 }).invoke(request())).rejects.toMatchObject({
      code: "CONTROLLER_TIMEOUT",
    });
  });

  it("honors cancellation before the sidecar starts", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(mockBridge("echo").invoke(request(), { signal: controller.signal })).rejects.toMatchObject({
      code: "CONTROLLER_ABORTED",
    });
  });

  it("requires an absolute, trusted executable path", () => {
    expect(() => new ControllerBridge({ file: "python" })).toThrowError(ControllerBridgeError);
  });
});
