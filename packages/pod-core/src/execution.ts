import { createHash } from "node:crypto";

export function podExecutionFingerprint(input: {
  id: string;
  designTaskId: string;
  toolKey: string;
  parameterSnapshot: unknown;
  methodSnapshot?: unknown;
  inputAssets: Array<{ id: string; version: number; checksumSha256: string; domain: string; rightsStatus: string; rightsSourceKind?: string }>;
}) {
  return createHash("sha256").update(JSON.stringify(canonical({
    id: input.id, designTaskId: input.designTaskId, toolKey: input.toolKey, parameterSnapshot: input.parameterSnapshot,
    ...(input.methodSnapshot ? { methodSnapshot: input.methodSnapshot } : {}),
    inputs: input.inputAssets.map(asset => ({ id: asset.id, version: asset.version, checksumSha256: asset.checksumSha256, domain: asset.domain, rightsStatus: asset.rightsStatus, rightsSourceKind: asset.rightsSourceKind ?? null })),
  }))).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
