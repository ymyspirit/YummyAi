import { createHash } from "node:crypto";

import type { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import {
  CustomizationSchema,
  OrderPersonalizationResolutionSnapshotSchema,
  TemplateMappingSnapshotSchema,
  TemplateSlotSchema,
  type CustomizationDefinition,
  type TemplateMappingSnapshot,
  type TemplateSlot,
  type TenantContext,
} from "@yummyai/contracts";
import {
  assetFiles,
  orderCustomizationFileIntakes,
  orderCustomizationRequirements,
  orderCustomizationVersions,
  orderLineCatalogLinks,
  orderLines,
  orderPersonalizationBatchItems,
  orderPersonalizationBatches,
  orders,
  personalizationTemplateVersions,
  skuTemplateBindings,
  templateSlots,
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import { OrderPersonalizationBatchJobPayloadSchema, type JobEnvelope } from "@yummyai/jobs";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import {
  InvalidTemplateSlotMappingError,
  resolveTemplateSlots,
  type ResolvedTemplateSlot,
} from "./pod-personalization-resolver.js";

const ProtectedCustomizationSchema = z.object({
  values: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  fileReferences: z.array(z.object({ fieldKey: z.string(), externalReference: z.string() })),
  unmappedSourceLabels: z.array(z.string()),
}).strict();

export interface OrderPersonalizationItemSnapshot {
  id: string;
  orderId: string;
  orderLineId: string;
  customizationVersionId: string;
  encryptedValues: string;
  schemaSnapshot: CustomizationDefinition;
  mapping: TemplateMappingSnapshot;
  templateVersionId: string;
  slots: TemplateSlot[];
  files: Array<{
    fieldKey: string;
    assetId: string;
    assetVersion: number;
    checksumSha256: string;
    mediaType: string;
  }>;
}

export interface OrderPersonalizationBatchRepository {
  claim(context: Pick<TenantContext, "tenantId" | "userId">, batchId: string): Promise<string[] | undefined>;
  loadItem(context: Pick<TenantContext, "tenantId" | "userId">, itemId: string): Promise<OrderPersonalizationItemSnapshot>;
  completeItem(context: Pick<TenantContext, "tenantId" | "userId">, itemId: string, result: {
    templateVersionId: string;
    encryptedResolution: string;
    resolutionChecksum: string;
    resolvedSlotCount: number;
  }): Promise<void>;
  failItem(context: Pick<TenantContext, "tenantId" | "userId">, itemId: string, error: {
    code: string;
    message: string;
  }): Promise<void>;
  finalize(context: Pick<TenantContext, "tenantId" | "userId">, batchId: string): Promise<{ preparedCount: number; failedCount: number }>;
  retryOrFail(context: Pick<TenantContext, "tenantId" | "userId">, batchId: string, input: {
    terminal: boolean;
    code: string;
    message: string;
  }): Promise<void>;
}

export class OrderPersonalizationPolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "OrderPersonalizationPolicyError";
  }
}

export class OrderPersonalizationBatchProcessor {
  constructor(
    private readonly repository: OrderPersonalizationBatchRepository,
    private readonly piiVault: SecretVault,
  ) {}

