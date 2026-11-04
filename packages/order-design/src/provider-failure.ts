import type { ModelProviderHttpFailure } from "@yummyai/contracts/ai/provider-failure";
import type { OrderDesignStepCheckpoint } from "./types.js";

export const ORDER_DESIGN_PROVIDER_MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 300_000;

/** Only an explicit rate-limit rejection authorizes a new paid request.
 * Network failures and 5xx responses can hide a completed/billed generation. */
export function orderProviderFailureCode(failure: ModelProviderHttpFailure): string {
  switch (failure.kind) {
    case "moderation": return "agent_provider_moderation_blocked";
    case "authentication": return "agent_provider_authentication_failed";
    case "invalid_request": return "agent_provider_invalid_request";
    case "rate_limit": return "agent_provider_rate_limited";
    default: return "agent_model_submission_unknown";
  }
}

export function orderProviderRetryDelay(failure: ModelProviderHttpFailure, attempt: number): number | null {
  if (failure.kind !== "rate_limit" || failure.status !== 429 || attempt < 1 || attempt >= ORDER_DESIGN_PROVIDER_MAX_ATTEMPTS
    || (failure.retryAfterMs ?? 0) > MAX_RETRY_DELAY_MS) return null;
  return Math.max(5_000 * 2 ** (attempt - 1), failure.retryAfterMs ?? 0);
}

/** Persisted, per-attempt rejection evidence must precede a new reservation. */
export function canRetryRateLimitedStep(checkpoint: OrderDesignStepCheckpoint, attempt: number): boolean {
  const failures = checkpoint.providerFailures ?? [];
  const unsubmitted = checkpoint.unsubmittedAttempts ?? [];
  const accounted = [...failures.map(entry=>entry.attempt),...unsubmitted];
  return attempt > 0 && failures.length > 0 && failures.length < ORDER_DESIGN_PROVIDER_MAX_ATTEMPTS
    && !checkpoint.responseReceipt && !checkpoint.responseCheckpoint
    && failures.every(entry => entry.failure.kind === "rate_limit" && entry.failure.status === 429)
    && accounted.length === attempt && new Set(accounted).size === attempt
    && accounted.every(value=>Number.isSafeInteger(value)&&value>=1&&value<=attempt)
    && !!checkpoint.nextRetryAt && Number.isFinite(Date.parse(checkpoint.nextRetryAt));
}
