import type { IsoTimestamp, StableId } from "./common.js";

export const EVALUATION_PHASES = ["targeted", "regression", "heldout"] as const;
export type EvaluationPhase = (typeof EVALUATION_PHASES)[number];

export type EvaluationState = "NOT_STARTED" | "RUNNING" | "PASSED";

export const CANDIDATE_STATES = [
  "DRAFT",
  "CANDIDATE",
  "EVALUATING",
  "READY_FOR_HUMAN",
  "PROMOTED",
  "REJECTED",
  "BLOCKED",
] as const;
export type CandidateState = (typeof CANDIDATE_STATES)[number];

export type CandidateBlockReason =
  | "TARGETED_FAILED"
  | "REGRESSION_FAILED"
  | "HELDOUT_WORSE"
  | "EVALUATION_TERMINAL_INVALID"
  | "STALE_OUTPUT_CONTAMINATION"
  | "FRESH_OUTPUT_ROOT_FAILED"
  | "MANUAL_BLOCK";

export interface CandidateSnapshot {
  readonly id: StableId;
  readonly maturity: "L4" | "L5";
  readonly experimental: boolean;
  readonly state: CandidateState;
  readonly evaluations: Readonly<Record<EvaluationPhase, EvaluationState>>;
  readonly humanApproval: "NOT_REQUESTED" | "PENDING" | "APPROVED" | "REJECTED";
  readonly revision: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly blockReason?: CandidateBlockReason;
}

export type CandidateEvent =
  | { readonly type: "SUBMIT"; readonly at: IsoTimestamp }
  | { readonly type: "OPEN_EVALUATION"; readonly phase: EvaluationPhase; readonly at: IsoTimestamp }
  | {
      readonly type: "SEAL_EVALUATION";
      readonly phase: EvaluationPhase;
      readonly result: "PASS" | "FAIL" | "NON_INFERIOR" | "WORSE";
      readonly at: IsoTimestamp;
    }
  | {
      readonly type: "INVALIDATE_EVALUATION";
      readonly reason: "EVALUATION_TERMINAL_INVALID" | "STALE_OUTPUT_CONTAMINATION" | "FRESH_OUTPUT_ROOT_FAILED";
      readonly at: IsoTimestamp;
    }
  | { readonly type: "APPROVE"; readonly at: IsoTimestamp }
  | { readonly type: "REJECT"; readonly at: IsoTimestamp }
  | { readonly type: "BLOCK"; readonly at: IsoTimestamp };

const TERMINAL_STATES: ReadonlySet<CandidateState> = new Set(["PROMOTED", "REJECTED", "BLOCKED"]);

export class CandidateTransitionError extends Error {
  readonly state: CandidateState;
  readonly eventType: CandidateEvent["type"];

  constructor(state: CandidateState, eventType: CandidateEvent["type"], message: string) {
    super(message);
    this.name = "CandidateTransitionError";
    this.state = state;
    this.eventType = eventType;
  }
}

export function createCandidateSnapshot(input: {
  readonly id: StableId;
  readonly maturity: "L4" | "L5";
  readonly at: IsoTimestamp;
}): CandidateSnapshot {
  return {
    id: input.id,
    maturity: input.maturity,
    experimental: input.maturity === "L5",
    state: "DRAFT",
    evaluations: {
      targeted: "NOT_STARTED",
      regression: "NOT_STARTED",
      heldout: "NOT_STARTED",
    },
    humanApproval: "NOT_REQUESTED",
    revision: 0,
    createdAt: input.at,
    updatedAt: input.at,
  };
}