  async process(envelope: JobEnvelope) {
    const { batchId } = OrderPersonalizationBatchJobPayloadSchema.parse(envelope.payload);
    const context = { tenantId: envelope.tenantId, userId: envelope.requestedBy };
    try {
      const itemIds = await this.repository.claim(context, batchId);
      if (!itemIds) return { batchId, disposition: "already_claimed" as const };
      for (const itemId of itemIds) {
        try {
          const item = await this.repository.loadItem(context, itemId);
          const protectedCustomization = this.piiVault.withSecret(item.encryptedValues, (plaintext) => {
            try {
              return ProtectedCustomizationSchema.parse(JSON.parse(plaintext));
            } catch {
              throw new OrderPersonalizationPolicyError("PII_PAYLOAD_INVALID", "Protected customization data is invalid");
            }
          });
          validateSlotFieldTypes(item.schemaSnapshot, item.slots, item.mapping);
          const slots = resolveTemplateSlots({
            slots: item.slots,
            mapping: item.mapping,
            values: protectedCustomization.values,
            files: item.files,
          });
          const resolution = OrderPersonalizationResolutionSnapshotSchema.parse({
            version: 2,
            orderId: item.orderId,
            orderLineId: item.orderLineId,
            customizationVersionId: item.customizationVersionId,
            templateVersionId: item.templateVersionId,
            slots,
          });
          const plaintextResolution = stableStringify(resolution);
          const encryptedResolution = this.piiVault.encrypt(plaintextResolution);
          await this.repository.completeItem(context, itemId, {
            templateVersionId: item.templateVersionId,
            encryptedResolution,
            resolutionChecksum: sha256(encryptedResolution),
            resolvedSlotCount: slots.length,
          });
        } catch (error) {
          const diagnostic = itemDiagnostic(error);
          if (!diagnostic) throw error;
          await this.repository.failItem(context, itemId, diagnostic);
        }
      }
      const counts = await this.repository.finalize(context, batchId);
      return { batchId, disposition: "completed" as const, ...counts };
    } catch (error) {
      await this.repository.retryOrFail(context, batchId, {
        terminal: envelope.attempt + 1 >= envelope.maxAttempts,
        code: infrastructureErrorCode(error),
        message: "Order personalization preparation could not complete",
      });
      throw error;
    }
  }
}

export class DrizzleOrderPersonalizationBatchRepository implements OrderPersonalizationBatchRepository {
  constructor(private readonly database: DatabaseConnection) {}

  async claim(context: Pick<TenantContext, "tenantId" | "userId">, batchId: string) {
    return withTenant(this.database.db, workerContext(context), async (tx) => {
      const now = new Date();
      const [batch] = await tx.update(orderPersonalizationBatches).set({
        status: "running",
        startedAt: now,
        errorCode: null,
        errorMessage: null,
        updatedAt: now,
      }).where(and(
        eq(orderPersonalizationBatches.id, batchId),
        inArray(orderPersonalizationBatches.status, ["queued", "running"]),
      )).returning({ id: orderPersonalizationBatches.id });
      if (!batch) return undefined;
      await tx.update(orderPersonalizationBatchItems).set({
        status: "running",
        startedAt: now,
        errorCode: null,
        errorMessage: null,
        completedAt: null,
        updatedAt: now,
      }).where(and(
        eq(orderPersonalizationBatchItems.batchId, batchId),
        inArray(orderPersonalizationBatchItems.status, ["queued", "running"]),
      ));
      const items = await tx.select({ id: orderPersonalizationBatchItems.id }).from(orderPersonalizationBatchItems)
        .where(and(
          eq(orderPersonalizationBatchItems.batchId, batchId),
          eq(orderPersonalizationBatchItems.status, "running"),
        )).orderBy(asc(orderPersonalizationBatchItems.ordinal));
      return items.map((item) => item.id);
    });
  }

