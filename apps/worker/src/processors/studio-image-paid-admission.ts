import type { TenantContext } from "@yummyai/contracts";
import { VisualDeliverySnapshotSchema } from "@yummyai/contracts/catalog/product-visuals";
import { StudioPaidImageInputSchema, StudioPaidImageQuoteSchema } from "@yummyai/contracts/pod/studio-paid-image";
import { creativeDesignBatches, creativeStudioGenerations, creativeStudioImageRequests, visualDeliveryArtwork,
  withTenant, type DatabaseConnection } from "@yummyai/database";
import { studioImageAdmission, studioImageHash, studioImageWireSize } from "@yummyai/pod-core";
import { and, eq } from "drizzle-orm";

type Generation = typeof creativeStudioGenerations.$inferSelect;
type ImageRequest = typeof creativeStudioImageRequests.$inferSelect;
export type StudioPaidImageEvidence = {
  generation: Pick<Generation, "id" | "tenantId" | "ownerId" | "scope" | "requestId" | "input" | "modelSnapshot" | "references">;
  request: Pick<ImageRequest, "id" | "tenantId" | "ownerId" | "scope" | "requestId" | "input" | "quote" | "generationId" | "committedAt" | "cancelledAt">;
};
const invalid = () => new Error("STUDIO_PAID_IMAGE_EVIDENCE_CHANGED");
const sameId = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

/** Only this bounded image capability opts in to the previously broad Studio queue. */
export function studioImageWorkerConfigured(environment: Readonly<NodeJS.ProcessEnv> = process.env): boolean {
  const tenants = environment.STUDIO_PAID_IMAGE_TENANT_IDS?.split(",").map(value => value.trim()) ?? [];
  return tenants.some(tenant => studioImageAdmission(tenant, environment).enabled);
}

export function assertStudioImageOperatorAdmission(tenantId: string, environment: Readonly<NodeJS.ProcessEnv> = process.env): void {
  if (!studioImageAdmission(tenantId, environment).enabled) throw new Error("STUDIO_PAID_IMAGE_OPERATOR_PAUSED");
}

/** Match only the database's exact pre-submission guard, never SQL or diagnostic text. */
export function isStudioImageSubmissionBudgetGuard(cause: unknown): boolean {
  let current = cause;
  const seen = new Set<Error>();
  for (let depth = 0; depth < 8; depth++) {
    if (!(current instanceof Error) || seen.has(current)) return false;
    seen.add(current);
    const code: unknown = Object.getOwnPropertyDescriptor(current, "code")?.value;
    const constraint: unknown = Object.getOwnPropertyDescriptor(current, "constraint_name")?.value;
    if (code === "23514" && constraint === "studio_image_paid_submission_month_guard") return true;
    current = Object.getOwnPropertyDescriptor(current, "cause")?.value;
  }
  return false;
}

