import { createHash } from "node:crypto";
import {
  HarnessUsdSchema,
  PodInvocationReceiptSchema,
  type PodInvocationReceipt,
} from "@yummyai/contracts/harness";

/** Extract billing independently of artwork/schema validation, without retaining raw data. */
export function podInvocationReceipt(
  payload: unknown,
  responseChecksum: string,
  requestId: string | null = null,
): PodInvocationReceipt {
  const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const text = (value: unknown, limit: number) =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= limit &&
    !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
      ? value
      : null;
  const modelKey = text(data.modelKey, 160),
    modelVersion = text(data.modelVersion, 160);
  const providerRequestId = text(requestId, 512);
  const amount =
    typeof data.costUsd === "number" &&
    Number.isFinite(data.costUsd) &&
    data.costUsd >= 0 &&
    data.costUsd < 1e12
      ? HarnessUsdSchema.safeParse(data.costUsd.toFixed(8))
      : null;
  const amountKnown=amount?.success && (data.costUsd===0 || Number(amount.data)>0);
  return PodInvocationReceiptSchema.parse({
    version: "pod-response-v1",
    responseChecksum,
    providerRequestId,
    modelKey,
    modelVersion,
    costUsd: amountKnown ? amount.data : null,
    metadataValid: Boolean(
      modelKey &&
      modelVersion &&
      (data.costUsd === undefined || amountKnown) &&
      (requestId === null || providerRequestId),
    ),
    receivedAt: new Date().toISOString(),
  });
}

export function podResultChecksum(result: { outputs: Array<{ bytes: Uint8Array }> }): string {
  const summary={...result,outputs:result.outputs.map(({bytes,...metadata})=>({...metadata,byteSize:bytes.byteLength,sha256:createHash("sha256").update(bytes).digest("hex")}))};
  return createHash("sha256").update(JSON.stringify(summary)).digest("hex");
}
