import type { IsoTimestamp, StableId } from "./common.js";

export const MODEL_PROFILE_IDS = ["deepseek-v4-pro", "deepseek-v4-flash"] as const;
export type ModelProfileId = (typeof MODEL_PROFILE_IDS)[number];

export interface ModelMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ModelGenerateRequest {
  readonly profile: ModelProfileId;
  readonly messages: readonly ModelMessage[];
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly stream?: boolean;
}

export interface ModelUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ModelParameterSummary {
  readonly stream: boolean;
  readonly maxTokens: number | null;
  readonly temperature: number | null;
}

export interface ModelResponseMetadata {
  readonly requestedModel: string;
  readonly returnedModel: string | null;
  readonly systemFingerprint: string | null;
  readonly usage: ModelUsage;
  readonly finishReason: string | null;
  readonly requestId: string | null;
  readonly parameters: ModelParameterSummary;
}

export type ModelStreamEvent =
  | {
      readonly type: "content-delta";
      readonly content: string;
    }
  | {
      readonly type: "metadata";
      readonly metadata: ModelResponseMetadata;
    }
  | {
      readonly type: "done";
    };

export interface ModelInvocationRecord {
  readonly invocationId: StableId;
  readonly startedAt: IsoTimestamp;
  readonly completedAt: IsoTimestamp;
  readonly metadata: ModelResponseMetadata;
  readonly runtimeVersion: string;
}
