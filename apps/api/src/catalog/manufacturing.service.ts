import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { authorize, Permission, type PermissionValue } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  CreateManufacturingRecipeSchema, ReviseManufacturingRecipeSchema, ReviewManufacturingRecipeSchema, ManufacturingDemandSchema,
  manufacturingApprovalProblems, calculateManufacturingDemand,
  type ManufacturingRecipeContent, type ManufacturingRecipeVersionView, type ManufacturingRecipeWorkspace, type ManufacturingTransport,
  type ManufacturingReferences, type ManufacturingMaterialOptions,
} from "@yummyai/contracts/catalog/manufacturing";
import { specificationProductionFactsReady } from "@yummyai/contracts/catalog/development";
import { CatalogError, catalogContextAuthority, currentCatalogContext, assertCatalogSpuAccess, assertCatalogSourceActive, assertCatalogUnambiguousPlan } from "@yummyai/catalog-core";
import {
  manufacturingRecipes as recipes, manufacturingRecipeVersions as versions, manufacturingBomLines as materials,
  manufacturingOperations as operations, manufacturingRecipeReviews as reviews, manufacturingRecipeCommands as commands,
  productSpecifications, productSpecificationVersions, inventoryStockItems, spus, productPlans,
  type DatabaseConnection, type TenantTransaction,
} from "@yummyai/database";
import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { withCatalogTenant } from "./catalog-access.js";
import { readManufacturingVersion } from "./manufacturing-read.js";

