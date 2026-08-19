import { ConflictException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import {
  CreateDesignTaskInputSchema,
  CreateCreativeDesignSkuBindingsInputSchema,
  ReviewDesignVersionInputSchema,
  UploadDesignVersionInputSchema,
  createEntityId,
  type CreateDesignTaskInput,
  type CreateCreativeDesignSkuBindingsInput,
  type DesignFileRole,
  type DesignTaskStatus,
  type DesignVersionStatus,
  type ReviewDesignVersionInput,
  type RightsSource,
  type TenantContext,
  type UploadDesignVersionInput,
} from "@yummyai/contracts";
import {
  assetFiles,
  canvasPrintSpecVersions,
  creativeDesignSkuBindings,
  creativeDesignVersionAssets,
  creativeDesignVersions,
  designTasks,
  designVersionFiles,
  designVersions,
  skus,
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import type { AssetDomain, Storage } from "@yummyai/storage";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, DESIGN_REPOSITORY, PRIVATE_STORAGE } from "../platform.tokens.js";
import { assertSkuSpecCompatible } from "./canvas-print-spec-policy.js";

export interface DesignAssetRecord {
  id: string;
  tenantId: string;
  domain: AssetDomain;
  objectKey: string;
  fileName: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  version: number;
  rightsSource?: RightsSource;
  rightsApprovedAt?: Date;
}

export interface DesignVersionFileRecord {
  id: string;
  role: DesignFileRole;
  asset: DesignAssetRecord;
}

export interface DesignVersionRecord {
  id: string;
  tenantId: string;
  taskId: string;
  versionNumber: number;
  status: DesignVersionStatus;
  changeNote?: string;
  rejectionReason?: string;
  files: DesignVersionFileRecord[];
  createdAt: Date;
}

export interface DesignTaskRecord {
  id: string;
  tenantId: string;
  skuId: string;
  title: string;
  brief: string;
  status: DesignTaskStatus;
  primaryVersionId?: string;
  dueAt?: Date;
}

export interface ApprovedCreativeBindingRecord {
  id: string;
  creativeDesignVersionId: string;
  skuId: string;
  printSpecVersionId: string;
  designTaskId: string;
  designVersionId: string;
}

export interface DesignRepository {
  createTask(context: TenantContext, input: CreateDesignTaskInput): Promise<DesignTaskRecord>;
  getTask(context: TenantContext, id: string): Promise<DesignTaskRecord | undefined>;
  listTasks(context: TenantContext): Promise<DesignTaskRecord[]>;
  createVersion(context: TenantContext, taskId: string, input: UploadDesignVersionInput): Promise<DesignVersionRecord>;
  getVersion(context: TenantContext, id: string): Promise<DesignVersionRecord | undefined>;
  listVersions(context: TenantContext, taskId: string): Promise<DesignVersionRecord[]>;
  reviewVersion(context: TenantContext, id: string, input: ReviewDesignVersionInput): Promise<DesignVersionRecord>;
  setPrimaryVersion(context: TenantContext, taskId: string, versionId: string): Promise<DesignTaskRecord>;
  getAsset(context: TenantContext, id: string): Promise<DesignAssetRecord | undefined>;
  approveAssetRights(context: TenantContext, id: string, source: RightsSource): Promise<DesignAssetRecord>;
  promoteAsset(context: TenantContext, asset: DesignAssetRecord): Promise<DesignAssetRecord>;
  signAsset(context: TenantContext, asset: DesignAssetRecord): Promise<string>;
  promoteApprovedCreativeBindings(
    context: TenantContext,
    creativeDesignVersionId: string,
    input: CreateCreativeDesignSkuBindingsInput,
  ): Promise<ApprovedCreativeBindingRecord[]>;
}

export class RightsApprovalRequiredError extends Error {
  constructor() { super("Asset rights must be approved before promotion"); this.name = "RightsApprovalRequiredError"; }
}

export class ResearchAssetPromotionError extends Error {
  constructor() { super("Competitor research assets cannot be promoted to the authorized domain"); this.name = "ResearchAssetPromotionError"; }
}

export class AuthorizedDesignAssetRequiredError extends Error {
  constructor() { super("Design versions require rights-approved authorized assets or order-private customer assets"); this.name = "AuthorizedDesignAssetRequiredError"; }
}

export function assertPromotableToAuthorized(input: { sourceDomain: AssetDomain; rightsSource?: RightsSource; rightsApprovedAt?: Date }): void {
  if (!input.rightsSource || !input.rightsApprovedAt) throw new RightsApprovalRequiredError();
  if (input.sourceDomain === "research" && input.rightsSource.kind === "competitor") throw new ResearchAssetPromotionError();
}

@Injectable()
export class DesignService {
  constructor(
    @Inject(DESIGN_REPOSITORY) private readonly repository: DesignRepository,
    @Optional() @Inject(AuditService) private readonly audit?: AuditService,
  ) {}

  async createTask(context: TenantContext, rawInput: CreateDesignTaskInput) {
    const task = await this.repository.createTask(context, CreateDesignTaskInputSchema.parse(rawInput));
    await this.record(context, "design.task.create", "design_task", task.id);
    return task;
  }

  listTasks(context: TenantContext) { return this.repository.listTasks(context); }
  listVersions(context: TenantContext, taskId: string) { return this.repository.listVersions(context, taskId); }

  async uploadVersion(context: TenantContext, taskId: string, rawInput: UploadDesignVersionInput) {
    if (!await this.repository.getTask(context, taskId)) throw new NotFoundException("Design task not found");
    const input = UploadDesignVersionInputSchema.parse(rawInput);
    for (const file of input.files) {
      const asset = await this.repository.getAsset(context, file.assetId);
      if (!asset) throw new NotFoundException("Asset not found");
      if (asset.domain !== "authorized" || !asset.rightsSource || !asset.rightsApprovedAt) throw new AuthorizedDesignAssetRequiredError();
    }
    const version = await this.repository.createVersion(context, taskId, input);
    await this.record(context, "design.version.create", "design_version", version.id, { versionNumber: version.versionNumber });
    return version;
  }

  async reviewVersion(context: TenantContext, versionId: string, rawInput: ReviewDesignVersionInput) {
    const input = ReviewDesignVersionInputSchema.parse(rawInput);
    const current = await this.repository.getVersion(context, versionId);
    if (!current) throw new NotFoundException("Design version not found");
    if (current.status !== "pending_review") throw new ConflictException("Only pending design versions can be reviewed");
    if (input.decision === "approve" && current.files.some(({ asset }) => !isReviewableDesignAsset(asset))) {
      throw new AuthorizedDesignAssetRequiredError();
    }
    const version = await this.repository.reviewVersion(context, versionId, input);
    await this.record(context, `design.version.${input.decision}`, "design_version", version.id, { rejectionReason: input.rejectionReason });
    return version;
  }

  async setPrimaryVersion(context: TenantContext, taskId: string, versionId: string) {
    const version = await this.repository.getVersion(context, versionId);
    if (!version || version.taskId !== taskId) throw new NotFoundException("Design version not found for this task");
    if (version.status !== "approved") throw new ConflictException("Only approved design versions can be primary");
    const task = await this.repository.setPrimaryVersion(context, taskId, versionId);
    await this.record(context, "design.version.primary", "design_task", task.id, { versionId });
    return task;
  }

  async promoteApprovedCreativeBindings(
    context: TenantContext,
    creativeDesignVersionId: string,
    rawInput: CreateCreativeDesignSkuBindingsInput,
  ) {
    const input = CreateCreativeDesignSkuBindingsInputSchema.parse(rawInput);
    const bindings = await this.repository.promoteApprovedCreativeBindings(context, creativeDesignVersionId, input);
    for (const binding of bindings) {
      await this.record(context, "design.creative.promote", "design_version", binding.designVersionId, {
        creativeDesignVersionId,
        designTaskId: binding.designTaskId,
        skuId: binding.skuId,
        printSpecVersionId: binding.printSpecVersionId,
      });
    }
    return bindings;
  }

  async approveAssetRights(context: TenantContext, assetId: string, source: RightsSource) {
    if (!await this.repository.getAsset(context, assetId)) throw new NotFoundException("Asset not found");
    const asset = await this.repository.approveAssetRights(context, assetId, source);
    await this.record(context, "asset.rights.approve", "asset_file", asset.id, { rightsKind: source.kind, reference: source.reference });
    return asset;
  }

  async promoteAsset(context: TenantContext, assetId: string) {
    const asset = await this.repository.getAsset(context, assetId);
    if (!asset) throw new NotFoundException("Asset not found");
    assertPromotableToAuthorized({ sourceDomain: asset.domain, rightsSource: asset.rightsSource, rightsApprovedAt: asset.rightsApprovedAt });
    if (asset.domain === "authorized") return asset;
    const promoted = await this.repository.promoteAsset(context, asset);
    await this.record(context, "asset.promote", "asset_file", promoted.id, { sourceAssetId: asset.id });
    return promoted;
  }

  async signVersionFile(context: TenantContext, versionId: string, fileId: string) {
    const version = await this.repository.getVersion(context, versionId);
    const file = version?.files.find((candidate) => candidate.id === fileId);
    if (!file) throw new NotFoundException("Design version file not found");
    if (!isReviewableDesignAsset(file.asset)) throw new AuthorizedDesignAssetRequiredError();
    return { url: await this.repository.signAsset(context, file.asset), expiresInSeconds: 600 };
  }

  private async record(context: TenantContext, action: string, resourceType: string, resourceId: string, metadata?: Record<string, unknown>) {
    await this.audit?.record(context, { action, resourceType, resourceId, result: "success", metadata });
  }
}

@Injectable()
export class DrizzleDesignRepository implements DesignRepository {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(PRIVATE_STORAGE) private readonly storage: Storage,
  ) {}

  async createTask(context: TenantContext, rawInput: CreateDesignTaskInput) {
    const input = CreateDesignTaskInputSchema.parse(rawInput);
    const [row] = await withTenant(this.database.db, context, (tx) => tx.insert(designTasks).values({
      id: createEntityId(), tenantId: context.tenantId, skuId: input.skuId, title: input.title, brief: input.brief,
      dueAt: input.dueAt ? new Date(input.dueAt) : undefined, createdBy: context.userId,
    }).returning());
    return mapTask(row!);
  }

  async promoteApprovedCreativeBindings(
    context: TenantContext,
    creativeDesignVersionId: string,
    input: CreateCreativeDesignSkuBindingsInput,
  ) {
    return withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${creativeDesignVersionId}:creative-promotion`}, 0))`);
      const [creative] = await tx.select().from(creativeDesignVersions)
        .where(eq(creativeDesignVersions.id, creativeDesignVersionId)).limit(1);
      if (!creative) throw new NotFoundException("Creative design version not found");
      if (creative.status !== "approved" || !creative.reviewedBy || !creative.reviewedAt) {
        throw new ConflictException("Only reviewed, approved creative design versions can be promoted");
      }

      const skuIds = [...new Set(input.bindings.map((binding) => binding.skuId))];
      const specIds = [...new Set(input.bindings.map((binding) => binding.printSpecVersionId))];
      const [skuRows, specRows, variantRows] = await Promise.all([
        tx.select().from(skus).where(inArray(skus.id, skuIds)),
        tx.select().from(canvasPrintSpecVersions).where(inArray(canvasPrintSpecVersions.id, specIds)),
        tx.select().from(creativeDesignVersionAssets).where(and(
          eq(creativeDesignVersionAssets.creativeDesignVersionId, creativeDesignVersionId),
          inArray(creativeDesignVersionAssets.printSpecVersionId, specIds),
        )),
      ]);
      if (skuRows.length !== skuIds.length) throw new NotFoundException("One or more SKUs were not found");
      if (specRows.length !== specIds.length) throw new NotFoundException("One or more print specification versions were not found");
      const assetRows = variantRows.length ? await tx.select().from(assetFiles)
        .where(inArray(assetFiles.id, variantRows.map((variant) => variant.assetId))) : [];
      const skuById = new Map(skuRows.map((row) => [row.id, row]));
      const specById = new Map(specRows.map((row) => [row.id, row]));
      const variantBySpec = new Map(variantRows.map((row) => [row.printSpecVersionId!, row]));
      const assetById = new Map(assetRows.map((row) => [row.id, row]));

      for (const binding of input.bindings) {
        const sku = skuById.get(binding.skuId)!;
        const spec = specById.get(binding.printSpecVersionId)!;
        const variant = variantBySpec.get(binding.printSpecVersionId);
        if (sku.status === "archived") throw new ConflictException(`SKU ${sku.code} is archived`);
        if (spec.status !== "approved") throw new ConflictException(`Print specification ${spec.name} is not approved`);
        if (!variant) throw new ConflictException(`Creative design lacks variant for ${spec.name}`);
        const asset = assetById.get(variant.assetId);
        const sourceKind = (asset?.rightsMetadata as { source?: { kind?: string } } | undefined)?.source?.kind;
        if (!asset || asset.assetDomain !== "authorized" || asset.rightsStatus !== "approved" || sourceKind === "customer_provided" || sourceKind === "competitor") {
          throw new AuthorizedDesignAssetRequiredError();
        }
        assertSkuSpecCompatible(sku.code, sku.attributes, spec);
      }

      const results: ApprovedCreativeBindingRecord[] = [];
      for (const binding of input.bindings) {
        const [existing] = await tx.select().from(creativeDesignSkuBindings).where(and(
          eq(creativeDesignSkuBindings.creativeDesignVersionId, creativeDesignVersionId),
          eq(creativeDesignSkuBindings.skuId, binding.skuId),
          eq(creativeDesignSkuBindings.printSpecVersionId, binding.printSpecVersionId),
        )).limit(1);
        if (existing) { results.push(existing); continue; }
        const variant = variantBySpec.get(binding.printSpecVersionId)!;
        const designTaskId = createEntityId();
        const designVersionId = createEntityId();
        await tx.insert(designTasks).values({
          id: designTaskId,
          tenantId: context.tenantId,
          skuId: binding.skuId,
          title: creative.name,
          brief: `Approved creative design ${creative.id} promoted for canvas print specification ${binding.printSpecVersionId}.`,
          status: "approved",
          primaryVersionId: designVersionId,
          createdBy: context.userId,
        });
        await tx.insert(designVersions).values({
          id: designVersionId,
          tenantId: context.tenantId,
          taskId: designTaskId,
          versionNumber: 1,
          status: "approved",
          changeNote: `Promoted from reviewed creative design ${creative.id}`,
          createdBy: context.userId,
          reviewedBy: creative.reviewedBy,
          reviewedAt: creative.reviewedAt,
        });
        await tx.insert(designVersionFiles).values({
          id: createEntityId(), tenantId: context.tenantId, versionId: designVersionId,
          assetFileId: variant.assetId, role: "production",
        });
        const [created] = await tx.insert(creativeDesignSkuBindings).values({
          id: createEntityId(), tenantId: context.tenantId, creativeDesignVersionId,
          skuId: binding.skuId, printSpecVersionId: binding.printSpecVersionId,
          designTaskId, designVersionId, createdBy: context.userId,
        }).returning();
        results.push(created!);
      }
      return results;
    });
  }

  async getTask(context: TenantContext, id: string) {
    const [row] = await withTenant(this.database.db, context, (tx) => tx.select().from(designTasks).where(eq(designTasks.id, id)).limit(1));
    return row ? mapTask(row) : undefined;
  }

  async listTasks(context: TenantContext) {
    const rows = await withTenant(this.database.db, context, (tx) => tx.select().from(designTasks).orderBy(desc(designTasks.updatedAt)));
    return rows.map(mapTask);
  }

  async createVersion(context: TenantContext, taskId: string, rawInput: UploadDesignVersionInput) {
    const input = UploadDesignVersionInputSchema.parse(rawInput);
    const versionId = createEntityId();
    await withTenant(this.database.db, context, async (tx) => {
      const assetIds = [...new Set(input.files.map(({ assetId }) => assetId))];
      const [orderFile] = await tx.select({ id: assetFiles.id }).from(assetFiles)
        .where(and(inArray(assetFiles.id, assetIds), eq(assetFiles.assetDomain, "order"))).limit(1);
      if (orderFile) authorize(context, Permission.OrderPiiRead);
      const [latest] = await tx.select({ number: designVersions.versionNumber }).from(designVersions)
        .where(and(eq(designVersions.tenantId, context.tenantId), eq(designVersions.taskId, taskId)))
        .orderBy(desc(designVersions.versionNumber)).limit(1);
      await tx.insert(designVersions).values({
        id: versionId, tenantId: context.tenantId, taskId, versionNumber: (latest?.number ?? 0) + 1,
        changeNote: input.changeNote, createdBy: context.userId,
      });
      await tx.insert(designVersionFiles).values(input.files.map((file) => ({
        id: createEntityId(), tenantId: context.tenantId, versionId, assetFileId: file.assetId, role: file.role,
      })));
      await tx.update(designTasks).set({ status: "in_review", updatedAt: new Date() }).where(eq(designTasks.id, taskId));
    });
    return (await this.getVersion(context, versionId))!;
  }

  async getVersion(context: TenantContext, id: string) {
    const [row] = await withTenant(this.database.db, context, (tx) => tx.select().from(designVersions).where(eq(designVersions.id, id)).limit(1));
    if (!row) return undefined;
    return this.hydrateVersion(context, row);
  }

  async listVersions(context: TenantContext, taskId: string) {
    const rows = await withTenant(this.database.db, context, (tx) => tx.select().from(designVersions)
      .where(eq(designVersions.taskId, taskId)).orderBy(desc(designVersions.versionNumber)));
    return Promise.all(rows.map((row) => this.hydrateVersion(context, row)));
  }

  async reviewVersion(context: TenantContext, id: string, input: ReviewDesignVersionInput) {
    await withTenant(this.database.db, context, async (tx) => {
      const [orderFile] = await tx.select({ id: assetFiles.id }).from(designVersionFiles)
        .innerJoin(assetFiles, eq(designVersionFiles.assetFileId, assetFiles.id))
        .where(and(eq(designVersionFiles.versionId, id), eq(assetFiles.assetDomain, "order"))).limit(1);
      if (orderFile) authorize(context, Permission.OrderPiiRead);
      await tx.update(designVersions).set({
        status: input.decision === "approve" ? "approved" : "rejected",
        rejectionReason: input.decision === "reject" ? input.rejectionReason : null,
        reviewedBy: context.userId, reviewedAt: new Date(),
      }).where(and(eq(designVersions.id, id), eq(designVersions.status, "pending_review")));
    });
    return (await this.getVersion(context, id))!;
  }

  async setPrimaryVersion(context: TenantContext, taskId: string, versionId: string) {
    const [row] = await withTenant(this.database.db, context, async (tx) => {
      const [orderFile] = await tx.select({ id: assetFiles.id }).from(designVersionFiles)
        .innerJoin(assetFiles, eq(designVersionFiles.assetFileId, assetFiles.id))
        .where(and(eq(designVersionFiles.versionId, versionId), eq(assetFiles.assetDomain, "order"))).limit(1);
      if (orderFile) authorize(context, Permission.OrderPiiRead);
      return tx.update(designTasks)
        .set({ primaryVersionId: versionId, status: "approved", updatedAt: new Date() })
        .where(eq(designTasks.id, taskId)).returning();
    });
    if (!row) throw new NotFoundException("Design task not found");
    return mapTask(row);
  }

  async getAsset(context: TenantContext, id: string) {
    const [row] = await withTenant(this.database.db, context, (tx) => tx.select().from(assetFiles).where(eq(assetFiles.id, id)).limit(1));
    if (row?.assetDomain === "order") authorize(context, Permission.OrderPiiRead);
    return row ? mapAsset(row) : undefined;
  }

  async approveAssetRights(context: TenantContext, id: string, source: RightsSource) {
    const [existing] = await withTenant(this.database.db, context, (tx) => tx.select({
      domain: assetFiles.assetDomain,
      rightsMetadata: assetFiles.rightsMetadata,
    })
      .from(assetFiles).where(eq(assetFiles.id, id)).limit(1));
    if (existing?.domain === "order") {
      authorize(context, Permission.OrderPiiRead);
      if (source.kind !== "customer_provided") throw new ConflictException("Order-private assets require customer-provided rights evidence");
      const pinned = (existing.rightsMetadata as { source?: { reference?: string } }).source?.reference;
      if (!pinned || source.reference !== pinned) {
        throw new ConflictException("Order-private asset rights evidence must retain its pinned customization reference");
      }
    }
    const [row] = await withTenant(this.database.db, context, (tx) => tx.update(assetFiles).set({
      rightsStatus: "approved", rightsMetadata: { source, approvedAt: new Date().toISOString(), approvedBy: context.userId },
    }).where(eq(assetFiles.id, id)).returning());
    if (!row) throw new NotFoundException("Asset not found");
    return mapAsset(row);
  }

  async promoteAsset(context: TenantContext, asset: DesignAssetRecord) {
    const stored = await this.storage.promoteToAuthorized(context, {
      id: asset.id, tenantId: asset.tenantId, assetDomain: asset.domain, objectKey: asset.objectKey,
      checksumSha256: asset.sha256, fileName: asset.fileName, mediaType: asset.mediaType,
    });
    const [row] = await withTenant(this.database.db, context, async (tx) => {
      const [existing] = await tx.select().from(assetFiles).where(eq(assetFiles.objectKey, stored.objectKey)).limit(1);
      if (existing) return [existing];
      return tx.insert(assetFiles).values({
        id: createEntityId(), tenantId: context.tenantId, ownerUserId: context.userId, objectKey: stored.objectKey,
        assetDomain: "authorized", fileName: asset.fileName, mediaType: asset.mediaType, byteSize: asset.byteSize,
        checksumSha256: asset.sha256, rightsStatus: "approved",
        rightsMetadata: { source: asset.rightsSource, approvedAt: asset.rightsApprovedAt!.toISOString(), promotedFrom: asset.id },
        version: asset.version + 1,
      }).returning();
    });
    return mapAsset(row!);
  }

  signAsset(context: TenantContext, asset: DesignAssetRecord) {
    const requiredDomain = asset.domain === "order" ? "order" : "authorized";
    return this.storage.signRead(context, { id: asset.id, tenantId: asset.tenantId, assetDomain: asset.domain, objectKey: asset.objectKey }, { requiredDomain });
  }

  private async hydrateVersion(context: TenantContext, row: typeof designVersions.$inferSelect): Promise<DesignVersionRecord> {
    const fileRows = await withTenant(this.database.db, context, (tx) => tx.select({ file: designVersionFiles, asset: assetFiles })
      .from(designVersionFiles).innerJoin(assetFiles, eq(designVersionFiles.assetFileId, assetFiles.id))
      .where(eq(designVersionFiles.versionId, row.id)).orderBy(asc(designVersionFiles.role)));
    if (fileRows.some(({ asset }) => asset.assetDomain === "order")) authorize(context, Permission.OrderPiiRead);
    return {
      id: row.id, tenantId: row.tenantId, taskId: row.taskId, versionNumber: row.versionNumber,
      status: row.status as DesignVersionStatus, changeNote: row.changeNote ?? undefined,
      rejectionReason: row.rejectionReason ?? undefined, createdAt: row.createdAt,
      files: fileRows.map(({ file, asset }) => ({ id: file.id, role: file.role, asset: mapAsset(asset) })),
    };
  }
}

function mapTask(row: typeof designTasks.$inferSelect): DesignTaskRecord {
  return { id: row.id, tenantId: row.tenantId, skuId: row.skuId, title: row.title, brief: row.brief, status: row.status as DesignTaskStatus, primaryVersionId: row.primaryVersionId ?? undefined, dueAt: row.dueAt ?? undefined };
}

function mapAsset(row: typeof assetFiles.$inferSelect): DesignAssetRecord {
  const metadata = row.rightsMetadata as { source?: RightsSource; approvedAt?: string };
  return {
    id: row.id, tenantId: row.tenantId, domain: row.assetDomain as AssetDomain, objectKey: row.objectKey,
    fileName: row.fileName, mediaType: row.mediaType, byteSize: row.byteSize, sha256: row.checksumSha256, version: row.version,
    rightsSource: metadata.source, rightsApprovedAt: metadata.approvedAt ? new Date(metadata.approvedAt) : undefined,
  };
}

function isReviewableDesignAsset(asset: DesignAssetRecord): boolean {
  if (!asset.rightsApprovedAt || !asset.rightsSource) return false;
  if (asset.domain === "authorized") return asset.rightsSource.kind !== "competitor";
  return asset.domain === "order" && asset.rightsSource.kind === "customer_provided";
}
