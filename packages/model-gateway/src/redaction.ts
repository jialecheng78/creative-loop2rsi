const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const API_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{6,}\b/gi;
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:\\(?:[^\\\r\n"'<>|]+\\)*[^\\\r\n"'<>|]*/g;
const POSIX_PATH_PATTERN = /(^|[\s("'])\/(?:Users|home|private|tmp|var|Volumes)\/(?:[^\s"'<>]+\/?)+/g;

export function redactText(input: string, knownSecrets: readonly string[] = []): string {
  let output = input;
  for (const secret of knownSecrets) {
    if (secret.length > 0) output = output.split(secret).join("[REDACTED]");
  }
  return output
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(API_KEY_PATTERN, "[REDACTED]")
    .replace(WINDOWS_PATH_PATTERN, "[LOCAL_PATH]")
    .replace(POSIX_PATH_PATTERN, (_match, prefix: string) => `${prefix}[LOCAL_PATH]`);
}

export function redactValue(
  value: unknown,
  knownSecrets: readonly string[] = [],
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === "string") return redactText(value, knownSecrets);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, knownSecrets, seen));
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = isSensitiveKey(key)
      ? "[REDACTED]"
      : redactValue(child, knownSecrets, seen);
  }
  return output;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, "").toLowerCase();
  return (
    normalized === "authorization" ||
    normalized === "cookie" ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("accesstoken") ||
    normalized.endsWith("refreshtoken") ||
    normalized.endsWith("password") ||
    normalized.endsWith("secret") ||
    normalized === "token"
  );
}

export function safeErrorMessage(error: unknown, knownSecrets: readonly string[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactText(message, knownSecrets).slice(0, 500);
}