type Recipe = typeof recipes.$inferSelect;
const Query = z.object({ spuId: z.uuidv7(), after: z.uuidv7().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();
const checksum = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

@Injectable()
export class ManufacturingService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection, @Inject(AuditService) private readonly audit: AuditService) {}

  private run<T, Wrapped extends boolean = false>(input: TenantContext, fn: (tx: TenantTransaction, context: TenantContext) => Promise<T>, wrapped?: Wrapped): Promise<ManufacturingTransport<T, Wrapped>> {
    return withCatalogTenant(this.database.db, input, async tx => {
      const current = await currentCatalogContext(tx, input);
      authorize(current, Permission.ProductRead);
      const data = await fn(tx, current);
      return (wrapped ? { data, contextAuthority: catalogContextAuthority(current) } : data) as ManufacturingTransport<T, Wrapped>;
    });
  }
  private lock(tx: TenantTransaction, context: TenantContext, key: string) {
    return tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${context.tenantId + ":manufacturing:" + key},0))`);
  }
  private async root(tx: TenantTransaction, context: TenantContext, id: string, permission: PermissionValue, write: boolean) {
    const [root] = await tx.select().from(recipes).where(eq(recipes.id, id));
    if (!root) throw new NotFoundException("制造模板不存在或不可访问");
    const spu = await assertCatalogSpuAccess(tx, context, root.spuId, [Permission.ProductRead, permission], write);
    if (write) {
      await tx.select({ id: recipes.id }).from(recipes).where(eq(recipes.id, id)).for("update");
      // The parent lock precedes the root lock on every command.
      const [fresh] = await tx.select().from(recipes).where(eq(recipes.id, id));
      return { ...fresh!, planId: spu.planId };
    }
    return { ...root, planId: spu.planId };
  }
  private async replay(tx: TenantTransaction, context: TenantContext, key: string, operation: string, requestChecksum: string) {
    const [old] = await tx.select().from(commands).where(eq(commands.requestKey, key));
    if (!old) return null;
    if (old.createdBy !== context.userId || old.operation !== operation || old.requestChecksum !== requestChecksum)
      throw new ConflictException("请求编号已用于另一内容或操作员 请保留原请求后核对");
    return old.response;
  }
  private async record(tx: TenantTransaction, context: TenantContext, operation: string, key: string, requestChecksum: string, result: ManufacturingRecipeVersionView) {
    await tx.insert(commands).values({ id: createEntityId(), tenantId: context.tenantId, createdBy: context.userId, requestKey: key, requestChecksum,
      operation, recipeId: result.recipeId, versionId: result.versionId, response: result });
    await this.audit.recordInTransaction(tx, context, { action: `manufacturing.${operation}`, resourceType: "manufacturing_recipe", resourceId: result.recipeId,
      result: "success", metadata: { versionId: result.versionId, versionNumber: result.versionNumber } });
    return result;
  }
  private async currentSpecification(tx: TenantTransaction, root: Pick<Recipe, "specificationId">, versionId: string) {
    // Only the mutable identity is locked. Immutable versions deliberately have no UPDATE privilege.
    const [identity] = await tx.select({ number: productSpecifications.versionNumber }).from(productSpecifications)
      .where(eq(productSpecifications.id, root.specificationId)).for("share");
    const [version] = await tx.select().from(productSpecificationVersions)
      .where(and(eq(productSpecificationVersions.id, versionId), eq(productSpecificationVersions.specificationId, root.specificationId)));
    if (!identity || !version) throw new NotFoundException("规格版本不存在或不属于本制造模板");
    if (version.versionNumber !== identity.number) throw new ConflictException("产品规格已更新 请明确选择当前规格后建立新制造版本");
    return version;
  }
  private async stockProblems(tx: TenantTransaction, content: ManufacturingRecipeContent, strictUnit: boolean) {
    const ids = [...new Set(content.materials.flatMap(row => row.stockItemId ? [row.stockItemId] : []))].sort();
    const stocks = ids.length ? await tx.select({ id: inventoryStockItems.id, unit: inventoryStockItems.baseUnit, status: inventoryStockItems.status })
      .from(inventoryStockItems).where(inArray(inventoryStockItems.id, ids)).orderBy(asc(inventoryStockItems.id)).for("share") : [];
    if (stocks.length !== ids.length) throw new NotFoundException("材料物料不存在或不属于当前组织");
    const problems: string[] = [];
    for (const row of content.materials) {
      const stock = stocks.find(item => item.id === row.stockItemId);
      if (stock && row.unit !== null && stock.unit !== row.unit) {
        if (strictUnit) throw new ConflictException(`${row.code} 的耗量单位必须与物料基本单位一致 不自动换算`);
        problems.push(`${row.code} 的物料基本单位已变化`);
      }
      if (stock && stock.status !== "active") problems.push(`${row.code} 的物料已停用`);
    }
    return problems;
  }
  private async addVersion(tx: TenantTransaction, context: TenantContext, root: Recipe, content: ManufacturingRecipeContent, versionNumber: number) {
    await assertCatalogSourceActive(tx, root.spuId);
    await this.currentSpecification(tx, root, content.specificationVersionId);
    authorize(context, Permission.InventoryRead);
    await this.stockProblems(tx, content, true);
    const versionId = createEntityId();
    await tx.insert(versions).values({ id: versionId, tenantId: context.tenantId, createdBy: context.userId, recipeId: root.id,
      specificationId: root.specificationId, specificationVersionId: content.specificationVersionId, versionNumber, name: content.name,
      outputQuantity: content.outputQuantity, outputUnit: content.outputUnit, notes: content.notes });
    if (content.operations.length) await tx.insert(operations).values(content.operations.map((payload, index) => ({
      id: createEntityId(), tenantId: context.tenantId, createdBy: context.userId, versionId, position: index + 1, code: payload.code, payload,
    })));
    if (content.materials.length) await tx.insert(materials).values(content.materials.map((payload, index) => ({
      id: createEntityId(), tenantId: context.tenantId, createdBy: context.userId, versionId, position: index + 1, code: payload.code,
      stockItemId: payload.stockItemId, operationCode: payload.operationCode, payload,
    })));
    return this.version(tx, root, versionId);
  }
  private async version(tx: TenantTransaction, root: Recipe, versionId: string): Promise<ManufacturingRecipeVersionView> {
    return readManufacturingVersion(tx, root, versionId);
  }

  create<Wrapped extends boolean = false>(context: TenantContext, body: unknown, wrapped?: Wrapped) {
    const input = CreateManufacturingRecipeSchema.parse(body), requestChecksum = checksum({ operation: "create", input });
    return this.run(context, async (tx, current) => {
      await this.lock(tx, current, input.idempotencyKey);
      const spu = await assertCatalogSpuAccess(tx, current, input.spuId, [Permission.ProductRead, Permission.ProductWrite], true);
      const replay = await this.replay(tx, current, input.idempotencyKey, "create", requestChecksum); if (replay) return replay;
      await assertCatalogUnambiguousPlan(tx, spu.planId);
      const [spec] = await tx.select({ id: productSpecifications.id }).from(productSpecifications)
        .where(and(eq(productSpecifications.id, input.specificationId), eq(productSpecifications.spuId, input.spuId)));
      if (!spec) throw new NotFoundException("规格不属于当前 SPU");
      const [duplicate] = await tx.select({ id: recipes.id }).from(recipes).where(and(eq(recipes.spuId, input.spuId), sql`lower(${recipes.code})=lower(${input.code})`));
      if (duplicate) throw new ConflictException("制造模板编号已存在 请读取后建立新版本");
      const [root] = await tx.insert(recipes).values({ id: createEntityId(), tenantId: current.tenantId, createdBy: current.userId,
        spuId: input.spuId, specificationId: input.specificationId, code: input.code }).returning();
      return this.record(tx, current, "create", input.idempotencyKey, requestChecksum, await this.addVersion(tx, current, root!, input.content, 1));
    }, wrapped);
  }
  revise<Wrapped extends boolean = false>(context: TenantContext, recipeId: string, body: unknown, wrapped?: Wrapped) {
    const input = ReviseManufacturingRecipeSchema.parse(body), requestChecksum = checksum({ operation: "revise", recipeId, input });
    return this.run(context, async (tx, current) => {
      await this.lock(tx, current, input.idempotencyKey);
      const root = await this.root(tx, current, recipeId, Permission.ProductWrite, true);
      const replay = await this.replay(tx, current, input.idempotencyKey, "revise", requestChecksum); if (replay) return replay;
      await assertCatalogUnambiguousPlan(tx, root.planId);
      if (root.archivedAt || root.versionNumber !== input.expectedVersion) throw new ConflictException("制造模板已归档或版本变化 请保留填写并重新核对");
      const result = await this.addVersion(tx, current, root, input.content, root.versionNumber + 1);
      await tx.update(recipes).set({ versionNumber: root.versionNumber + 1 }).where(eq(recipes.id, recipeId));
      return this.record(tx, current, "revise", input.idempotencyKey, requestChecksum, result);
    }, wrapped);
  }
  review<Wrapped extends boolean = false>(context: TenantContext, recipeId: string, body: unknown, wrapped?: Wrapped) {
    const input = ReviewManufacturingRecipeSchema.parse(body), requestChecksum = checksum({ operation: "review", recipeId, input });
    return this.run(context, async (tx, current) => {
      await this.lock(tx, current, input.idempotencyKey);
      const root = await this.root(tx, current, recipeId, Permission.ManufacturingReview, true);
      const replay = await this.replay(tx, current, input.idempotencyKey, "review", requestChecksum); if (replay) return replay;
      await assertCatalogUnambiguousPlan(tx, root.planId);
      if (root.archivedAt || root.versionNumber !== input.expectedVersion) throw new ConflictException("制造模板已归档或版本变化 请重新核对");
      await assertCatalogSourceActive(tx, root.spuId);
      const version = await this.version(tx, root, input.versionId);
      if (version.versionNumber !== root.versionNumber || version.review) throw new ConflictException("仅能审核当前未审核版本 请另建新版本修改");
      const spec = await this.currentSpecification(tx, root, version.content.specificationVersionId);
      if (input.decision === "approved") {
        authorize(current, Permission.InventoryRead);
        const problems = [...manufacturingApprovalProblems(version.content), ...await this.stockProblems(tx, version.content, false)];
        if (!specificationProductionFactsReady(spec.facts)) problems.push("当前产品规格生产资料尚未确认完整");
        if (problems.length) throw new ConflictException(problems.join("；"));
      }
      await tx.insert(reviews).values({ id: createEntityId(), tenantId: current.tenantId, createdBy: current.userId, recipeId,
        versionId: input.versionId, decision: input.decision, note: input.note });
      return this.record(tx, current, "review", input.idempotencyKey, requestChecksum, await this.version(tx, root, input.versionId));
    }, wrapped);
  }
  list<Wrapped extends boolean = false>(context: TenantContext, query: unknown, wrapped?: Wrapped) {
    const input = Query.parse(query);
    return this.run(context, async (tx, current) => {
      await assertCatalogSpuAccess(tx, current, input.spuId, [Permission.ProductRead], true);
      const rows = await tx.select({ id: recipes.id, code: recipes.code, specificationId: recipes.specificationId, versionNumber: recipes.versionNumber })
        .from(recipes).where(and(eq(recipes.spuId, input.spuId), isNull(recipes.archivedAt), input.after ? gt(recipes.id, input.after) : undefined))
        .orderBy(asc(recipes.id)).limit(input.limit + 1);
      const items = rows.slice(0, input.limit);
      return { items, nextCursor: rows.length > input.limit ? items.at(-1)!.id : null };
    }, wrapped);
  }
  get<Wrapped extends boolean = false>(context: TenantContext, recipeId: string, versionId: string, wrapped?: Wrapped): Promise<ManufacturingTransport<ManufacturingRecipeVersionView, Wrapped>>;
  get<Wrapped extends boolean = false>(context: TenantContext, recipeId: string, versionId?: undefined, wrapped?: Wrapped): Promise<ManufacturingTransport<ManufacturingRecipeWorkspace, Wrapped>>;
  get<Wrapped extends boolean = false>(context: TenantContext, recipeId: string, versionId?: string, wrapped?: Wrapped): Promise<ManufacturingTransport<ManufacturingRecipeVersionView | ManufacturingRecipeWorkspace, Wrapped>> {
    return this.run(context, async (tx, current) => {
      const root = await this.root(tx, current, recipeId, Permission.ProductRead, true);
      if (versionId) return this.version(tx, root, versionId);
      return this.workspace(tx, root, current);
    }, wrapped);
  }
  private async workspace(tx: TenantTransaction, root: Recipe, context: TenantContext): Promise<ManufacturingRecipeWorkspace> {
    const [latest] = await tx.select({ id: versions.id }).from(versions).where(and(eq(versions.recipeId, root.id), eq(versions.versionNumber, root.versionNumber)));
    if (!latest) throw new ConflictException("制造版本记录不完整 请核对历史");
    const [released] = await tx.select({ id: versions.id }).from(versions).innerJoin(reviews, eq(reviews.versionId, versions.id))
      .where(and(eq(versions.recipeId, root.id), eq(reviews.decision, "approved"))).orderBy(desc(versions.versionNumber)).limit(1);
    const currentVersion = await this.version(tx, root, latest.id);
    const releasedVersion = released ? await this.version(tx, root, released.id) : null;
    const availability = async (version: ManufacturingRecipeVersionView) => {
      const problems: string[] = [];
      if (root.archivedAt) problems.push("制造模板已归档");
      try { await assertCatalogSourceActive(tx, root.spuId); }
      catch (error) { if (error instanceof CatalogError) problems.push(error.message); else throw error; }
      try {
        const spec = await this.currentSpecification(tx, root, version.content.specificationVersionId);
        if (!specificationProductionFactsReady(spec.facts)) problems.push("当前产品规格生产资料尚未确认完整");
      } catch (error) {
        if (error instanceof ConflictException || error instanceof NotFoundException) problems.push(error.message); else throw error;
      }
      if (context.permissions.includes(Permission.InventoryRead)) problems.push(...await this.stockProblems(tx, version.content, false));
      else problems.push("当前账号缺少物料读取权限 不能复核新制造操作");
      return problems;
    };
    return { recipeId: root.id, spuId: root.spuId, specificationId: root.specificationId, code: root.code, archived: root.archivedAt !== null,
      currentVersion, releasedVersion,
      approvalProblems: [...manufacturingApprovalProblems(currentVersion.content), ...await availability(currentVersion)],
      releaseProblems: releasedVersion ? await availability(releasedVersion) : ["尚无已批准制造版本"] };
  }
  estimate<Wrapped extends boolean = false>(context: TenantContext, recipeId: string, body: unknown, wrapped?: Wrapped) {
    const input = ManufacturingDemandSchema.parse(body);
    return this.run(context, async (tx, current) => {
      authorize(current, Permission.InventoryRead);
      const root = await this.root(tx, current, recipeId, Permission.ProductRead, true);
      await assertCatalogSourceActive(tx, root.spuId);
      const workspace = await this.workspace(tx, root, current), version = workspace.releasedVersion;
      if (root.archivedAt || !version || version.versionId !== input.versionId) throw new ConflictException("请明确使用当前已批准的制造版本");
      const spec = await this.currentSpecification(tx, root, version.content.specificationVersionId);
      const problems = await this.stockProblems(tx, version.content, false);
      if (!specificationProductionFactsReady(spec.facts)) problems.push("产品规格生产资料不可用于新制造");
      if (problems.length) throw new ConflictException(problems.join("；"));
      return { recipeId, versionId: version.versionId, specificationVersionId: version.content.specificationVersionId,
        ...calculateManufacturingDemand(version.content, input.outputQuantity) };
    }, wrapped);
  }
  references<Wrapped extends boolean = false>(context: TenantContext, spuId: string, wrapped?: Wrapped) {
    z.uuidv7().parse(spuId);
    return this.run(context, async (tx, current): Promise<ManufacturingReferences> => {
      const parent = await assertCatalogSpuAccess(tx, current, spuId, [Permission.ProductRead], true);
      const [spu] = await tx.select({ id: spus.id, code: spus.code, name: spus.name }).from(spus).where(eq(spus.id, spuId));
      const [plan] = await tx.select({ ownerId: productPlans.createdBy, teamId: productPlans.teamId }).from(productPlans).where(eq(productPlans.id, parent.planId));
      const sourceProblems: string[] = [];
      try { await assertCatalogSourceActive(tx, spuId); }
      catch (error) { if (error instanceof CatalogError) sourceProblems.push(error.message); else throw error; }
      try { await assertCatalogUnambiguousPlan(tx, parent.planId); }
      catch (error) { if (error instanceof CatalogError) sourceProblems.push(error.message); else throw error; }
      const specs = await tx.select({ id: productSpecifications.id, code: productSpecifications.code, name: productSpecificationVersions.name,
        versionId: productSpecificationVersions.id, versionNumber: productSpecifications.versionNumber, facts: productSpecificationVersions.facts })
        .from(productSpecifications).innerJoin(productSpecificationVersions, and(eq(productSpecificationVersions.specificationId, productSpecifications.id), eq(productSpecificationVersions.versionNumber, productSpecifications.versionNumber)))
        .where(eq(productSpecifications.spuId, spuId)).orderBy(asc(productSpecifications.code), asc(productSpecifications.id));
      return { spu: { ...spu!, ...plan!, active: !sourceProblems.length }, sourceProblems, canReadMaterials: current.permissions.includes(Permission.InventoryRead),
        specifications: specs.map(({ facts, ...spec }) => ({ ...spec, factsReady: specificationProductionFactsReady(facts) })) };
    }, wrapped);
  }
  materialOptions<Wrapped extends boolean = false>(context: TenantContext, query: unknown, wrapped?: Wrapped) {
    const input = Query.extend({ search: z.string().trim().max(150).default(""), selected: z.string().max(7400).default("").transform(value => value ? z.array(z.uuidv7()).max(200).parse(value.split(",")) : []) }).parse(query);
    return this.run(context, async (tx, current): Promise<ManufacturingMaterialOptions> => {
      authorize(current, Permission.InventoryRead);
      await assertCatalogSpuAccess(tx, current, input.spuId, [Permission.ProductRead], true);
      const pattern = `%${input.search.replace(/[\\%_]/g, "\\$&")}%`;
      const rows = await tx.select({ id: inventoryStockItems.id, code: inventoryStockItems.code, name: inventoryStockItems.name,
        baseUnit: inventoryStockItems.baseUnit, status: inventoryStockItems.status }).from(inventoryStockItems)
        .where(and(eq(inventoryStockItems.status, "active"), input.search ? or(ilike(inventoryStockItems.name, pattern), ilike(inventoryStockItems.code, pattern)) : undefined,
          input.after ? gt(inventoryStockItems.id, input.after) : undefined)).orderBy(asc(inventoryStockItems.id)).limit(input.limit + 1);
      const selected = input.selected.length ? await tx.select({ id: inventoryStockItems.id, code: inventoryStockItems.code, name: inventoryStockItems.name,
        baseUnit: inventoryStockItems.baseUnit, status: inventoryStockItems.status }).from(inventoryStockItems).where(inArray(inventoryStockItems.id, input.selected)) : [];
      const items = rows.slice(0, input.limit);
      return { items: items as ManufacturingMaterialOptions["items"], selected: selected as ManufacturingMaterialOptions["selected"],
        missingSelected: input.selected.filter(id => !selected.some(item => item.id === id)), nextCursor: rows.length > input.limit ? items.at(-1)!.id : null };
    }, wrapped);
  }
  history<Wrapped extends boolean = false>(context: TenantContext, recipeId: string, query: unknown, wrapped?: Wrapped) {
    const input = z.object({ before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict().parse(query);
    return this.run(context, async (tx, current) => {
      await this.root(tx, current, recipeId, Permission.ProductRead, true);
      const rows = await tx.select({ id: versions.id, versionNumber: versions.versionNumber, name: versions.name, createdAt: versions.createdAt, decision: reviews.decision })
        .from(versions).leftJoin(reviews, eq(reviews.versionId, versions.id))
        .where(and(eq(versions.recipeId, recipeId), input.before ? lt(versions.versionNumber, input.before) : undefined)).orderBy(desc(versions.versionNumber)).limit(input.limit + 1);
      const items = rows.slice(0, input.limit).map(row => ({ ...row, createdAt: row.createdAt.toISOString(), decision: row.decision as "approved" | "rejected" | null }));
      return { items, nextVersion: rows.length > input.limit ? items.at(-1)!.versionNumber : null };
    }, wrapped);
  }
}
