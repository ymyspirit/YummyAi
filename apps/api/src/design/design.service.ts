import { ConflictException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { Permission, authorize, permissionScope, type PermissionValue } from "@yummyai/authz";
import {
  CreateDesignTaskInputSchema,
  CreateCreativeDesignSkuBindingsInputSchema,
  ReviewDesignVersionInputSchema,
  RightsSourceSchema,
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
  designTasks,
  designVersionFiles,
  designVersions,
  skus,
  type DatabaseConnection,
  type TenantTransaction,
  withTenant,
} from "@yummyai/database";
import type { AssetDomain, Storage } from "@yummyai/storage";
import { and, asc, desc, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import { assertCatalogSkuAccess } from "@yummyai/catalog-core";
import { hasTenantOrderPermissions, requireTenantOrderPermissions } from "@yummyai/order-core";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, DESIGN_REPOSITORY, PRIVATE_STORAGE } from "../platform.tokens.js";
import { assertSkuSpecCompatible } from "./canvas-print-spec-policy.js";
import { requireAssetAuthority } from "../assets/asset-access.js";
import { currentDesignAuthority } from "./design-access.js";
import { requireCreativeVersionAccess, requirePrintSpecAccess } from "./canvas-workflow-access.js";

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
  if (input.sourceDomain === "research") throw new ResearchAssetPromotionError();
  if (input.sourceDomain !== "authorized") throw new AuthorizedDesignAssetRequiredError();
}

@Injectable()
export class DesignService {
  constructor(
    @Inject(DESIGN_REPOSITORY) private readonly repository: DesignRepository,
    @Optional() @Inject(AuditService) private readonly audit?: AuditService,
  ) {}

  async createTask(context: TenantContext, rawInput: CreateDesignTaskInput) {
    requirePermissions(context, [Permission.DesignRead, Permission.DesignWrite, Permission.ProductRead]);
    const task = await this.repository.createTask(context, CreateDesignTaskInputSchema.parse(rawInput));
    await this.record(context, "design.task.create", "design_task", task.id);
    return (await this.repository.getTask(context, task.id))!;
  }

  async listTasks(context: TenantContext) { requirePermissions(context, [Permission.DesignRead]); return this.repository.listTasks(context); }
  async listVersions(context: TenantContext, taskId: string) { requirePermissions(context, [Permission.DesignRead, Permission.AssetRead]); return this.repository.listVersions(context, taskId); }

  async uploadVersion(context: TenantContext, taskId: string, rawInput: UploadDesignVersionInput) {
    requirePermissions(context, [Permission.DesignRead, Permission.DesignWrite, Permission.AssetRead]);
    if (!await this.repository.getTask(context, taskId)) throw new NotFoundException("Design task not found");
    const input = UploadDesignVersionInputSchema.parse(rawInput);
    for (const file of input.files) {
      const asset = await this.repository.getAsset(context, file.assetId);
      if (!asset) throw new NotFoundException("Asset not found");
      if (!isReviewableDesignAsset(asset)) throw new AuthorizedDesignAssetRequiredError();
    }
    const version = await this.repository.createVersion(context, taskId, input);
    await this.record(context, "design.version.create", "design_version", version.id, { versionNumber: version.versionNumber });
    return (await this.repository.getVersion(context, version.id))!;
  }

  async reviewVersion(context: TenantContext, versionId: string, rawInput: ReviewDesignVersionInput) {
    requirePermissions(context, [Permission.DesignRead, Permission.DesignReview, Permission.AssetRead]);
    const input = ReviewDesignVersionInputSchema.parse(rawInput);
    const current = await this.repository.getVersion(context, versionId);
    if (!current) throw new NotFoundException("Design version not found");
    if (current.status !== "pending_review") throw new ConflictException("Only pending design versions can be reviewed");
    if (input.decision === "approve" && current.files.some(({ asset }) => !isReviewableDesignAsset(asset))) {
      throw new AuthorizedDesignAssetRequiredError();
    }
    const version = await this.repository.reviewVersion(context, versionId, input);
    await this.record(context, `design.version.${input.decision}`, "design_version", version.id, { rejectionReason: input.rejectionReason });
    return (await this.repository.getVersion(context, version.id))!;
  }

