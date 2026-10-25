import { createHash } from "node:crypto";
import { createEntityId } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { StudioImagePricingSchema, type StudioImagePricing } from "@yummyai/contracts/ai/studio-image-pricing";
import { aiBudgetLedger, aiBudgetPolicies, creativeExecutions, type TenantTransaction } from "@yummyai/database";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { PodOwnerError } from "./errors.js";

const Id = z.uuidv7();
const budgetRequired = () => new PodOwnerError("studio_image_budget_required", 409, "组织图片任务与月度预算尚未配置或剩余额度不足");
const pricingRequired = () => new PodOwnerError("studio_image_pricing_required", 409, "所选图片模型尚未配置每张预估费用与预算预留");

/** An exact opt-in and an explicit tenant are both required, including in Workers. */
export function studioImageAdmission(tenantId: string, environment: Readonly<NodeJS.ProcessEnv> = process.env) {
  const entries = environment.STUDIO_PAID_IMAGE_TENANT_IDS?.split(",").map(value => value.trim()) ?? [];
  const valid = entries.length > 0 && entries.every(value => Id.safeParse(value).success);
  const enabled = environment.STUDIO_PAID_IMAGE_ENABLED === "1" && valid && Id.safeParse(tenantId).success
    && entries.some(value => value.toLowerCase() === tenantId.toLowerCase());
  return { version: 1 as const, enabled, code: enabled ? "ready" as const : "operator_paused" as const };
}

/** Keep the quote's dimensions identical to the image request sent by the gateway. */
export function studioImageWireSize(value: string): string {
  if (value === "auto" || /^\d+x\d+$/.test(value)) return value;
  const [width = 1, height = 1] = value.split(":").map(Number);
  return width > height ? "1536x1024" : width < height ? "1024x1536" : "1024x1024";
}

export function studioImageHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

const micros = (value: string): bigint => {
  if (!/^(0|[1-9]\d{0,7})(?:\.\d{1,6})?$/.test(value)) throw budgetRequired();
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
};
const decimal = (value: bigint) => `${value / 1_000_000n}.${String(value % 1_000_000n).padStart(6, "0")}`;
const parsePricing = (value: StudioImagePricing) => {
  const parsed = StudioImagePricingSchema.safeParse(value);
  if (!parsed.success) throw pricingRequired();
  return parsed.data;
};

export type StudioImageBudgetSnapshot = {
  policy: { monthlyCapUsd: string; defaultTaskCapUsd: string; taskCapsUsd: Readonly<Record<string, number>> } | null;
  /** Database snapshots retain JSONB facts before any JavaScript number conversion. */
  imageCapSql?: { containerType: string | null; hasKey: boolean; valueType: string | null; text: string | null };
  occupiedUsd: string;
  priorOverrun: boolean;
};

/** Pure money calculation: no float multiplication or rounding can create capacity. */
export function assertStudioImageBudgetSnapshot(snapshot: StudioImageBudgetSnapshot, pricing: StudioImagePricing, alreadyReserved = false): string {
  const parsed = parsePricing(pricing), reservation = micros(parsed.reservationUsd);
  if (!snapshot.policy || snapshot.priorOverrun) throw budgetRequired();
  const { policy, imageCapSql } = snapshot;
  let cap: bigint;
  if (imageCapSql !== undefined) {
    if (imageCapSql.containerType !== "object" || typeof imageCapSql.hasKey !== "boolean") throw budgetRequired();
    if (imageCapSql.hasKey) {
      if (imageCapSql.valueType !== "number" || typeof imageCapSql.text !== "string") throw budgetRequired();
      // JSONB numeric text is exact; only insignificant fractional zeros may be removed.
      cap = micros(imageCapSql.text.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""));
    } else cap = micros(policy.defaultTaskCapUsd);
  } else {
    // Preserve pure callers that already supply a fixed-precision snapshot.
    const configured = policy.taskCapsUsd.studio_image;
    if (configured !== undefined && (typeof configured !== "number" || !Number.isFinite(configured))) throw budgetRequired();
    cap = micros(configured === undefined ? policy.defaultTaskCapUsd : String(configured));
  }
  const monthly = micros(policy.monthlyCapUsd), occupied = micros(snapshot.occupiedUsd);
  if (cap <= 0n || monthly <= 0n || reservation > cap || occupied + (alreadyReserved ? 0n : reservation) > monthly) throw budgetRequired();
  return decimal(reservation);
}

export type StudioImageBudgetIdentity = { pricing: StudioImagePricing; model: string; provider: string };
const validateIdentity = (tenantId: string, input: StudioImageBudgetIdentity) => {
  if (!Id.safeParse(tenantId).success) throw budgetRequired();
  // The original execution ledger uses this same bounded billing identity.
  for (const value of [input.model, input.provider]) if (!/^[\p{L}\p{N}_.:/ -]{1,160}$/u.test(value)) throw budgetRequired();
  parsePricing(input.pricing);
};

