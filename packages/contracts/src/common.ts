export const SCHEMA_VERSION = "0.1" as const;

export type SchemaVersion = typeof SCHEMA_VERSION;
export type IsoTimestamp = string;
export type StableId = string;
export type ProjectRelativePath = string;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export interface ContentDigest {
  readonly path: ProjectRelativePath;
  readonly sha256: string;
  readonly bytes: number;
}

export interface EvidenceRef extends ContentDigest {
  readonly kind?: string;
}

export const EXECUTION_STATUSES = [
  "NOT_STARTED",
  "RUNNING",
  "PASS",
  "BLOCK",
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const QUALITY_STATUSES = [
  "NOT_EVALUATED",
  "PASS",
  "WARN",
  "NEEDS_TASTE",
] as const;
export type QualityStatus = (typeof QUALITY_STATUSES)[number];

export const RELEASE_STATUSES = [
  "NOT_READY",
  "CANDIDATE",
  "PASS",
  "BLOCK",
] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

export interface StatusAxes {
  readonly execution: ExecutionStatus;
  readonly quality: QualityStatus;
  readonly release: ReleaseStatus;
}

export const MATURITY_LEVELS = ["L0", "L1", "L2", "L3", "L4", "L5"] as const;
export type MaturityLevel = (typeof MATURITY_LEVELS)[number];