export function transitionCandidate(
  current: CandidateSnapshot,
  event: CandidateEvent,
): CandidateSnapshot {
  if (TERMINAL_STATES.has(current.state)) {
    throw invalid(current, event, `${current.state} is an irreversible terminal state`);
  }

  if (event.type === "SUBMIT") {
    requireState(current, event, "DRAFT");
    return advance(current, event.at, { state: "CANDIDATE" });
  }

  if (event.type === "OPEN_EVALUATION") {
    return openEvaluation(current, event);
  }

  if (event.type === "SEAL_EVALUATION") {
    return sealEvaluation(current, event);
  }

  if (event.type === "INVALIDATE_EVALUATION") {
    if (current.state === "DRAFT") {
      throw invalid(current, event, "an unsubmitted candidate has no evaluation to invalidate");
    }
    return advance(current, event.at, { state: "BLOCKED", blockReason: event.reason });
  }

  if (event.type === "APPROVE") {
    requireState(current, event, "READY_FOR_HUMAN");
    if (current.maturity === "L5") {
      throw invalid(current, event, "L5 candidates are experimental and cannot be promoted");
    }
    return advance(current, event.at, { state: "PROMOTED", humanApproval: "APPROVED" });
  }

  if (event.type === "REJECT") {
    requireState(current, event, "READY_FOR_HUMAN");
    return advance(current, event.at, {
      state: "REJECTED",
      humanApproval: "REJECTED",
    });
  }

  if (event.type === "BLOCK") {
    return advance(current, event.at, { state: "BLOCKED", blockReason: "MANUAL_BLOCK" });
  }

  return assertNever(event);
}

export function isPromotionEligible(candidate: CandidateSnapshot): boolean {
  return (
    candidate.maturity === "L4" &&
    candidate.state === "READY_FOR_HUMAN" &&
    EVALUATION_PHASES.every((phase) => candidate.evaluations[phase] === "PASSED")
  );
}

function openEvaluation(
  current: CandidateSnapshot,
  event: Extract<CandidateEvent, { readonly type: "OPEN_EVALUATION" }>,
): CandidateSnapshot {
  if (current.state !== "CANDIDATE" && current.state !== "EVALUATING") {
    throw invalid(current, event, "candidate is not ready to open an evaluation");
  }
  if (Object.values(current.evaluations).includes("RUNNING")) {
    throw invalid(current, event, "only one evaluation may run at a time");
  }
  const expectedPhase = EVALUATION_PHASES.find(
    (phase) => current.evaluations[phase] === "NOT_STARTED",
  );
  if (expectedPhase !== event.phase) {
    throw invalid(current, event, `expected ${expectedPhase ?? "no further phase"}`);
  }
  return advance(current, event.at, {
    state: "EVALUATING",
    evaluations: { ...current.evaluations, [event.phase]: "RUNNING" },
  });
}

function sealEvaluation(
  current: CandidateSnapshot,
  event: Extract<CandidateEvent, { readonly type: "SEAL_EVALUATION" }>,
): CandidateSnapshot {
  requireState(current, event, "EVALUATING");
  if (current.evaluations[event.phase] !== "RUNNING") {
    throw invalid(current, event, `${event.phase} is not running`);
  }

  const expectedPassingResult = event.phase === "heldout" ? "NON_INFERIOR" : "PASS";
  const allowedResults = event.phase === "heldout" ? ["NON_INFERIOR", "WORSE"] : ["PASS", "FAIL"];
  if (!allowedResults.includes(event.result)) {
    throw invalid(current, event, `${event.result} is not valid for ${event.phase}`);
  }
  if (event.result !== expectedPassingResult) {
    const blockReason: CandidateBlockReason =
      event.phase === "targeted"
        ? "TARGETED_FAILED"
        : event.phase === "regression"
          ? "REGRESSION_FAILED"
          : "HELDOUT_WORSE";
    return advance(current, event.at, { state: "BLOCKED", blockReason });
  }

  const evaluations = { ...current.evaluations, [event.phase]: "PASSED" };
  const allPassed = EVALUATION_PHASES.every((phase) => evaluations[phase] === "PASSED");
  return advance(current, event.at, {
    state: allPassed ? "READY_FOR_HUMAN" : "EVALUATING",
    evaluations,
    humanApproval: allPassed ? "PENDING" : current.humanApproval,
  });
}

function advance(
  current: CandidateSnapshot,
  at: IsoTimestamp,
  patch: Partial<CandidateSnapshot>,
): CandidateSnapshot {
  return {
    ...current,
    ...patch,
    revision: current.revision + 1,
    updatedAt: at,
  };
}

function requireState(
  current: CandidateSnapshot,
  event: CandidateEvent,
  expected: CandidateState,
): void {
  if (current.state !== expected) {
    throw invalid(current, event, `expected ${expected}`);
  }
}

function invalid(
  current: CandidateSnapshot,
  event: CandidateEvent,
  reason: string,
): CandidateTransitionError {
  return new CandidateTransitionError(current.state, event.type, reason);
}

function assertNever(value: never): never {
  throw new Error(`unhandled candidate event: ${JSON.stringify(value)}`);
}
