import { createHash } from "node:crypto";

import type { SecretVault } from "@yummyai/ai-core";
import { ConflictException, Inject, Injectable, NotFoundException, Optional, UnprocessableEntityException } from "@nestjs/common";
import {
  CreateOrderProofInputSchema,
  InitializeOrderCustomizationInputSchema,
  OrderCustomizationSummaryViewSchema,
  OrderFulfillmentPathSchema,
  RecordCustomerProofDecisionInputSchema,
  RecordCustomizationFileScanInputSchema,
  RemapOrderCustomizationInputSchema,
  RegisterOrderCustomizationFileInputSchema,
  createEntityId,
  type CreateOrderProofInput,
  type InitializeOrderCustomizationInput,
  type OrderCustomizationSummaryView,
  type RecordCustomerProofDecisionInput,
  type RecordCustomizationFileScanInput,
  type RemapOrderCustomizationInput,
  type RegisterOrderCustomizationFileInput,
  type TenantContext,
} from "@yummyai/contracts";
import {
  assetFiles, designVersions, listings, orderCustomizationFileIntakes, orderCustomizationFileScanEvents,
  orderCustomizationRequirements, orderCustomizationVersions, orderLineCatalogLinks, orderProofDecisions,
  orderProofVersions, skus, spus, type DatabaseConnection, withTenant,
} from "@yummyai/database";
import type { Storage } from "@yummyai/storage";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { CUSTOMIZATION_FILE_SCAN_ENQUEUER, DATABASE_CONNECTION, ORDER_PII_VAULT, PRIVATE_STORAGE } from "../platform.tokens.js";
import { mapOrderCustomization } from "./order-customization-mapper.js";
import { OrderService } from "./order.service.js";

export interface CustomizationFileScanEnqueuer {
  enqueue(input: { intakeId: string; requestedBy: string; tenantId: string }): Promise<void>;
}