async function lockedSnapshot(tx: TenantTransaction, tenantId: string, input: StudioImageBudgetIdentity): Promise<StudioImageBudgetSnapshot> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:ai-assist-budget`},0))`);
  const [policy] = await tx.select({
    monthlyCapUsd: aiBudgetPolicies.monthlyCapUsd,
    defaultTaskCapUsd: aiBudgetPolicies.defaultTaskCapUsd,
    taskCapsUsd: aiBudgetPolicies.taskCapsUsd,
    containerType: sql<string | null>`jsonb_typeof(${aiBudgetPolicies.taskCapsUsd})`,
    hasKey: sql<boolean>`${aiBudgetPolicies.taskCapsUsd} ? 'studio_image'`,
    valueType: sql<string | null>`jsonb_typeof(${aiBudgetPolicies.taskCapsUsd}->'studio_image')`,
    text: sql<string | null>`${aiBudgetPolicies.taskCapsUsd}->>'studio_image'`,
  }).from(aiBudgetPolicies).where(eq(aiBudgetPolicies.tenantId, tenantId)).for("share");
  const [total] = await tx.select({ value: sql<string>`coalesce(sum(${aiBudgetLedger.amountUsd}),0)` }).from(aiBudgetLedger)
    .where(and(eq(aiBudgetLedger.tenantId, tenantId), inArray(aiBudgetLedger.state, ["reserved", "committed"]),
      sql`${aiBudgetLedger.createdAt}>=date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`));
  const [overrun] = await tx.select({ id: creativeExecutions.id }).from(creativeExecutions)
    .innerJoin(aiBudgetLedger, and(eq(aiBudgetLedger.tenantId, creativeExecutions.tenantId), eq(aiBudgetLedger.id, creativeExecutions.budgetLedgerId)))
    .where(and(eq(creativeExecutions.tenantId, tenantId), eq(aiBudgetLedger.modelKey, input.model), eq(aiBudgetLedger.provider, input.provider),
      sql`case when (${creativeExecutions.receipt}->>'costUsd') ~ '^(0|[1-9][0-9]{0,7})[.][0-9]{8}$'
        then (${creativeExecutions.receipt}->>'costUsd')::numeric > ${creativeExecutions.budgetLimitUsd} else false end`)).limit(1);
  if (!total) throw budgetRequired();
  return { policy: policy ?? null,
    ...(policy ? { imageCapSql: { containerType: policy.containerType, hasKey: policy.hasKey, valueType: policy.valueType, text: policy.text } } : {}),
    occupiedUsd: total.value, priorOverrun: Boolean(overrun) };
}

/** Call only inside an owning withTenant transaction; this never creates a hold. */
export async function checkStudioImageBudget(tx: TenantTransaction, tenantId: string, input: StudioImageBudgetIdentity): Promise<void> {
  validateIdentity(tenantId, input);
  assertStudioImageBudgetSnapshot(await lockedSnapshot(tx, tenantId, input), input.pricing);
}

/** Commit uses the original persistent AI ledger, serialized with all other AI holds. */
export async function reserveStudioImageBudget(tx: TenantTransaction, tenantId: string, input: StudioImageBudgetIdentity,
  generationId: string): Promise<{ id: string; reservationUsd: string }> {
  validateIdentity(tenantId, input);
  if (!Id.safeParse(generationId).success) throw budgetRequired();
  const snapshot = await lockedSnapshot(tx, tenantId, input);
  const existing = await tx.select().from(aiBudgetLedger)
    .where(and(eq(aiBudgetLedger.tenantId, tenantId), eq(aiBudgetLedger.requestId, generationId))).for("update");
  if (existing.length > 1) throw budgetRequired();
  const record = existing[0];
  if (record && (record.state !== "reserved" || record.taskType !== "studio_image" || record.modelKey !== input.model
    || record.provider !== input.provider || micros(record.amountUsd) !== micros(input.pricing.reservationUsd))) throw budgetRequired();
  const reservationUsd = assertStudioImageBudgetSnapshot(snapshot, input.pricing, Boolean(record));
  if (record) return { id: record.id, reservationUsd };
  const id = createEntityId();
  await tx.insert(aiBudgetLedger).values({ id, tenantId, requestId: generationId, taskType: "studio_image",
    modelKey: input.model, provider: input.provider, amountUsd: reservationUsd, state: "reserved", createdAt: sql`clock_timestamp()` });
  return { id, reservationUsd };
}
