import type { MarketplacePlatform } from "@yummyai/contracts";

export type MarketplaceConnectorErrorCode =
  | "authorization"
  | "validation"
  | "rate_limited"
  | "conflict"
  | "upstream_retryable"
  | "upstream_terminal";

export class MarketplaceConnectorError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly platform: MarketplacePlatform,
    readonly code: MarketplaceConnectorErrorCode,
    message: string,
    readonly retryAfterMs?: number,
    readonly outcomeUncertain = false,
  ) {
    super(message);
    this.name = "MarketplaceConnectorError";
    this.retryable = code === "rate_limited" || code === "upstream_retryable";
  }
}

export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - now);
}
