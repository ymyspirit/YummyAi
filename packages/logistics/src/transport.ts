export class LogisticsTransportError extends Error {
  constructor(public readonly code: "TRANSPORT_UNCERTAIN" | "PROVIDER_REJECTED" | "INVALID_RESPONSE" | "LABEL_UNAVAILABLE" | "LABEL_PENDING", public readonly providerCode?: string) { super(code); }
}
export async function boundedBody(response: Response, limit: number) {
  if (Number(response.headers.get("content-length") ?? 0) > limit) { await response.body?.cancel(); throw new LogisticsTransportError("INVALID_RESPONSE"); }
  const reader = response.body?.getReader();
  if (!reader) throw new LogisticsTransportError("INVALID_RESPONSE");
  const parts: Uint8Array[] = []; let size = 0;
  while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > limit) { await reader.cancel(); throw new LogisticsTransportError("INVALID_RESPONSE"); } parts.push(next.value); }
  return Buffer.concat(parts);
}
