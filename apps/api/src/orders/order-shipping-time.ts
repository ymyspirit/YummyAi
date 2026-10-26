import type { OrderShippingTime } from "@yummyai/contracts/order/automatic-basis";
import { z } from "zod";

export interface OrderShippingTimeInput {
  now: Date;
  placedAt: string;
  platformShipByAt: string | null;
  platformDeadlineVerifiedAt: string | null;
  platformSource?: "verified_record" | "marketplace_api" | "report_import" | "missing";
  platformSourceVersionId?: string | null;
  dueAt: string | null;
  remainingQuantity: number;
  closed: boolean;
}

const Timestamp = z.iso.datetime({ offset: true });
function instant(value: string | null): string | null {
  if (value === null || !Timestamp.safeParse(value).success) return null;
  return new Date(value).toISOString();
}

/** Platform shipping promises alone drive shipment reminders. No SLA is inferred. */
export function resolveOrderShippingTime(input: OrderShippingTimeInput): OrderShippingTime {
  if (!Number.isFinite(input.now.getTime())) throw new RangeError("Invalid shipping clock");
  if (!Number.isSafeInteger(input.remainingQuantity) || input.remainingQuantity < 0)
    throw new RangeError("Invalid remaining shipping quantity");
  const computedAt = input.now.toISOString();
  const active = !input.closed && input.remainingQuantity > 0;
  const reasons: string[] = [];
  let at = instant(input.platformShipByAt);
  let source = input.platformSource ?? (at || instant(input.platformDeadlineVerifiedAt) ? "verified_record" : "missing");
  let sourceVersionId: string | null = null;
  if (source === "missing") at = null;
  if (source === "marketplace_api" || source === "report_import") {
    if (input.platformSourceVersionId && z.uuidv7().safeParse(input.platformSourceVersionId).success)
      sourceVersionId = input.platformSourceVersionId;
    else {
      at = null;
      if (active) reasons.push("platform_deadline_source_missing");
    }
  }
  if (!at) {
    // A saved manual null is still a real verification record. It clears the
    // promise rather than allowing an older API value to reappear.
    if (source !== "verified_record" || !instant(input.platformDeadlineVerifiedAt)) {
      source = "missing";
      sourceVersionId = null;
    }
    if (active)
      reasons.push(input.platformShipByAt !== null && !instant(input.platformShipByAt)
        ? "platform_deadline_invalid" : "platform_deadline_missing");
  }
  const internalAt = instant(input.dueAt);
  return {
    computedAt,
    platform: {
      at,
      source,
      sourceVersionId,
      // An API observation never manufactures or inherits a human verification.
      verifiedAt: source === "verified_record" ? instant(input.platformDeadlineVerifiedAt) : null,
    },
    internal: {
      at: internalAt,
      source: internalAt ? "operator" : "missing",
      confidence: internalAt ? "explicit" : "unknown",
      evidenceReference: null,
    },
    nextAttentionAt: active ? at : null,
    countdownBasis: active && at ? "platform" : null,
    remainingSeconds: active && at ? Math.floor((Date.parse(at) - input.now.getTime()) / 1000) : null,
    platformOverdue: active && at !== null && Date.parse(at) < input.now.getTime(),
    // Retain the state of an optional legacy manual date, without using it as a
    // shipment deadline or a fallback when the platform promise is unavailable.
    internalOverdue: active && internalAt !== null && Date.parse(internalAt) < input.now.getTime(),
    active,
    missingReasons: reasons,
  };
}
