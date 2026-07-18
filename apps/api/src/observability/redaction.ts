export const pinoRedactPaths = [
  "req.headers.authorization",
  "*.apiKey",
  "*.accessToken",
  "*.refreshToken",
  "*.clientSecret",
  "job.data.payload.credentials",
] as const;

const sensitiveKey = /^(authorization|cookie|credential|credentials|password|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret)$/i;
const excludedContentKey = /^(rawPrompt|userPrompt|untrustedSourceData)$/i;

export function redactLogRecord<T>(value: T): T {
  return redact(value, new WeakSet()) as T;
}

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) return value.map((entry) => redact(entry, seen));
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  const result = Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (sensitiveKey.test(key)) return [key, "[REDACTED]"];
    if (excludedContentKey.test(key)) return [key, "[CONTENT OMITTED]"];
    return [key, redact(entry, seen)];
  }));
  seen.delete(value);
  return result;
}