  async loadItem(context: Pick<TenantContext, "tenantId" | "userId">, itemId: string) {
    return withTenant(this.database.db, workerContext(context), async (tx) => {
      const [loaded] = await tx.select({
        item: orderPersonalizationBatchItems,
        order: orders,
        line: orderLines,
        requirement: orderCustomizationRequirements,
        version: orderCustomizationVersions,
        catalogLink: orderLineCatalogLinks,
        binding: skuTemplateBindings,
        template: personalizationTemplateVersions,
      }).from(orderPersonalizationBatchItems)
        .innerJoin(orders, eq(orderPersonalizationBatchItems.orderId, orders.id))
        .innerJoin(orderLines, eq(orderPersonalizationBatchItems.orderLineId, orderLines.id))
        .innerJoin(orderCustomizationVersions, eq(orderPersonalizationBatchItems.customizationVersionId, orderCustomizationVersions.id))
        .innerJoin(orderCustomizationRequirements, eq(orderCustomizationVersions.requirementId, orderCustomizationRequirements.id))
        .innerJoin(orderLineCatalogLinks, eq(orderPersonalizationBatchItems.orderLineId, orderLineCatalogLinks.orderLineId))
        .innerJoin(skuTemplateBindings, eq(orderPersonalizationBatchItems.bindingId, skuTemplateBindings.id))
        .innerJoin(personalizationTemplateVersions, eq(skuTemplateBindings.templateVersionId, personalizationTemplateVersions.id))
        .where(and(
          eq(orderPersonalizationBatchItems.id, itemId),
          eq(orderPersonalizationBatchItems.status, "running"),
        )).limit(1);
      if (!loaded) throw new OrderPersonalizationPolicyError("ORDER_SCOPE_MISMATCH", "Order personalization item scope is invalid");
      assertItemPolicy(loaded);

      const storedSlots = await tx.select().from(templateSlots)
        .where(eq(templateSlots.templateVersionId, loaded.template.id)).orderBy(asc(templateSlots.createdAt));
      const slots = storedSlots.map((slot) => TemplateSlotSchema.parse({
        id: slot.id,
        templateVersionId: slot.templateVersionId,
        stableKey: slot.stableKey,
        name: slot.name,
        kind: slot.kind,
        psdGroup: slot.psdGroup ?? undefined,
        geometry: slot.geometry,
        fillMode: slot.fillMode,
        validationSnapshot: slot.validationSnapshot,
        replaceable: slot.replaceable,
        reuseLabel: slot.reuseLabel ?? undefined,
      }));
      if (!slots.some((slot) => slot.replaceable)) {
        throw new OrderPersonalizationPolicyError("TEMPLATE_HAS_NO_REPLACEABLE_SLOTS", "Approved template has no replaceable slots");
      }

      const fileRows = await tx.select({ intake: orderCustomizationFileIntakes, asset: assetFiles })
        .from(orderCustomizationFileIntakes)
        .innerJoin(assetFiles, eq(orderCustomizationFileIntakes.authorizedAssetId, assetFiles.id))
        .where(and(
          eq(orderCustomizationFileIntakes.customizationVersionId, loaded.version.id),
          eq(orderCustomizationFileIntakes.scanStatus, "promoted"),
          isNull(assetFiles.deletedAt),
        ));
      const seenFileFields = new Set<string>();
      const files = fileRows.map(({ intake, asset }) => {
        if (seenFileFields.has(intake.fieldKey)) {
          throw new OrderPersonalizationPolicyError("CUSTOMER_FILE_CARDINALITY_UNSUPPORTED", "A mapped customer field has multiple promoted files");
        }
        seenFileFields.add(intake.fieldKey);
        const source = asset.rightsMetadata as { source?: { kind?: string; reference?: string } };
        if (
          asset.assetDomain !== "order"
          || asset.rightsStatus !== "approved"
          || source.source?.kind !== "customer_provided"
          || source.source.reference !== `order-customization:${loaded.version.id}`
        ) {
          throw new OrderPersonalizationPolicyError("CUSTOMER_FILE_SCOPE_MISMATCH", "Customer file does not match the pinned customization version");
        }
        return {
          fieldKey: intake.fieldKey,
          assetId: asset.id,
          assetVersion: asset.version,
          checksumSha256: asset.checksumSha256,
          mediaType: asset.mediaType,
        };
      });

      return {
        id: loaded.item.id,
        orderId: loaded.order.id,
        orderLineId: loaded.line.id,
        customizationVersionId: loaded.version.id,
        encryptedValues: loaded.version.encryptedValues,
        schemaSnapshot: CustomizationSchema.parse(loaded.requirement.schemaSnapshot),
        mapping: TemplateMappingSnapshotSchema.parse(loaded.binding.mappingSnapshot),
        templateVersionId: loaded.template.id,
        slots,
        files,
      };
    });
  }

  async completeItem(
    context: Pick<TenantContext, "tenantId" | "userId">,
    itemId: string,
    result: { templateVersionId: string; encryptedResolution: string; resolutionChecksum: string; resolvedSlotCount: number },
  ) {
    const now = new Date();
    await withTenant(this.database.db, workerContext(context), (tx) => tx.update(orderPersonalizationBatchItems).set({
      templateVersionId: result.templateVersionId,
      status: "prepared",
      encryptedResolution: result.encryptedResolution,
      resolutionChecksum: result.resolutionChecksum,
      resolvedSlotCount: result.resolvedSlotCount,
      errorCode: null,
      errorMessage: null,
      completedAt: now,
      updatedAt: now,
    }).where(and(
      eq(orderPersonalizationBatchItems.id, itemId),
      eq(orderPersonalizationBatchItems.status, "running"),
    )));
  }