/** Pure evidence validation never backfills defaults into an immutable old input. */
export function assertStudioPaidImageEvidence({ generation, request }: StudioPaidImageEvidence): void {
  const input = StudioPaidImageInputSchema.safeParse(request.input), quoted = StudioPaidImageQuoteSchema.safeParse(request.quote);
  if (!input.success || !quoted.success) throw invalid();
  const quote = quoted.data, pin = generation.modelSnapshot.paidImage;
  const visual = VisualDeliverySnapshotSchema.optional().parse(Reflect.get(quote, "visualDelivery"));
  const inputFingerprint = studioImageHash(visual ? { input: input.data, visualDelivery: visual } : input.data);
  if (studioImageHash(input.data) !== studioImageHash(request.input) || studioImageHash(quote) !== studioImageHash(request.quote)) throw invalid();
  const { quoteHash, ...fixedQuote } = quote;
  const authority = JSON.parse(quote.contextAuthority) as { tenantId: string; userId: string };
  if (!pin || generation.modelSnapshot.capability !== "image" || !request.generationId || !request.committedAt || request.cancelledAt
    || !Number.isFinite(request.committedAt.getTime()) || request.committedAt.getTime() < Date.parse(quote.createdAt)
    || request.committedAt.getTime() >= Date.parse(quote.expiresAt)
    || !sameId(generation.id, request.generationId) || !sameId(generation.tenantId, request.tenantId) || !sameId(generation.ownerId, request.ownerId)
    || !sameId(authority.tenantId, generation.tenantId) || !sameId(authority.userId, generation.ownerId)
    || request.scope !== generation.scope || !sameId(request.requestId, generation.requestId) || !sameId(request.requestId, input.data.requestId)
    || studioImageHash(fixedQuote) !== quoteHash || inputFingerprint !== quote.inputFingerprint
    || studioImageHash(generation.input) !== studioImageHash(request.input) || studioImageHash(generation.references) !== studioImageHash(quote.references)
    || !sameId(input.data.modelId, quote.modelId) || input.data.selectionRevision !== quote.selectionRevision
    || generation.modelSnapshot.routeId !== quote.modelId || generation.modelSnapshot.providerConfigId !== quote.providerConfigId
    || generation.modelSnapshot.model !== quote.model || generation.modelSnapshot.providerFingerprint !== quote.providerFingerprint
    || pin.imageRequestId !== request.id || pin.quoteHash !== quoteHash || pin.reservationUsd !== quote.pricing.reservationUsd
    || pin.estimatedUsd !== quote.pricing.estimatedUsd || quote.size !== studioImageWireSize(input.data.size)
    || quote.quality !== input.data.quality || quote.background !== input.data.background
    || !/^[\p{L}\p{N}_.:/ -]{1,160}$/u.test(quote.model)) throw invalid();
  if (visual) {
    const ceiling = visual.callCeilingUsd.toFixed(6);
    if (generation.scope === "unassigned" || !sameId(input.data.modelId, visual.modelId) || !sameId(quote.modelId, visual.modelId)
      || !sameId(quote.providerConfigId, visual.providerConfigId) || quote.model !== visual.providerModel
      || quote.providerFingerprint !== visual.providerFingerprint || input.data.visualSlotKey !== visual.slotKey
      || input.data.size !== visual.size || input.data.quality !== "high"
      || input.data.background !== (visual.slotKey === "artwork" ? "transparent" : "opaque")
      || generation.modelSnapshot.visualCeilingUsd !== visual.callCeilingUsd
      || Number(ceiling) !== visual.callCeilingUsd
      || BigInt(quote.pricing.reservationUsd.replace(".", "")) > BigInt(ceiling.replace(".", ""))
      || !quote.references.some(reference => sameId(reference.assetId, visual.sampleAssetId))
      || (visual.slotKey === "artwork" ? input.data.visualArtworkVersionId !== undefined : !input.data.visualArtworkVersionId)) throw invalid();
  } else if (input.data.visualSlotKey !== undefined || input.data.visualArtworkVersionId !== undefined
    || generation.modelSnapshot.visualCeilingUsd !== undefined) throw invalid();
}

/** The envelope cannot grant access or upgrade a legacy task to the new paid path.
 * Current membership, project, method, route and asset authority are additionally
 * rechecked by the original recovery owner before claim/submission/completion. */
export async function readStudioImagePaidAdmission(database: DatabaseConnection,
  identity: Pick<TenantContext, "tenantId" | "userId">, generationId: string,
  environment: Readonly<NodeJS.ProcessEnv> = process.env) {
  if (!studioImageAdmission(identity.tenantId, environment).enabled) return { admitted: false as const, code: "operator_paused" as const };
  return withTenant(database.db, { ...identity, permissions: [], dataScope: "self" }, async tx => {
    const [generation] = await tx.select().from(creativeStudioGenerations).where(and(eq(creativeStudioGenerations.tenantId, identity.tenantId),
      eq(creativeStudioGenerations.ownerId, identity.userId), eq(creativeStudioGenerations.id, generationId)));
    if (!generation?.modelSnapshot.paidImage) return { admitted: false as const, code: "legacy_not_admitted" as const };
    const [request] = await tx.select().from(creativeStudioImageRequests).where(and(eq(creativeStudioImageRequests.tenantId, identity.tenantId),
      eq(creativeStudioImageRequests.ownerId, identity.userId), eq(creativeStudioImageRequests.id, generation.modelSnapshot.paidImage.imageRequestId)));
    if (!request) throw invalid();
    assertStudioPaidImageEvidence({ generation, request });
    const visual = VisualDeliverySnapshotSchema.optional().parse(Reflect.get(request.quote, "visualDelivery"));
    const [project] = generation.scope === "unassigned" ? [] : await tx.select({ ownerId: creativeDesignBatches.createdBy,
      workflow: creativeDesignBatches.canvasWorkflow }).from(creativeDesignBatches).where(eq(creativeDesignBatches.id, generation.scope));
    // Original paid evidence must agree with the real project. An input field
    // cannot upgrade an ordinary/legacy job into a controlled product visual.
    if (visual) {
      if (!project?.workflow?.visualDelivery || project.ownerId !== generation.ownerId
        || studioImageHash(project.workflow.visualDelivery) !== studioImageHash(visual)) throw invalid();
      if (visual.slotKey !== "artwork") {
        const artworkId = await visualDeliveryArtwork(tx, visual, generation.input.visualArtworkVersionId ?? "");
        if (!generation.references[0] || !sameId(generation.references[0].assetId, artworkId)) throw invalid();
      }
    } else if (project?.workflow?.visualDelivery) throw invalid();
    return { admitted: true as const };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
