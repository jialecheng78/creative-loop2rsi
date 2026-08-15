import { GatewayError } from "./errors.js";
import type { GatewayBudgetPolicy, GatewayBudgetSnapshot } from "./types.js";

export const DEFAULT_GATEWAY_BUDGET: Readonly<GatewayBudgetPolicy> = Object.freeze({
  maxRequests: 50,
  maxRequestBytes: 8 * 1024 * 1024,
  maxResponseBytes: 64 * 1024 * 1024,
  maxSingleRequestBytes: 2 * 1024 * 1024,
  maxSingleResponseBytes: 16 * 1024 * 1024,
  firstEventTimeoutMs: 120_000,
  streamIdleTimeoutMs: 90_000,
  totalTimeoutMs: 600_000,
  maxSseLineBytes: 1024 * 1024,
});

const INTEGER_FIELDS = [
  "maxRequests",
  "maxRequestBytes",
  "maxResponseBytes",
  "maxSingleRequestBytes",
  "maxSingleResponseBytes",
  "firstEventTimeoutMs",
  "streamIdleTimeoutMs",
  "totalTimeoutMs",
  "maxSseLineBytes",
] as const;
const CANONICAL_TIMEOUT_FIELDS = [
  "firstEventTimeoutMs",
  "streamIdleTimeoutMs",
  "totalTimeoutMs",
] as const;

export class RequestBudget {
  readonly limits: Readonly<GatewayBudgetPolicy>;
  #requestCount = 0;
  #requestBytes = 0;
  #responseBytes = 0;

  constructor(overrides: Partial<GatewayBudgetPolicy> = {}) {
    const limits = normalizeBudgetOverrides(overrides);
    for (const field of INTEGER_FIELDS) {
      if (!Number.isSafeInteger(limits[field]) || limits[field] <= 0) {
        throw new TypeError(`预算字段 ${field} 必须是正整数`);
      }
    }
    this.limits = Object.freeze(limits);
  }

  reserveRequest(byteLength: number): number {
    assertNonNegativeInteger(byteLength);
    if (byteLength > this.limits.maxSingleRequestBytes) {
      throw new GatewayError("BUDGET_EXCEEDED", "请求超过单次输入预算");
    }
    if (this.#requestCount + 1 > this.limits.maxRequests) {
      throw new GatewayError("BUDGET_EXCEEDED", "请求次数预算已耗尽");
    }
    if (this.#requestBytes + byteLength > this.limits.maxRequestBytes) {
      throw new GatewayError("BUDGET_EXCEEDED", "累计输入预算已耗尽");
    }
    this.#requestCount += 1;
    this.#requestBytes += byteLength;
    return this.#requestCount;
  }

  consumeResponse(byteLength: number, currentRequestBytes: number): number {
    assertNonNegativeInteger(byteLength);
    const nextRequestBytes = currentRequestBytes + byteLength;
    if (nextRequestBytes > this.limits.maxSingleResponseBytes) {
      throw new GatewayError("BUDGET_EXCEEDED", "响应超过单次输出预算");
    }
    if (this.#responseBytes + byteLength > this.limits.maxResponseBytes) {
      throw new GatewayError("BUDGET_EXCEEDED", "累计输出预算已耗尽");
    }
    this.#responseBytes += byteLength;
    return nextRequestBytes;
  }

  snapshot(): GatewayBudgetSnapshot {
    return Object.freeze({
      requestCount: this.#requestCount,
      requestBytes: this.#requestBytes,
      responseBytes: this.#responseBytes,
      limits: this.limits,
    });
  }
}

function normalizeBudgetOverrides(
  overrides: Partial<GatewayBudgetPolicy>,
): GatewayBudgetPolicy {
  const legacyTimeout = overrides.timeoutMs;
  const hasCanonicalTimeout = CANONICAL_TIMEOUT_FIELDS.some(
    field => Object.prototype.hasOwnProperty.call(overrides, field),
  );
  if (legacyTimeout !== undefined && hasCanonicalTimeout) {
    throw new TypeError("timeoutMs 不得与分层超时字段混用");
  }
  const { timeoutMs: _legacyTimeout, ...canonicalOverrides } = overrides;
  return legacyTimeout === undefined
    ? { ...DEFAULT_GATEWAY_BUDGET, ...canonicalOverrides }
    : {
        ...DEFAULT_GATEWAY_BUDGET,
        ...canonicalOverrides,
        firstEventTimeoutMs: legacyTimeout,
        streamIdleTimeoutMs: legacyTimeout,
        totalTimeoutMs: legacyTimeout,
      };
}

function assertNonNegativeInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("预算字节数必须是非负整数");
  }
}