  async failItem(
    context: Pick<TenantContext, "tenantId" | "userId">,
    itemId: string,
    error: { code: string; message: string },
  ) {
    const now = new Date();
    await withTenant(this.database.db, workerContext(context), (tx) => tx.update(orderPersonalizationBatchItems).set({
      status: "failed",
      encryptedResolution: null,
      resolutionChecksum: null,
      resolvedSlotCount: 0,
      errorCode: error.code,
      errorMessage: error.message,
      completedAt: now,
      updatedAt: now,
    }).where(and(
      eq(orderPersonalizationBatchItems.id, itemId),
      eq(orderPersonalizationBatchItems.status, "running"),
    )));
  }

  async finalize(context: Pick<TenantContext, "tenantId" | "userId">, batchId: string) {
    return withTenant(this.database.db, workerContext(context), async (tx) => {
      const rows = await tx.select({ status: orderPersonalizationBatchItems.status }).from(orderPersonalizationBatchItems)
        .where(eq(orderPersonalizationBatchItems.batchId, batchId));
      const preparedCount = rows.filter((item) => item.status === "prepared").length;
      const failedCount = rows.filter((item) => item.status === "failed").length;
      if (preparedCount + failedCount !== rows.length) throw new Error("Order personalization batch still has unfinished items");
      const status = preparedCount === rows.length ? "completed" : preparedCount > 0 ? "partially_succeeded" : "failed";
      const now = new Date();
      await tx.update(orderPersonalizationBatches).set({
        status,
        preparedCount,
        failedCount,
        errorCode: failedCount ? "ONE_OR_MORE_ITEMS_FAILED" : null,
        errorMessage: failedCount ? "One or more order personalization items require review" : null,
        completedAt: now,
        updatedAt: now,
      }).where(and(
        eq(orderPersonalizationBatches.id, batchId),
        eq(orderPersonalizationBatches.status, "running"),
      ));
      return { preparedCount, failedCount };
    });
  }

  async retryOrFail(
    context: Pick<TenantContext, "tenantId" | "userId">,
    batchId: string,
    input: { terminal: boolean; code: string; message: string },
  ) {
    await withTenant(this.database.db, workerContext(context), async (tx) => {
      const now = new Date();
      if (!input.terminal) {
        await tx.update(orderPersonalizationBatchItems).set({ status: "queued", updatedAt: now })
          .where(and(eq(orderPersonalizationBatchItems.batchId, batchId), eq(orderPersonalizationBatchItems.status, "running")));
        await tx.update(orderPersonalizationBatches).set({ status: "queued", updatedAt: now })
          .where(eq(orderPersonalizationBatches.id, batchId));
        return;
      }
      await tx.update(orderPersonalizationBatchItems).set({
        status: "failed",
        errorCode: input.code,
        errorMessage: input.message,
        completedAt: now,
        updatedAt: now,
      }).where(and(
        eq(orderPersonalizationBatchItems.batchId, batchId),
        inArray(orderPersonalizationBatchItems.status, ["queued", "running"]),
      ));
      const rows = await tx.select({ status: orderPersonalizationBatchItems.status }).from(orderPersonalizationBatchItems)
        .where(eq(orderPersonalizationBatchItems.batchId, batchId));
      const preparedCount = rows.filter((item) => item.status === "prepared").length;
      const failedCount = rows.length - preparedCount;
      await tx.update(orderPersonalizationBatches).set({
        status: preparedCount ? "partially_succeeded" : "failed",
        preparedCount,
        failedCount,
        errorCode: input.code,
        errorMessage: input.message,
        completedAt: now,
        updatedAt: now,
      }).where(and(
        eq(orderPersonalizationBatches.id, batchId),
        inArray(orderPersonalizationBatches.status, ["queued", "running"]),
      ));
    });
  }
}

