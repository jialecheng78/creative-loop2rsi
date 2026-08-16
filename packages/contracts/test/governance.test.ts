import { describe, expect, it } from "vitest";

import {
  parsePythonGovernanceDocument,
  passthroughPythonGovernance,
  toCreativeSystemAppViewModel,
  type RuntimeProvenance,
} from "../src/index.js";

describe("Python governance boundary", () => {
  it("preserves a snake_case governing receipt without translating it", () => {
    const receipt = {
      schema_version: "1.0",
      kind: "InitialIntentReceipt",
      id: "intent-story-lab",
      created_at: "2026-08-15T00:00:00Z",
      source_refs: [],
      system_id: "story-lab",
      intent: "写一个纯虚构短故事",
      authority: "direct-user-input",
      user_action: "start-creation",
      content_hash: "a".repeat(64),
    };
    expect(parsePythonGovernanceDocument(receipt)).toBe(receipt);
    expect(passthroughPythonGovernance(receipt)).toEqual({
      sourceOfTruth: "python-controller-on-disk",
      document: receipt,
    });
  });

  it("rejects a legacy schema version on an App InitialIntentReceipt", () => {
    expect(() =>
      parsePythonGovernanceDocument({
        schema_version: "0.1",
        kind: "InitialIntentReceipt",
      }),
    ).toThrow(/InitialIntentReceipt\.schema_version must be 1\.0/);
  });

  it("mirrors the current Python RuntimeProvenance record without hidden reasoning", () => {
    const provenance: RuntimeProvenance = {
      schema_version: "1.0",
      kind: "RuntimeProvenance",
      id: "runtime-run-one",
      created_at: "2026-08-15T00:00:00Z",
      source_refs: [],
      content_hash: "b".repeat(64),
      run_id: "run-one",
      requested_model: "deepseek-v4-pro",
      returned_model: "deepseek-returned-synthetic",
      system_fingerprint: "fingerprint-synthetic",
      response_id: "response-synthetic",
      parameters: {
        thinking: "enabled",
        reasoning_effort: "high",
        max_tokens: 32_768,
      },
      usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
      app_version: "1.0.0",
      controller_version: "1.0.0",
      dsh_version: "1.0.0",
      profile_sha256: "a".repeat(64),
      authority: "main-observed-model-gateway",
      reasoning_content_persisted: false,
    };
    expect(parsePythonGovernanceDocument(provenance)).toBe(provenance);
    expect("reasoning_content" in provenance).toBe(false);

    const legacy: RuntimeProvenance = {
      ...provenance,
      parameters: { ...provenance.parameters, max_tokens: 16_384 },
    };
    expect(parsePythonGovernanceDocument(legacy)).toBe(legacy);
  });

  it("continues to require legacy 0.1 for PromotionRecord", () => {
    const record = { schema_version: "0.1", kind: "PromotionRecord" };
    expect(parsePythonGovernanceDocument(record)).toBe(record);
    expect(() =>
      parsePythonGovernanceDocument({ schema_version: "1.0", kind: "PromotionRecord" }),
    ).toThrow(/PromotionRecord\.schema_version must be 0\.1/);
  });

  it("rejects a camelCase DTO presented as governing evidence", () => {
    expect(() =>
      parsePythonGovernanceDocument({ schemaVersion: "0.1", kind: "PromotionRecord" }),
    ).toThrow(/camelCase app DTO/);
  });

  it("maps snake_case CreativeSystem into an explicitly non-governing AppViewModel", () => {
    const view = toCreativeSystemAppViewModel({
      schema_version: "0.1",
      kind: "CreativeSystem",
      project: {
        id: "story-lab",
        name: "故事实验",
        domain_skill: "story-loop",
        active_version: "baseline-v1",
      },
      charter: { path: "creative-system/creative-charter.md", confirmed: false },
      maturity: { declared: "L0", evidence: [] },
      loops: ["creative-system/loops/story.json"],
      judges: [],
      protected_surfaces: ["creative-system/creative-charter.md"],
      editable_surfaces: ["prompts"],
      statuses: {
        execution_status: "NOT_STARTED",
        quality_status: "NOT_EVALUATED",
        release_status: "NOT_READY",
      },
    });
    expect(view.sourceOfTruth).toBe("python-controller-on-disk");
    expect(view.project.domainSkill).toBe("story-loop");
    expect(view.statuses.release).toBe("NOT_READY");
    expect("schema_version" in view).toBe(false);
  });
});