  async setPrimaryVersion(context: TenantContext, taskId: string, versionId: string) {
    requirePermissions(context, [Permission.DesignRead, Permission.DesignReview, Permission.AssetRead]);
    const version = await this.repository.getVersion(context, versionId);
    if (!version || version.taskId !== taskId) throw new NotFoundException("Design version not found for this task");
    if (version.status !== "approved") throw new ConflictException("Only approved design versions can be primary");
    const task = await this.repository.setPrimaryVersion(context, taskId, versionId);
    await this.record(context, "design.version.primary", "design_task", task.id, { versionId });
    return (await this.repository.getTask(context, task.id))!;
  }

  async promoteApprovedCreativeBindings(
    context: TenantContext,
    creativeDesignVersionId: string,
    rawInput: CreateCreativeDesignSkuBindingsInput,
  ) {
    requirePermissions(context, [Permission.DesignRead, Permission.DesignWrite, Permission.DesignReview, Permission.AssetRead, Permission.ProductRead]);
    const input = CreateCreativeDesignSkuBindingsInputSchema.parse(rawInput);
    const bindings = await this.repository.promoteApprovedCreativeBindings(context, creativeDesignVersionId, input);
    for (const binding of bindings) {
      await this.record(context, "design.creative.promote", "design_version", binding.designVersionId, {
        creativeDesignVersionId,
        designTaskId: binding.designTaskId,
        skuId: binding.skuId,
        printSpecVersionId: binding.printSpecVersionId,
      });
      await this.repository.getVersion(context, binding.designVersionId);
    }
    return bindings;
  }

  async approveAssetRights(context: TenantContext, assetId: string, source: RightsSource) {
    requirePermissions(context, [Permission.AssetRead, Permission.AssetPromote]);
    source = RightsSourceSchema.parse(source);
    if (!await this.repository.getAsset(context, assetId)) throw new NotFoundException("Asset not found");
    const asset = await this.repository.approveAssetRights(context, assetId, source);
    await this.record(context, "asset.rights.approve", "asset_file", asset.id, { rightsKind: source.kind, reference: source.reference });
    return (await this.repository.getAsset(context, asset.id))!;
  }

  async promoteAsset(context: TenantContext, assetId: string) {
    requirePermissions(context, [Permission.AssetRead, Permission.AssetPromote]);
    const asset = await this.repository.getAsset(context, assetId);
    if (!asset) throw new NotFoundException("Asset not found");
    assertPromotableToAuthorized({ sourceDomain: asset.domain, rightsSource: asset.rightsSource, rightsApprovedAt: asset.rightsApprovedAt });
    const promoted = await this.repository.promoteAsset(context, asset);
    await this.record(context, "asset.promote", "asset_file", promoted.id, { sourceAssetId: asset.id });
    return (await this.repository.getAsset(context, promoted.id))!;
  }

