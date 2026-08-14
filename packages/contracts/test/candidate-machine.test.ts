import { describe, expect, it } from "vitest";

import {
  CandidateTransitionError,
  createCandidateSnapshot,
  isPromotionEligible,
  transitionCandidate,
} from "../src/index.js";

const at = (second: number): string => `2026-08-15T00:00:${String(second).padStart(2, "0")}Z`;

function runPassingExactThree(maturity: "L4" | "L5" = "L4") {
  let candidate = createCandidateSnapshot({ id: "pace-v2", maturity, at: at(0) });
  candidate = transitionCandidate(candidate, { type: "SUBMIT", at: at(1) });
  candidate = transitionCandidate(candidate, { type: "OPEN_EVALUATION", phase: "targeted", at: at(2) });
  candidate = transitionCandidate(candidate, { type: "SEAL_EVALUATION", phase: "targeted", result: "PASS", at: at(3) });
  candidate = transitionCandidate(candidate, { type: "OPEN_EVALUATION", phase: "regression", at: at(4) });
  candidate = transitionCandidate(candidate, { type: "SEAL_EVALUATION", phase: "regression", result: "PASS", at: at(5) });
  candidate = transitionCandidate(candidate, { type: "OPEN_EVALUATION", phase: "heldout", at: at(6) });
  candidate = transitionCandidate(candidate, { type: "SEAL_EVALUATION", phase: "heldout", result: "NON_INFERIOR", at: at(7) });
  return candidate;
}

describe("candidate state machine", () => {
  it("makes L4 promotion eligible only after exact-three", () => {
    const candidate = runPassingExactThree();
    expect(candidate.state).toBe("READY_FOR_HUMAN");
    expect(candidate.humanApproval).toBe("PENDING");
    expect(isPromotionEligible(candidate)).toBe(true);

    const promoted = transitionCandidate(candidate, { type: "APPROVE", at: at(8) });
    expect(promoted.state).toBe("PROMOTED");
    expect(promoted.humanApproval).toBe("APPROVED");
    expect(() => transitionCandidate(promoted, { type: "BLOCK", at: at(9) })).toThrow(
      CandidateTransitionError,
    );
  });

  it("does not allow phases to be skipped, duplicated, or concurrent", () => {
    let candidate = createCandidateSnapshot({ id: "order-v1", maturity: "L4", at: at(0) });
    candidate = transitionCandidate(candidate, { type: "SUBMIT", at: at(1) });

    expect(() =>
      transitionCandidate(candidate, { type: "OPEN_EVALUATION", phase: "regression", at: at(2) }),
    ).toThrow(/expected targeted/);

    candidate = transitionCandidate(candidate, { type: "OPEN_EVALUATION", phase: "targeted", at: at(2) });
    expect(() =>
      transitionCandidate(candidate, { type: "OPEN_EVALUATION", phase: "targeted", at: at(3) }),
    ).toThrow(/only one evaluation/);
    expect(() =>
      transitionCandidate(candidate, {
        type: "SEAL_EVALUATION",
        phase: "targeted",
        result: "NON_INFERIOR",
        at: at(3),
      }),
    ).toThrow(/not valid for targeted/);
  });

  it("makes failed or invalid evaluations irreversibly blocked", () => {
    let candidate = createCandidateSnapshot({ id: "blocked-v1", maturity: "L4", at: at(0) });
    candidate = transitionCandidate(candidate, { type: "SUBMIT", at: at(1) });
    candidate = transitionCandidate(candidate, { type: "OPEN_EVALUATION", phase: "targeted", at: at(2) });
    candidate = transitionCandidate(candidate, {
      type: "SEAL_EVALUATION",
      phase: "targeted",
      result: "FAIL",
      at: at(3),
    });

    expect(candidate.state).toBe("BLOCKED");
    expect(candidate.blockReason).toBe("TARGETED_FAILED");
    expect(isPromotionEligible(candidate)).toBe(false);
    expect(() => transitionCandidate(candidate, { type: "SUBMIT", at: at(4) })).toThrow(
      /irreversible terminal state/,
    );

    let contaminated = createCandidateSnapshot({ id: "contaminated-v1", maturity: "L4", at: at(0) });
    contaminated = transitionCandidate(contaminated, { type: "SUBMIT", at: at(1) });
    contaminated = transitionCandidate(contaminated, {
      type: "OPEN_EVALUATION",
      phase: "targeted",
      at: at(2),
    });
    contaminated = transitionCandidate(contaminated, {
      type: "INVALIDATE_EVALUATION",
      reason: "STALE_OUTPUT_CONTAMINATION",
      at: at(3),
    });
    expect(contaminated.state).toBe("BLOCKED");
    expect(contaminated.blockReason).toBe("STALE_OUTPUT_CONTAMINATION");

    const initiallyPassing = runPassingExactThree();
    const invalidatedAfterSeal = transitionCandidate(initiallyPassing, {
      type: "INVALIDATE_EVALUATION",
      reason: "EVALUATION_TERMINAL_INVALID",
      at: at(8),
    });
    expect(invalidatedAfterSeal.state).toBe("BLOCKED");
    expect(invalidatedAfterSeal.blockReason).toBe("EVALUATION_TERMINAL_INVALID");
  });

  it("keeps L5 experimental and refuses promotion", () => {
    const candidate = runPassingExactThree("L5");
    expect(candidate.experimental).toBe(true);
    expect(isPromotionEligible(candidate)).toBe(false);
    expect(() => transitionCandidate(candidate, { type: "APPROVE", at: at(8) })).toThrow(
      /L5 candidates are experimental/,
    );
  });

  it("keeps human rejection distinct from a machine block", () => {
    const candidate = runPassingExactThree();
    const rejected = transitionCandidate(candidate, { type: "REJECT", at: at(8) });
    expect(rejected.state).toBe("REJECTED");
    expect(rejected.humanApproval).toBe("REJECTED");
    expect(rejected.blockReason).toBeUndefined();
    expect(() => transitionCandidate(rejected, { type: "APPROVE", at: at(9) })).toThrow(
      /irreversible terminal state/,
    );
  });
});
