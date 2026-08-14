import { GatewayError } from "./errors.js";
import type { ApiKeyStore } from "./types.js";

export function assertApiKeyStore(value: unknown): asserts value is ApiKeyStore {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as ApiKeyStore).isAvailable !== "function" ||
    typeof (value as ApiKeyStore).get !== "function" ||
    typeof (value as ApiKeyStore).set !== "function" ||
    typeof (value as ApiKeyStore).delete !== "function"
  ) {
    throw new TypeError("keyStore 必须实现 isAvailable/get/set/delete 抽象接口");
  }
}

export async function readApiKey(keyStore: ApiKeyStore): Promise<string> {
  if (!(await keyStore.isAvailable())) {
    throw new GatewayError("AUTH_UNAVAILABLE", "系统安全存储不可用，模型调用已阻止");
  }
  const value = await keyStore.get();
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GatewayError("AUTH_MISSING", "尚未保存 DeepSeek API Key");
  }
  return value;
}