  async signVersionFile(context: TenantContext, versionId: string, fileId: string) {
    requirePermissions(context, [Permission.DesignRead, Permission.AssetRead]);
    const version = await this.repository.getVersion(context, versionId);
    const file = version?.files.find((candidate) => candidate.id === fileId);
    if (!file) throw new NotFoundException("Design version file not found");
    if (!isReviewableDesignAsset(file.asset)) throw new AuthorizedDesignAssetRequiredError();
    const url = await this.repository.signAsset(context, file.asset);
    const current = await this.repository.getVersion(context, versionId);
    const currentFile = current?.files.find(candidate => candidate.id === fileId);
    if (!currentFile || !sameAsset(file.asset, currentFile.asset) || !isReviewableDesignAsset(currentFile.asset))
      throw new ConflictException("Design file changed or is no longer available");
    return { url, expiresInSeconds: 600 };
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


  private async transact<T>(
    context: TenantContext,
    required: readonly PermissionValue[],
    operation: (tx: TenantTransaction, authority: TenantContext, checkedAt: number) => Promise<T>,
  ) {
    requirePermissions(context, required);
    return withTenant(this.database.db, context, async tx => {
      const { authority, checkedAt } = await currentDesignAuthority(tx, context, required);
      return operation(tx, authority, checkedAt);
    });
  }

  private async task(
    tx: TenantTransaction,
    authority: TenantContext,
    id: string,
    required: readonly PermissionValue[],
    lock: "share" | "update" = "share",
  ) {
    const [task] = await tx.select().from(designTasks).where(eq(designTasks.id, id)).limit(1).for(lock);
    if (!task) throw new NotFoundException("Design task not found");
    for (const permission of required) authorize(authority, permission, { ownerId: task.createdBy });
    if (!hasTenantOrderPermissions(authority, [Permission.OrderRead, Permission.OrderPiiRead])) {
      const [privateFile] = await tx.select({ id: designVersionFiles.id }).from(designVersions)
        .innerJoin(designVersionFiles, eq(designVersionFiles.versionId, designVersions.id))
        .innerJoin(assetFiles, eq(assetFiles.id, designVersionFiles.assetFileId))
        .where(and(eq(designVersions.taskId, id), eq(assetFiles.assetDomain, "order"))).limit(1);
      if (privateFile) requireTenantOrderPermissions(authority, [Permission.OrderRead, Permission.OrderPiiRead]);
    }
    return task;
  }

  private async asset(
    tx: TenantTransaction,
    authority: TenantContext,
    id: string,
    required: readonly PermissionValue[] = [Permission.AssetRead],
    lock: "share" | "update" = "share",
  ) {
    const [asset] = await tx.select().from(assetFiles)
      .where(and(eq(assetFiles.id, id), isNull(assetFiles.deletedAt))).limit(1).for(lock);
    if (!asset) throw new NotFoundException("Asset not found");
    for (const permission of required) requireAssetAuthority(authority, permission, asset);
    return asset;
  }

  private async version(
    tx: TenantTransaction,
    authority: TenantContext,
    id: string,
    required: readonly PermissionValue[],
    lock: "share" | "update" = "share",
  ) {
    const [hint] = await tx.select({ taskId: designVersions.taskId }).from(designVersions)
      .where(eq(designVersions.id, id)).limit(1);
    if (!hint) throw new NotFoundException("Design version not found");
    await this.task(tx, authority, hint.taskId, required, lock);
    const [row] = await tx.select().from(designVersions).where(eq(designVersions.id, id)).limit(1).for(lock);
    if (!row || row.taskId !== hint.taskId) throw new ConflictException("Design version changed");
    return row;
  }

  async createTask(context: TenantContext, rawInput: CreateDesignTaskInput) {
    const input = CreateDesignTaskInputSchema.parse(rawInput);
    return this.transact(context, [Permission.DesignRead, Permission.DesignWrite, Permission.ProductRead], async (tx, authority) => {
      await assertCatalogSkuAccess(tx, authority, input.skuId, [Permission.ProductRead], true);
      const [sku] = await tx.select().from(skus).where(eq(skus.id, input.skuId)).limit(1).for("share");
      if (!sku || sku.status === "archived") throw new ConflictException("SKU is not available for a new design task");
      const [row] = await tx.insert(designTasks).values({
        id: createEntityId(), tenantId: context.tenantId, skuId: input.skuId, title: input.title,
        brief: input.brief, dueAt: input.dueAt ? new Date(input.dueAt) : undefined, createdBy: context.userId,
      }).returning();
      return mapTask(row!);
    });
  }

  async promoteApprovedCreativeBindings(
    context: TenantContext,
    creativeDesignVersionId: string,
    input: CreateCreativeDesignSkuBindingsInput,
  ) {
    input = CreateCreativeDesignSkuBindingsInputSchema.parse(input);
    return this.transact(context, [Permission.DesignRead, Permission.DesignWrite, Permission.DesignReview, Permission.AssetRead, Permission.ProductRead], async (tx, authority, checkedAt) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${creativeDesignVersionId}:creative-promotion`}, 0))`);
      const { version: creative } = await requireCreativeVersionAccess(tx, authority, creativeDesignVersionId,
        [Permission.DesignRead, Permission.DesignWrite, Permission.DesignReview], { mutation: true });
      if (creative.status !== "approved" || !creative.reviewedBy || !creative.reviewedAt) {
        throw new ConflictException("Only reviewed, approved creative design versions can be promoted");
      }

      const skuIds = [...new Set(input.bindings.map((binding) => binding.skuId))];
      const specIds = [...new Set(input.bindings.map((binding) => binding.printSpecVersionId))];
      for (const skuId of [...skuIds].sort()) await assertCatalogSkuAccess(tx, authority, skuId, [Permission.ProductRead], true);
      const [skuRows, specRows, variantRows] = await Promise.all([
        tx.select().from(skus).where(inArray(skus.id, skuIds)).for("share"),
        tx.select().from(canvasPrintSpecVersions).where(inArray(canvasPrintSpecVersions.id, specIds)).for("share"),
        tx.select().from(creativeDesignVersionAssets).where(and(
          eq(creativeDesignVersionAssets.creativeDesignVersionId, creativeDesignVersionId),
          inArray(creativeDesignVersionAssets.printSpecVersionId, specIds),
        )),
      ]);
      if (skuRows.length !== skuIds.length) throw new NotFoundException("One or more SKUs were not found");
      if (specRows.length !== specIds.length) throw new NotFoundException("One or more print specification versions were not found");
      const assetRows = variantRows.length ? await tx.select().from(assetFiles)
        .where(inArray(assetFiles.id, variantRows.map((variant) => variant.assetId))).for("share") : [];
      const skuById = new Map(skuRows.map((row) => [row.id, row]));
      const specById = new Map(specRows.map((row) => [row.id, row]));
      const variantBySpec = new Map(variantRows.map((row) => [row.printSpecVersionId!, row]));
      const assetById = new Map(assetRows.map((row) => [row.id, row]));

      for (const binding of input.bindings) {
        const sku = skuById.get(binding.skuId)!;
        const spec = specById.get(binding.printSpecVersionId)!;
        const variant = variantBySpec.get(binding.printSpecVersionId);
        if (sku.status === "archived") throw new ConflictException(`SKU ${sku.code} is archived`);
        await requirePrintSpecAccess(tx, authority, spec.id, [Permission.DesignRead]);
        if (spec.status !== "approved") throw new ConflictException(`Print specification ${spec.name} is not approved`);
        if (!variant) throw new ConflictException(`Creative design lacks variant for ${spec.name}`);
        const asset = assetById.get(variant.assetId);
        const sourceKind = (asset?.rightsMetadata as { source?: { kind?: string } } | undefined)?.source?.kind;
        if (!asset || asset.assetDomain !== "authorized" || asset.rightsStatus !== "approved" || sourceKind === "customer_provided" || sourceKind === "competitor") {
          throw new AuthorizedDesignAssetRequiredError();
        }
        requireAssetAuthority(authority, Permission.AssetRead, asset);
        if (asset.version !== variant.assetVersion || !isReviewableDesignAsset(mapAsset(asset), checkedAt)) throw new AuthorizedDesignAssetRequiredError();
        assertSkuSpecCompatible(sku.code, sku.attributes, spec);
      }

      const results: ApprovedCreativeBindingRecord[] = [];
      for (const binding of input.bindings) {
        const [existing] = await tx.select().from(creativeDesignSkuBindings).where(and(
          eq(creativeDesignSkuBindings.creativeDesignVersionId, creativeDesignVersionId),
          eq(creativeDesignSkuBindings.skuId, binding.skuId),
          eq(creativeDesignSkuBindings.printSpecVersionId, binding.printSpecVersionId),
        )).limit(1);
        if (existing) {
          await this.task(tx, authority, existing.designTaskId, [Permission.DesignRead, Permission.DesignWrite, Permission.DesignReview]);
          results.push(existing); continue;
        }
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
    return this.transact(context, [Permission.DesignRead], async (tx, authority) =>
      mapTask(await this.task(tx, authority, id, [Permission.DesignRead])));
  }

  async listTasks(context: TenantContext) {
    return this.transact(context, [Permission.DesignRead], async (tx, authority) => {
      const owner = permissionScope(authority, Permission.DesignRead) === "tenant"
        ? undefined : eq(designTasks.createdBy, authority.userId);
      const privateFiles = tx.select({ id: designVersionFiles.id }).from(designVersions)
        .innerJoin(designVersionFiles, eq(designVersionFiles.versionId, designVersions.id))
        .innerJoin(assetFiles, eq(assetFiles.id, designVersionFiles.assetFileId))
        .where(and(eq(designVersions.taskId, designTasks.id), eq(assetFiles.assetDomain, "order")));
      const privateFilter = hasTenantOrderPermissions(authority, [Permission.OrderRead, Permission.OrderPiiRead])
        ? undefined : notExists(privateFiles);
      const rows = await tx.select().from(designTasks).where(and(owner, privateFilter)).orderBy(desc(designTasks.updatedAt));
      return rows.map(mapTask);
    });
  }

  async createVersion(context: TenantContext, taskId: string, rawInput: UploadDesignVersionInput) {
    const input = UploadDesignVersionInputSchema.parse(rawInput);
    const required = [Permission.DesignRead, Permission.DesignWrite, Permission.AssetRead];
    return this.transact(context, required, async (tx, authority, checkedAt) => {
      const task = await this.task(tx, authority, taskId, [Permission.DesignRead, Permission.DesignWrite], "update");
      if (task.status === "archived") throw new ConflictException("Archived design tasks cannot receive new versions");
      for (const id of [...new Set(input.files.map(f => f.assetId))].sort()) {
        const asset = await this.asset(tx, authority, id);
        if (!isReviewableDesignAsset(mapAsset(asset), checkedAt)) throw new AuthorizedDesignAssetRequiredError();
      }
      const [latest] = await tx.select({ number: designVersions.versionNumber }).from(designVersions)
        .where(eq(designVersions.taskId, taskId)).orderBy(desc(designVersions.versionNumber)).limit(1);
      const [version] = await tx.insert(designVersions).values({
        id: createEntityId(), tenantId: context.tenantId, taskId, versionNumber: (latest?.number ?? 0) + 1,
        changeNote: input.changeNote, createdBy: context.userId,
      }).returning();
      await tx.insert(designVersionFiles).values(input.files.map(file => ({
        id: createEntityId(), tenantId: context.tenantId, versionId: version!.id, assetFileId: file.assetId, role: file.role,
      })));
      await tx.update(designTasks).set({ status: "in_review", updatedAt: new Date() }).where(eq(designTasks.id, taskId));
      return this.hydrateVersion(tx, authority, version!);
    });
  }

  async getVersion(context: TenantContext, id: string) {
    return this.transact(context, [Permission.DesignRead, Permission.AssetRead], async (tx, authority) => {
      const row = await this.version(tx, authority, id, [Permission.DesignRead]);
      return this.hydrateVersion(tx, authority, row);
    });
  }

  async listVersions(context: TenantContext, taskId: string) {
    return this.transact(context, [Permission.DesignRead, Permission.AssetRead], async (tx, authority) => {
      await this.task(tx, authority, taskId, [Permission.DesignRead]);
      const rows = await tx.select().from(designVersions).where(eq(designVersions.taskId, taskId))
        .orderBy(desc(designVersions.versionNumber)).for("share");
      const result: DesignVersionRecord[] = [];
      for (const row of rows) result.push(await this.hydrateVersion(tx, authority, row));
      return result;
    });
  }

  async reviewVersion(context: TenantContext, id: string, rawInput: ReviewDesignVersionInput) {
    const input = ReviewDesignVersionInputSchema.parse(rawInput);
    return this.transact(context, [Permission.DesignRead, Permission.DesignReview, Permission.AssetRead], async (tx, authority, checkedAt) => {
      const row = await this.version(tx, authority, id, [Permission.DesignRead, Permission.DesignReview], "update");
      if (row.status !== "pending_review") throw new ConflictException("Only pending design versions can be reviewed");
      const current = await this.hydrateVersion(tx, authority, row);
      if (input.decision === "approve" && current.files.some(({ asset }) => !isReviewableDesignAsset(asset, checkedAt)))
        throw new AuthorizedDesignAssetRequiredError();
      const [updated] = await tx.update(designVersions).set({
        status: input.decision === "approve" ? "approved" : "rejected",
        rejectionReason: input.decision === "reject" ? input.rejectionReason : null,
        reviewedBy: context.userId, reviewedAt: new Date(),
      }).where(and(eq(designVersions.id, id), eq(designVersions.status, "pending_review"))).returning();
      if (!updated) throw new ConflictException("Design review changed");
      return this.hydrateVersion(tx, authority, updated);
    });
  }

  async setPrimaryVersion(context: TenantContext, taskId: string, versionId: string) {
    return this.transact(context, [Permission.DesignRead, Permission.DesignReview, Permission.AssetRead], async (tx, authority, checkedAt) => {
      const task = await this.task(tx, authority, taskId, [Permission.DesignRead, Permission.DesignReview], "update");
      if (task.status === "archived") throw new ConflictException("Archived design tasks cannot change primary version");
      const [version] = await tx.select().from(designVersions).where(eq(designVersions.id, versionId)).limit(1).for("share");
      if (!version || version.taskId !== taskId || version.status !== "approved")
        throw new ConflictException("An approved version of this task is required");
      const hydrated = await this.hydrateVersion(tx, authority, version);
      if (hydrated.files.some(({ asset }) => !isReviewableDesignAsset(asset, checkedAt))) throw new AuthorizedDesignAssetRequiredError();
      const [row] = await tx.update(designTasks).set({ primaryVersionId: versionId, status: "approved", updatedAt: new Date() })
        .where(eq(designTasks.id, taskId)).returning();
      return mapTask(row!);
    });
  }

  async getAsset(context: TenantContext, id: string) {
    return this.transact(context, [Permission.AssetRead], async (tx, authority) =>
      mapAsset(await this.asset(tx, authority, id)));
  }

  async approveAssetRights(context: TenantContext, id: string, rawSource: RightsSource) {
    const source = RightsSourceSchema.parse(rawSource);
    return this.transact(context, [Permission.AssetRead, Permission.AssetPromote], async (tx, authority) => {
      const asset = await this.asset(tx, authority, id, [Permission.AssetRead, Permission.AssetPromote], "update");
      const metadata = asset.rightsMetadata as { source?: RightsSource };
      if (asset.assetDomain === "order") {
        if (source.kind !== "customer_provided") throw new ConflictException("Order-private assets require customer-provided rights evidence");
        if (!metadata.source?.reference || source.reference !== metadata.source.reference)
          throw new ConflictException("Order-private asset rights evidence must retain its pinned customization reference");
      }
      if (asset.assetDomain === "research" && metadata.source?.kind === "competitor" && source.kind !== "competitor")
        throw new ConflictException("Competitor provenance cannot be relabelled as publishable ownership");
      const [row] = await tx.update(assetFiles).set({
        rightsStatus: "approved",
        rightsMetadata: { ...asset.rightsMetadata, source, approvedAt: new Date().toISOString(), approvedBy: context.userId },
      }).where(eq(assetFiles.id, id)).returning();
      return mapAsset(row!);
    });
  }

  async promoteAsset(context: TenantContext, input: DesignAssetRecord) {
    return this.transact(context, [Permission.AssetRead, Permission.AssetPromote], async (tx, authority, checkedAt) => {
      const asset = await this.asset(tx, authority, input.id, [Permission.AssetRead, Permission.AssetPromote]);
      const current = mapAsset(asset);
      if (!sameAsset(input, current)) throw new ConflictException("Asset changed");
      assertPromotableToAuthorized({ sourceDomain: current.domain, rightsSource: current.rightsSource, rightsApprovedAt: current.rightsApprovedAt });
      if (!isReviewableDesignAsset(current, checkedAt)) throw new AuthorizedDesignAssetRequiredError();
      return current;
    });
  }

  async signAsset(context: TenantContext, input: DesignAssetRecord) {
    const check = () => this.transact(context, [Permission.AssetRead], async (tx, authority, checkedAt) => {
      const current = mapAsset(await this.asset(tx, authority, input.id));
      if (!sameAsset(input, current)) throw new ConflictException("Asset changed");
      if (!isReviewableDesignAsset(current, checkedAt)) throw new AuthorizedDesignAssetRequiredError();
      return current;
    });
    const asset = await check(), requiredDomain = asset.domain === "order" ? "order" : "authorized";
    const url = await this.storage.signRead(context, {
      id: asset.id, tenantId: asset.tenantId, assetDomain: asset.domain, objectKey: asset.objectKey,
    }, { requiredDomain });
    await check();
    return url;
  }

  private async hydrateVersion(tx: TenantTransaction, authority: TenantContext, row: typeof designVersions.$inferSelect): Promise<DesignVersionRecord> {
    const fileRows = await tx.select({ file: designVersionFiles, asset: assetFiles }).from(designVersionFiles)
      .innerJoin(assetFiles, eq(designVersionFiles.assetFileId, assetFiles.id))
      .where(eq(designVersionFiles.versionId, row.id)).orderBy(asc(designVersionFiles.role)).for("share");
    for (const { asset } of fileRows) requireAssetAuthority(authority, Permission.AssetRead, asset);
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
  const approvedAt = metadata.approvedAt ? new Date(metadata.approvedAt) : undefined;
  return {
    id: row.id, tenantId: row.tenantId, domain: row.assetDomain as AssetDomain, objectKey: row.objectKey,
    fileName: row.fileName, mediaType: row.mediaType, byteSize: row.byteSize, sha256: row.checksumSha256, version: row.version,
    rightsSource: metadata.source,
    rightsApprovedAt: !row.deletedAt && row.rightsStatus === "approved" && approvedAt && Number.isFinite(approvedAt.getTime()) ? approvedAt : undefined,
  };
}

function isReviewableDesignAsset(asset: DesignAssetRecord, checkedAt?: number): boolean {
  if (!asset.rightsApprovedAt || !asset.rightsSource) return false;
  if (checkedAt !== undefined && asset.rightsSource.licenseExpiresAt && !(Date.parse(asset.rightsSource.licenseExpiresAt) > checkedAt)) return false;
  if (asset.domain === "authorized") return asset.rightsSource.kind !== "competitor";
  return asset.domain === "order" && asset.rightsSource.kind === "customer_provided";
}

function requirePermissions(context: TenantContext, permissions: readonly PermissionValue[]) {
  for (const permission of permissions) authorize(context, permission);
}

function sameAsset(first: DesignAssetRecord, second: DesignAssetRecord) {
  return first.id === second.id && first.tenantId === second.tenantId && first.domain === second.domain &&
    first.objectKey === second.objectKey && first.sha256 === second.sha256 && first.version === second.version;
}