@Injectable()
export class OrderCustomizationService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(ORDER_PII_VAULT) private readonly vault: SecretVault,
    @Inject(PRIVATE_STORAGE) private readonly storage: Storage,
    @Inject(OrderService) private readonly orders: OrderService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Optional() @Inject(CUSTOMIZATION_FILE_SCAN_ENQUEUER) private readonly scanEnqueuer?: CustomizationFileScanEnqueuer,
  ) {}

  async initialize(context: TenantContext, orderId: string, rawInput: InitializeOrderCustomizationInput): Promise<OrderCustomizationSummaryView> {
    const input = InitializeOrderCustomizationInputSchema.parse(rawInput);
    const order = await this.orders.get(context, orderId);
    const line = order.lines.find((candidate) => candidate.id === input.orderLineId);
    if (!line) throw new NotFoundException("Order line not found");
    const details = await this.orders.fulfillmentDetails(context, orderId, "fulfillment");
    const sourceValues = details.protectedDetails?.customizations.find((entry) => entry.externalLineId === line.externalLineId)?.values ?? [];
    const catalog = await this.catalogSchema(context, input.orderLineId);
    const mapped = mapOrderCustomization(catalog.schema, sourceValues);
    const requirementId = createEntityId();
    const versionId = createEntityId();
    const protectedMapping = { values: mapped.values, fileReferences: mapped.fileReferences, unmappedSourceLabels: mapped.unmappedSourceLabels };
    const plaintext = stableStringify(protectedMapping);
    await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${input.orderLineId}:customization`}, 0))`);
      const [existing] = await tx.select({ id: orderCustomizationRequirements.id }).from(orderCustomizationRequirements)
        .where(eq(orderCustomizationRequirements.orderLineId, input.orderLineId)).limit(1);
      if (existing) return;
      const status = initialStatus(mapped.missingFieldKeys.length, mapped.fileReferences.length, input.fulfillmentPath);
      await tx.insert(orderCustomizationRequirements).values({
        id: requirementId, tenantId: context.tenantId, orderId, orderLineId: input.orderLineId,
        schemaVersion: catalog.schema.version, schemaSnapshot: catalog.schema, fulfillmentPath: input.fulfillmentPath, status,
        customerApprovalDueAt: input.customerApprovalDueAt ? new Date(input.customerApprovalDueAt) : undefined, createdBy: context.userId,
      });
      await tx.insert(orderCustomizationVersions).values({
        id: versionId, tenantId: context.tenantId, requirementId, versionNumber: 1,
        encryptedValues: this.vault.encrypt(plaintext), valuesChecksum: checksum(plaintext),
        mappedFieldKeys: mapped.mappedFieldKeys, missingFieldKeys: mapped.missingFieldKeys,
        fileFieldKeys: mapped.fileReferences.map((file) => file.fieldKey), completeness: mapped.completeness, createdBy: context.userId,
      });
    });
    const summary = await this.getByLine(context, input.orderLineId);
    await this.audit.record(context, { action: "order.customization.initialize", resourceType: "order_customization_requirement", resourceId: summary.id, result: "success", metadata: { orderId, orderLineId: input.orderLineId, schemaVersion: summary.schemaVersion, fulfillmentPath: summary.fulfillmentPath, completeness: summary.completeness } });
    return summary;
  }

  async remap(context: TenantContext, orderId: string, requirementId: string, rawInput: RemapOrderCustomizationInput): Promise<OrderCustomizationSummaryView> {
    const input = RemapOrderCustomizationInputSchema.parse(rawInput);
    const current = await this.get(context, requirementId);
    if (current.orderId !== orderId) throw new NotFoundException("Order customization requirement not found for order");
    const order = await this.orders.get(context, orderId);
    const line = order.lines.find((candidate) => candidate.id === current.orderLineId);
    if (!line) throw new NotFoundException("Order line not found");
    const details = await this.orders.fulfillmentDetails(context, orderId, "fulfillment");
    const sourceValues = details.protectedDetails?.customizations.find((entry) => entry.externalLineId === line.externalLineId)?.values ?? [];
    const record = await this.requireVersion(context, current.versionId);
    const mapped = mapOrderCustomization(record.requirement.schemaSnapshot, sourceValues);
    const protectedMapping = { values: mapped.values, fileReferences: mapped.fileReferences, unmappedSourceLabels: mapped.unmappedSourceLabels };
    const plaintext = stableStringify(protectedMapping);
    const valuesChecksum = checksum(plaintext);
    let created = false;
    await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${requirementId}:customization-version`}, 0))`);
      const [latest] = await tx.select().from(orderCustomizationVersions)
        .where(eq(orderCustomizationVersions.requirementId, requirementId))
        .orderBy(desc(orderCustomizationVersions.versionNumber)).limit(1);
      if (!latest) throw new NotFoundException("Order customization version not found");
      if (latest.versionNumber !== input.expectedVersionNumber) throw new ConflictException("Customization version changed; reload before remapping");
      if (latest.valuesChecksum === valuesChecksum) return;
      await tx.insert(orderCustomizationVersions).values({
        id: createEntityId(), tenantId: context.tenantId, requirementId, versionNumber: latest.versionNumber + 1,
        encryptedValues: this.vault.encrypt(plaintext), valuesChecksum,
        mappedFieldKeys: mapped.mappedFieldKeys, missingFieldKeys: mapped.missingFieldKeys,
        fileFieldKeys: mapped.fileReferences.map((file) => file.fieldKey), completeness: mapped.completeness, createdBy: context.userId,
      });
      await tx.update(orderCustomizationRequirements).set({
        status: initialStatus(mapped.missingFieldKeys.length, mapped.fileReferences.length, OrderFulfillmentPathSchema.parse(record.requirement.fulfillmentPath)),
        updatedAt: new Date(),
      }).where(eq(orderCustomizationRequirements.id, requirementId));
      created = true;
    });
    const summary = await this.get(context, requirementId);
    await this.audit.record(context, {
      action: "order.customization.remap", resourceType: "order_customization_requirement", resourceId: requirementId,
      result: "success", metadata: { orderId, created, versionNumber: summary.versionNumber, completeness: summary.completeness },
    });
    return summary;
  }

  async registerFile(context: TenantContext, versionId: string, rawInput: RegisterOrderCustomizationFileInput) {
    const input = RegisterOrderCustomizationFileInputSchema.parse(rawInput);
    const record = await this.requireVersion(context, versionId);
    const field = record.requirement.schemaSnapshot.fields.find((candidate) => candidate.key === input.fieldKey);
    if (!field || field.type !== "image") throw new UnprocessableEntityException("Customization file field is not present in the pinned schema");
    const expectedPrefix = `tenants/${context.tenantId}/quarantine/${input.checksumSha256}/`;
    if (!input.objectKey.startsWith(expectedPrefix)) throw new UnprocessableEntityException("Customization file must use the tenant quarantine prefix");
    const supported = (field.validation.allowedMediaTypes as string[]).includes(input.mediaType) && input.byteSize <= field.validation.maxBytes;
    const intakeId = createEntityId();
    const scanStatus = supported ? "pending" : "unsupported";
    await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${versionId}:${input.fieldKey}:files`}, 0))`);
      const [proof] = await tx.select({ id: orderProofVersions.id }).from(orderProofVersions)
        .where(eq(orderProofVersions.customizationVersionId, versionId)).limit(1);
      if (proof) throw new ConflictException("A proven customization version cannot accept additional files");
      const existingFiles = await tx.select({ scanStatus: orderCustomizationFileIntakes.scanStatus }).from(orderCustomizationFileIntakes).where(and(
        eq(orderCustomizationFileIntakes.customizationVersionId, versionId), eq(orderCustomizationFileIntakes.fieldKey, input.fieldKey),
      ));
      if (existingFiles.length >= 20) throw new ConflictException("Customization file intake limit reached");
      const activeCount = existingFiles.filter((entry) => !["unsupported", "infected", "failed"].includes(entry.scanStatus)).length;
      if (supported && activeCount >= field.validation.maxFiles) throw new ConflictException("Customization file field reached its pinned maximum");
      await tx.insert(orderCustomizationFileIntakes).values({
        id: intakeId, tenantId: context.tenantId, customizationVersionId: versionId, fieldKey: input.fieldKey,
        objectKey: input.objectKey, safeFileName: safeFileName(input.fieldKey, input.mediaType), mediaType: input.mediaType,
        byteSize: input.byteSize, checksumSha256: input.checksumSha256, scanStatus,
      });
      if (!supported) await tx.insert(orderCustomizationFileScanEvents).values({
        id: createEntityId(), tenantId: context.tenantId, intakeId, sequence: 1, result: "unsupported",
        engine: "schema-policy", signatureVersion: `customization-schema-${record.requirement.schemaVersion}`, scannedAt: new Date(),
      });
      await tx.update(orderCustomizationRequirements).set({ status: "quarantined", updatedAt: new Date() }).where(eq(orderCustomizationRequirements.id, record.requirement.id));
    });
    let effectiveScanStatus = scanStatus;
    if (supported && this.scanEnqueuer) {
      try {
        await this.scanEnqueuer.enqueue({ intakeId, requestedBy: context.userId, tenantId: context.tenantId });
      } catch {
        await this.recordScan(context, intakeId, {
          result: "failed", engine: "queue-dispatch", signatureVersion: "customization-file-scan-v1", scannedAt: new Date().toISOString(),
        });
        effectiveScanStatus = "failed";
      }
    }
    await this.audit.record(context, { action: "order.customization.file.register", resourceType: "order_customization_file", resourceId: intakeId, result: supported ? "success" : "failure", metadata: { fieldKey: input.fieldKey, mediaType: input.mediaType, byteSize: input.byteSize, scanStatus: effectiveScanStatus } });
    return this.requireFile(context, intakeId);
  }

  async registerFileForRequirement(context: TenantContext, orderId: string, requirementId: string, versionId: string, input: RegisterOrderCustomizationFileInput) {
    await this.assertVersionScope(context, orderId, requirementId, versionId);
    return this.registerFile(context, versionId, input);
  }

  async queueFileScan(context: TenantContext, orderId: string, requirementId: string, intakeId: string) {
    const file = await this.assertFileScope(context, orderId, requirementId, intakeId);
    if (!["pending", "failed"].includes(file.scanStatus)) throw new ConflictException("Customization file scan is already final");
    if (!this.scanEnqueuer) throw new ConflictException("Customization file scanning is not configured");
    await this.scanEnqueuer.enqueue({ intakeId, requestedBy: context.userId, tenantId: context.tenantId });
    await this.audit.record(context, { action: "order.customization.file.scan.queue", resourceType: "order_customization_file", resourceId: intakeId, result: "success", metadata: { previousStatus: file.scanStatus } });
    return this.requireFile(context, intakeId);
  }

  async recordScan(context: TenantContext, intakeId: string, rawInput: RecordCustomizationFileScanInput) {
    const input = RecordCustomizationFileScanInputSchema.parse(rawInput);
    await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${intakeId}:scan`}, 0))`);
      const [intake] = await tx.select().from(orderCustomizationFileIntakes).where(eq(orderCustomizationFileIntakes.id, intakeId)).limit(1);
      if (!intake) throw new NotFoundException("Customization file intake not found");
      if (intake.scanStatus === "promoted" || intake.scanStatus === "unsupported") throw new ConflictException("Customization file scan is already final");
      const [latest] = await tx.select({ sequence: orderCustomizationFileScanEvents.sequence }).from(orderCustomizationFileScanEvents)
        .where(eq(orderCustomizationFileScanEvents.intakeId, intakeId)).orderBy(desc(orderCustomizationFileScanEvents.sequence)).limit(1);
      await tx.insert(orderCustomizationFileScanEvents).values({
        id: createEntityId(), tenantId: context.tenantId, intakeId, sequence: (latest?.sequence ?? 0) + 1,
        result: input.result, engine: input.engine, signatureVersion: input.signatureVersion, scannedAt: new Date(input.scannedAt),
      });
      await tx.update(orderCustomizationFileIntakes).set({ scanStatus: input.result, updatedAt: new Date() }).where(eq(orderCustomizationFileIntakes.id, intakeId));
    });
    await this.audit.record(context, { action: "order.customization.file.scan", resourceType: "order_customization_file", resourceId: intakeId, result: input.result === "clean" ? "success" : "failure", metadata: { result: input.result, engine: input.engine, signatureVersion: input.signatureVersion } });
    return this.requireFile(context, intakeId);
  }

  async promoteFile(context: TenantContext, intakeId: string) {
    const file = await this.requireFile(context, intakeId);
    if (file.scanStatus !== "clean") throw new ConflictException("A clean malware scan is required before asset promotion");
    const stored = await this.storage.promoteQuarantineToAuthorized(context, {
      id: file.id, tenantId: context.tenantId, assetDomain: "quarantine", objectKey: file.objectKey,
      checksumSha256: file.checksumSha256, fileName: file.safeFileName, mediaType: file.mediaType,
    });
    const assetId = createEntityId();
    let authorizedAssetId = assetId;
    await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${stored.objectKey}:authorized-asset`}, 0))`);
      const [existing] = await tx.select({ id: assetFiles.id }).from(assetFiles).where(eq(assetFiles.objectKey, stored.objectKey)).limit(1);
      const targetAssetId = existing?.id ?? assetId;
      authorizedAssetId = targetAssetId;
      if (!existing) await tx.insert(assetFiles).values({
        id: targetAssetId, tenantId: context.tenantId, ownerUserId: context.userId, objectKey: stored.objectKey,
        assetDomain: "authorized", fileName: file.safeFileName, mediaType: file.mediaType, byteSize: file.byteSize,
        checksumSha256: file.checksumSha256, rightsStatus: "approved",
        rightsMetadata: { source: { kind: "customer_provided", reference: `order-customization:${file.customizationVersionId}` }, approvedAt: new Date().toISOString() },
      });
      await tx.update(orderCustomizationFileIntakes).set({ scanStatus: "promoted", authorizedAssetId: targetAssetId, updatedAt: new Date() }).where(and(eq(orderCustomizationFileIntakes.id, intakeId), eq(orderCustomizationFileIntakes.scanStatus, "clean")));
    });
    await this.refreshRequirementStatus(context, file.customizationVersionId);
    await this.audit.record(context, { action: "order.customization.file.promote", resourceType: "order_customization_file", resourceId: intakeId, result: "success", metadata: { authorizedAssetId } });
    return this.requireFile(context, intakeId);
  }

  async promoteFileForRequirement(context: TenantContext, orderId: string, requirementId: string, intakeId: string) {
    await this.assertFileScope(context, orderId, requirementId, intakeId);
    return this.promoteFile(context, intakeId);
  }

  async createProof(context: TenantContext, orderId: string, requirementId: string, rawInput: CreateOrderProofInput) {
    const input = CreateOrderProofInputSchema.parse(rawInput);
    const version = await this.requireVersion(context, input.customizationVersionId);
    if (version.requirement.id !== requirementId) throw new NotFoundException("Customization version not found for requirement");
    if (version.requirement.orderId !== orderId) throw new NotFoundException("Customization requirement not found for order");
    if (version.version.completeness !== 100) throw new ConflictException("Customization is incomplete");
    const files = await withTenant(this.database.db, context, (tx) => tx.select().from(orderCustomizationFileIntakes).where(eq(orderCustomizationFileIntakes.customizationVersionId, version.version.id)));
    if (version.version.fileFieldKeys.some((fieldKey) => !files.some((file) => file.fieldKey === fieldKey && file.scanStatus === "promoted"))) {
      throw new ConflictException("All customer files must be scanned and promoted before proof creation");
    }
    if (version.requirement.fulfillmentPath !== "template_ready") {
      if (!input.designVersionId) throw new ConflictException("This fulfillment path requires an approved design version");
      const [design] = await withTenant(this.database.db, context, (tx) => tx.select().from(designVersions).where(eq(designVersions.id, input.designVersionId!)).limit(1));
      if (!design || design.status !== "approved") throw new ConflictException("Proof requires an approved design version");
    }
    const proofId = createEntityId();
    await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${version.requirement.orderLineId}:proof`}, 0))`);
      const [latest] = await tx.select({ versionNumber: orderProofVersions.versionNumber }).from(orderProofVersions)
        .where(eq(orderProofVersions.orderLineId, version.requirement.orderLineId)).orderBy(desc(orderProofVersions.versionNumber)).limit(1);
      await tx.insert(orderProofVersions).values({
        id: proofId, tenantId: context.tenantId, orderId: version.requirement.orderId, orderLineId: version.requirement.orderLineId,
        customizationVersionId: version.version.id, designVersionId: input.designVersionId,
        versionNumber: (latest?.versionNumber ?? 0) + 1,
        dueAt: input.dueAt ? new Date(input.dueAt) : version.requirement.customerApprovalDueAt, createdBy: context.userId,
      });
      await tx.update(orderCustomizationRequirements).set({
        status: version.requirement.fulfillmentPath === "customer_approval_required" ? "awaiting_customer" : "approved", updatedAt: new Date(),
      }).where(eq(orderCustomizationRequirements.id, requirementId));
    });
    await this.audit.record(context, { action: "order.proof.create", resourceType: "order_proof_version", resourceId: proofId, result: "success", metadata: { requirementId, customizationVersionId: input.customizationVersionId, designVersionId: input.designVersionId } });
    return this.requireProof(context, proofId);
  }

  async recordDecision(context: TenantContext, orderId: string, proofId: string, rawInput: RecordCustomerProofDecisionInput) {
    const input = RecordCustomerProofDecisionInputSchema.parse(rawInput);
    const proof = await this.requireProof(context, proofId);
    if (proof.requirement.orderId !== orderId) throw new NotFoundException("Order proof version not found for order");
    if (proof.requirement.fulfillmentPath !== "customer_approval_required") throw new ConflictException("Proof does not require customer approval");
    if (proof.proof.dueAt && proof.proof.dueAt < new Date()) throw new ConflictException("Customer proof deadline has expired");
    await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${proofId}:decision`}, 0))`);
      const [final] = await tx.select().from(orderProofDecisions).where(eq(orderProofDecisions.proofVersionId, proofId)).orderBy(desc(orderProofDecisions.occurredAt)).limit(1);
      if (final) {
        if (final.externalDecisionId !== input.externalDecisionId || final.decision !== input.decision || final.reasonCode !== (input.reasonCode ?? null)) {
          throw new ConflictException("Customer proof already has a different final decision");
        }
        return;
      }
      await tx.insert(orderProofDecisions).values({
        id: createEntityId(), tenantId: context.tenantId, proofVersionId: proofId, decision: input.decision,
        externalDecisionId: input.externalDecisionId, reasonCode: input.reasonCode, actorUserId: context.userId,
      });
      await tx.update(orderCustomizationRequirements).set({ status: input.decision, updatedAt: new Date() }).where(eq(orderCustomizationRequirements.id, proof.requirement.id));
    });
    await this.audit.record(context, { action: `order.proof.${input.decision}`, resourceType: "order_proof_version", resourceId: proofId, result: "success", metadata: { externalDecisionId: input.externalDecisionId, reasonCode: input.reasonCode } });
    return this.get(context, proof.requirement.id);
  }

  async expireProof(context: TenantContext, proofId: string, now = new Date()) {
    const proof = await this.requireProof(context, proofId);
    if (!proof.proof.dueAt || proof.proof.dueAt > now) throw new ConflictException("Customer proof deadline has not expired");
    const externalDecisionId = `timeout:${proofId}`;
    let created = false;
    await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${proofId}:decision`}, 0))`);
      const [existing] = await tx.select({ id: orderProofDecisions.id }).from(orderProofDecisions).where(eq(orderProofDecisions.proofVersionId, proofId)).limit(1);
      if (existing) return;
      await tx.insert(orderProofDecisions).values({ id: createEntityId(), tenantId: context.tenantId, proofVersionId: proofId, decision: "timed_out", externalDecisionId, reasonCode: "CUSTOMER_APPROVAL_TIMEOUT" });
      await tx.update(orderCustomizationRequirements).set({ status: "rejected", updatedAt: now }).where(eq(orderCustomizationRequirements.id, proof.requirement.id));
      created = true;
    });
    if (created) await this.orders.openException(context, proof.requirement.orderId, {
      category: "customer_timeout", code: "CUSTOMER_APPROVAL_TIMEOUT", message: "Customer proof approval deadline expired",
      idempotencyKey: `proof-timeout:${proofId}`,
    });
    await this.audit.record(context, { action: "order.proof.timeout", resourceType: "order_proof_version", resourceId: proofId, result: "failure", metadata: { createdException: created } });
    return this.get(context, proof.requirement.id);
  }

  async get(context: TenantContext, requirementId: string) {
    const [requirement] = await withTenant(this.database.db, context, (tx) => tx.select().from(orderCustomizationRequirements).where(eq(orderCustomizationRequirements.id, requirementId)).limit(1));
    if (!requirement) throw new NotFoundException("Order customization requirement not found");
    const [version] = await withTenant(this.database.db, context, (tx) => tx.select().from(orderCustomizationVersions).where(eq(orderCustomizationVersions.requirementId, requirementId)).orderBy(desc(orderCustomizationVersions.versionNumber)).limit(1));
    if (!version) throw new NotFoundException("Order customization version not found");
    return toSummary(requirement, version);
  }

  async list(context: TenantContext, orderId?: string): Promise<OrderCustomizationSummaryView[]> {
    const requirements = await withTenant(this.database.db, context, (tx) => tx.select().from(orderCustomizationRequirements)
      .where(orderId ? eq(orderCustomizationRequirements.orderId, orderId) : undefined)
      .orderBy(desc(orderCustomizationRequirements.updatedAt), desc(orderCustomizationRequirements.id))
      .limit(500));
    if (requirements.length === 0) return [];
    const versions = await withTenant(this.database.db, context, (tx) => tx.select().from(orderCustomizationVersions)
      .where(inArray(orderCustomizationVersions.requirementId, requirements.map((requirement) => requirement.id)))
      .orderBy(desc(orderCustomizationVersions.versionNumber)));
    const latest = new Map<string, typeof orderCustomizationVersions.$inferSelect>();
    for (const version of versions) if (!latest.has(version.requirementId)) latest.set(version.requirementId, version);
    return requirements.flatMap((requirement) => {
      const version = latest.get(requirement.id);
      return version ? [toSummary(requirement, version)] : [];
    });
  }

  private async getByLine(context: TenantContext, orderLineId: string) {
    const [requirement] = await withTenant(this.database.db, context, (tx) => tx.select({ id: orderCustomizationRequirements.id }).from(orderCustomizationRequirements).where(eq(orderCustomizationRequirements.orderLineId, orderLineId)).limit(1));
    if (!requirement) throw new NotFoundException("Order customization requirement not found");
    return this.get(context, requirement.id);
  }

  private async catalogSchema(context: TenantContext, orderLineId: string) {
    const [link] = await withTenant(this.database.db, context, (tx) => tx.select().from(orderLineCatalogLinks).where(eq(orderLineCatalogLinks.orderLineId, orderLineId)).limit(1));
    if (!link) throw new ConflictException("Order line must be linked to a local catalog version before customization mapping");
    if (link.skuId) {
      const [row] = await withTenant(this.database.db, context, (tx) => tx.select({ schema: spus.customization }).from(skus).innerJoin(spus, eq(skus.spuId, spus.id)).where(eq(skus.id, link.skuId!)).limit(1));
      if (row) return row;
    }
    if (link.listingId) {
      const [row] = await withTenant(this.database.db, context, (tx) => tx.select({ schema: spus.customization }).from(listings).innerJoin(spus, eq(listings.spuId, spus.id)).where(eq(listings.id, link.listingId!)).limit(1));
      if (row) return row;
    }
    throw new ConflictException("Pinned catalog link has no customization schema");
  }

  private async requireVersion(context: TenantContext, versionId: string) {
    const [row] = await withTenant(this.database.db, context, (tx) => tx.select({ version: orderCustomizationVersions, requirement: orderCustomizationRequirements })
      .from(orderCustomizationVersions).innerJoin(orderCustomizationRequirements, eq(orderCustomizationVersions.requirementId, orderCustomizationRequirements.id))
      .where(eq(orderCustomizationVersions.id, versionId)).limit(1));
    if (!row) throw new NotFoundException("Order customization version not found");
    return row;
  }

  private async assertVersionScope(context: TenantContext, orderId: string, requirementId: string, versionId: string) {
    const row = await this.requireVersion(context, versionId);
    if (row.requirement.id !== requirementId || row.requirement.orderId !== orderId) throw new NotFoundException("Customization version not found for order requirement");
    return row;
  }

  private async assertFileScope(context: TenantContext, orderId: string, requirementId: string, intakeId: string) {
    const file = await this.requireFile(context, intakeId);
    await this.assertVersionScope(context, orderId, requirementId, file.customizationVersionId);
    return file;
  }

  private async requireFile(context: TenantContext, intakeId: string) {
    const [row] = await withTenant(this.database.db, context, (tx) => tx.select().from(orderCustomizationFileIntakes).where(eq(orderCustomizationFileIntakes.id, intakeId)).limit(1));
    if (!row) throw new NotFoundException("Customization file intake not found");
    return row;
  }

  private async requireProof(context: TenantContext, proofId: string) {
    const [row] = await withTenant(this.database.db, context, (tx) => tx.select({ proof: orderProofVersions, version: orderCustomizationVersions, requirement: orderCustomizationRequirements })
      .from(orderProofVersions)
      .innerJoin(orderCustomizationVersions, eq(orderProofVersions.customizationVersionId, orderCustomizationVersions.id))
      .innerJoin(orderCustomizationRequirements, eq(orderCustomizationVersions.requirementId, orderCustomizationRequirements.id))
      .where(eq(orderProofVersions.id, proofId)).limit(1));
    if (!row) throw new NotFoundException("Order proof version not found");
    return row;
  }

  private async refreshRequirementStatus(context: TenantContext, versionId: string) {
    const record = await this.requireVersion(context, versionId);
    const files = await withTenant(this.database.db, context, (tx) => tx.select().from(orderCustomizationFileIntakes).where(eq(orderCustomizationFileIntakes.customizationVersionId, versionId)));
    const completeFiles = record.version.fileFieldKeys.every((fieldKey) => files.some((file) => file.fieldKey === fieldKey && file.scanStatus === "promoted"));
    const status = record.version.missingFieldKeys.length > 0
      ? "incomplete"
      : !completeFiles ? "quarantined" : record.requirement.fulfillmentPath === "template_ready" ? "ready" : "awaiting_design";
    await withTenant(this.database.db, context, (tx) => tx.update(orderCustomizationRequirements).set({ status, updatedAt: new Date() }).where(eq(orderCustomizationRequirements.id, record.requirement.id)));
  }
}