function assertItemPolicy(loaded: {
  item: typeof orderPersonalizationBatchItems.$inferSelect;
  order: typeof orders.$inferSelect;
  line: typeof orderLines.$inferSelect;
  requirement: typeof orderCustomizationRequirements.$inferSelect;
  version: typeof orderCustomizationVersions.$inferSelect;
  catalogLink: typeof orderLineCatalogLinks.$inferSelect;
  binding: typeof skuTemplateBindings.$inferSelect;
  template: typeof personalizationTemplateVersions.$inferSelect;
}) {
  if (
    loaded.line.orderId !== loaded.order.id
    || loaded.requirement.orderId !== loaded.order.id
    || loaded.requirement.orderLineId !== loaded.line.id
    || loaded.version.requirementId !== loaded.requirement.id
  ) throw new OrderPersonalizationPolicyError("ORDER_SCOPE_MISMATCH", "Customization version is outside the requested order line");
  if (loaded.order.sideState === "cancelled") {
    throw new OrderPersonalizationPolicyError("ORDER_CANCELLED", "Cancelled orders cannot enter personalization preparation");
  }
  if (["incomplete", "quarantined", "rejected"].includes(loaded.requirement.status) || loaded.version.missingFieldKeys.length) {
    throw new OrderPersonalizationPolicyError("CUSTOMIZATION_NOT_READY", "Customization data is incomplete, quarantined, or rejected");
  }
  if (!loaded.catalogLink.skuId || loaded.catalogLink.skuId !== loaded.binding.skuId) {
    throw new OrderPersonalizationPolicyError("SKU_BINDING_MISMATCH", "Template binding does not match the pinned order-line SKU");
  }
  if (loaded.binding.status !== "active" || loaded.template.status !== "approved") {
    throw new OrderPersonalizationPolicyError("TEMPLATE_NOT_APPROVED", "An active binding to an approved template is required");
  }
  if (
    loaded.order.placedAt < loaded.binding.effectiveFrom
    || loaded.binding.effectiveTo && loaded.order.placedAt >= loaded.binding.effectiveTo
  ) throw new OrderPersonalizationPolicyError("BINDING_NOT_EFFECTIVE", "Template binding was not effective when the order was placed");
}

function validateSlotFieldTypes(
  rawSchema: CustomizationDefinition,
  slots: readonly TemplateSlot[],
  mapping: TemplateMappingSnapshot,
) {
  const schema = CustomizationSchema.parse(rawSchema);
  const fields = new Map(schema.fields.map((field) => [field.key, field]));
  for (const slot of slots.filter((candidate) => candidate.replaceable)) {
    const fieldKey = mapping.slotFieldMap[slot.stableKey];
    const field = fieldKey ? fields.get(fieldKey) : undefined;
    if (!field) throw new InvalidTemplateSlotMappingError("A replaceable slot is not mapped to the pinned customization schema");
    if (slot.kind === "text" && field.type === "image") {
      throw new InvalidTemplateSlotMappingError("A text slot cannot use an image customization field");
    }
    if (slot.kind !== "text" && field.type !== "image") {
      throw new InvalidTemplateSlotMappingError("An image-like slot requires an image customization field");
    }
  }
}

function itemDiagnostic(error: unknown): { code: string; message: string } | undefined {
  if (error instanceof OrderPersonalizationPolicyError) return { code: error.code, message: error.message };
  if (error instanceof InvalidTemplateSlotMappingError) {
    return { code: "TEMPLATE_MAPPING_INVALID", message: "Template slots could not be resolved from the pinned customization fields" };
  }
  if (error instanceof z.ZodError) {
    return { code: "PINNED_SNAPSHOT_INVALID", message: "A pinned template or customization snapshot is invalid" };
  }
  return undefined;
}

function workerContext(context: Pick<TenantContext, "tenantId" | "userId">): TenantContext {
  return {
    ...context,
    permissions: [Permission.AssetRead, Permission.DesignRead, Permission.OrderPiiRead, Permission.OrderRead],
    dataScope: "tenant",
  };
}

function infrastructureErrorCode(error: unknown) {
  return error instanceof Error
    ? error.name.replaceAll(/[^A-Za-z0-9_]/g, "_").toUpperCase().slice(0, 80)
    : "ORDER_PERSONALIZATION_BATCH_FAILED";
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export type { ResolvedTemplateSlot };
