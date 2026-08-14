import { GatewayError } from "./errors.js";
import type { DeepSeekUsage, GatewayUsageSummary } from "./types.js";

export function normalizeUsage(value: unknown): GatewayUsageSummary | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw invalidUsage();
  return {
    promptTokens: readCount(value, "prompt_tokens"),
    completionTokens: readCount(value, "completion_tokens"),
    totalTokens: readCount(value, "total_tokens"),
  };
}

export function assertDeepSeekUsage(value: unknown): asserts value is DeepSeekUsage | null | undefined {
  normalizeUsage(value);
}

function readCount(value: Record<string, unknown>, field: string): number | null {
  const count = value[field];
  if (count === undefined || count === null) return null;
  if (!Number.isSafeInteger(count) || (count as number) < 0) throw invalidUsage();
  return count as number;
}

function invalidUsage(): GatewayError {
  return new GatewayError("INVALID_RESPONSE", "usage token 计数格式无效");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