function initialStatus(missingCount: number, fileCount: number, path: InitializeOrderCustomizationInput["fulfillmentPath"]) {
  if (missingCount > 0) return "incomplete" as const;
  if (fileCount > 0) return "quarantined" as const;
  return path === "template_ready" ? "ready" as const : "awaiting_design" as const;
}

function toSummary(requirement: typeof orderCustomizationRequirements.$inferSelect, version: typeof orderCustomizationVersions.$inferSelect) {
  return OrderCustomizationSummaryViewSchema.parse({
    id: requirement.id, orderId: requirement.orderId, orderLineId: requirement.orderLineId,
    schemaVersion: requirement.schemaVersion, fulfillmentPath: requirement.fulfillmentPath, status: requirement.status,
    versionId: version.id, versionNumber: version.versionNumber, completeness: version.completeness,
    mappedFieldKeys: version.mappedFieldKeys, missingFieldKeys: version.missingFieldKeys, fileFieldKeys: version.fileFieldKeys,
    customerApprovalDueAt: requirement.customerApprovalDueAt?.toISOString() ?? null,
    createdAt: requirement.createdAt.toISOString(), updatedAt: requirement.updatedAt.toISOString(),
  });
}

function safeFileName(fieldKey: string, mediaType: string) {
  const extension = ({ "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" } as Record<string, string>)[mediaType] ?? ".bin";
  return `${fieldKey}${extension}`;
}

function checksum(value: string) { return createHash("sha256").update(value).digest("hex"); }
function stableStringify(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`; return JSON.stringify(value) ?? "null"; }
