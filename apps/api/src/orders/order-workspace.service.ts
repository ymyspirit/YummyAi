import {
  resolveOrderSalesBasis,
  validateOrderSalesBasis,
  orderSalesChoices,
} from "../catalog/order-sales-basis.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readArtwork, readSpecification } from "../catalog/development-data.js";
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import { authorize, Permission } from "@yummyai/authz";
import {
  createEntityId,
  type TenantContext,
  type AmazonReportDetailView,
} from "@yummyai/contracts";
import {
  DEFAULT_ORDER_DESIGN_EXECUTOR,
  ArchiveOrderWorkInputSchema,
  orderDesignExecutor,
  OrderWorkActionInputSchema,
  OrderWorkDraftSchema,
  OrderWorkListItemSchema,
  OrderWorkQuerySchema,
  OrderWorkSelectionInputSchema,
  OrderBulkPreviewInputSchema,
  type OrderWorkSummary,
  type OrderBulkPreview,
  PrintProfileInputSchema,
  SaveOrderWorkDraftInputSchema,
  type OrderWorkDraft,
  type OrderWorkDetail,
  type PrintProfileView,
  type OrderTemplatePlan,
} from "@yummyai/contracts/order/workspace";
import {
  orderWorkItems as items,
  orderWorkRevisions as revisions,
  orderWorkAssets as assets,
  orderWorkEvents as events,
  printProfiles,
  artworkMasters,
  printProfileVersions,
  orderLines,
  orders,
  users,
  amazonOrderReportLines,
  productionOrders,
  withTenant,
  type DatabaseConnection,
  type TenantTransaction,
} from "@yummyai/database";
import { decryptProductionBytes, encryptProductionBytes } from "@yummyai/production-editor";
import type { Storage } from "@yummyai/storage";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import sharp from "sharp";
import { assertAutomaticArtwork, composeOrderArtwork } from "../design/order-artwork-layout.js";
import { isPhotoOnlyPillowArtwork } from "../design/order-pillow-plan.js";
import { DATABASE_CONNECTION, ORDER_PII_VAULT, PRIVATE_STORAGE } from "../platform.tokens.js";
import {
  ProductionEditorService,
  ProductionEditorScanner,
} from "../design/production-editor.service.js";
import { AmazonOrderReportService } from "./amazon-order-report.service.js";
import { workFilter, workProjection } from "./order-workspace-query.js";
import { OrderQueueStageSchema, type OrderQueueCounts } from "@yummyai/contracts/order/workbench";

type Work = typeof items.$inferSelect;
type ImageMetadata = { name: string; mediaType: string; width: number; height: number };
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const sealWork = (key: Uint8Array, value: unknown) =>
  Buffer.from(encryptProductionBytes(key, Buffer.from(JSON.stringify(value)))).toString("base64");
export const openWork = <T>(key: Uint8Array, value: string): T =>
  JSON.parse(
    Buffer.from(decryptProductionBytes(key, Buffer.from(value, "base64"))).toString("utf8"),
  ) as T;

@Injectable()
export class OrderWorkspaceService {
  /** Current workflow counts for the orders actually represented in a finance calculation. */
  analysisSummary(context: TenantContext, orderIds: string[]) {
    authorize(context, Permission.OrderRead);
    if (orderIds.length > 1000)
      throw new UnprocessableEntityException("关联订单超过 1000 个，请缩小财务计算范围");
    return withTenant(
      this.database.db,
      context,
      async (tx) => {
        if (!orderIds.length) return { orderCount: 0, stages: [], production: [] };
        const orderRows = await tx
          .select({ id: orders.id })
          .from(orders)
          .where(inArray(orders.id, orderIds));
        const stages = await tx
          .select({
            preparation: items.preparation,
            artwork: items.artwork,
            held: items.held,
            count: sql<number>`count(*)::int`,
          })
          .from(items)
          .innerJoin(orderLines, eq(orderLines.id, items.id))
          .where(inArray(orderLines.orderId, orderIds))
          .groupBy(items.preparation, items.artwork, items.held)
          .orderBy(items.preparation, items.artwork, items.held);
        const production = await tx
          .select({ status: productionOrders.status, count: sql<number>`count(*)::int` })
          .from(productionOrders)
          .where(inArray(productionOrders.orderId, orderIds))
          .groupBy(productionOrders.status)
          .orderBy(productionOrders.status);
        return { orderCount: orderRows.length, stages, production };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(ORDER_PII_VAULT) private readonly vault: SecretVault,
    @Inject(PRIVATE_STORAGE) private readonly storage: Storage,
    @Inject(AmazonOrderReportService) private readonly reports: AmazonOrderReportService,
    @Inject(ProductionEditorService) private readonly editor: ProductionEditorService,
    @Inject(ProductionEditorScanner) private readonly scanner: ProductionEditorScanner,
  ) {}

  async list(context: TenantContext, raw: unknown) {
    authorize(context, Permission.OrderRead);
    const query = OrderWorkQuerySchema.parse(raw),
      filter = workFilter(query);
    await this.refreshSearchProjection(context);
    return withTenant(
      this.database.db,
      context,
      async (tx) => {
        const totals = await tx.execute(
          sql`with v as (${workProjection}) select count(*)::int as total, count(distinct "orderId")::int as groups from v where ${filter}`,
        );
        const rows = await tx.execute(
          query.grouping === "orders"
            ? sql`with v as (${workProjection}), matched as (select * from v where ${filter}), page_orders as (select "orderId", max("updatedAt") as updated from matched group by "orderId" order by updated desc, "orderId" desc limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}) select m.* from matched m join page_orders p on p."orderId" = m."orderId" order by p.updated desc, p."orderId" desc, m.id desc limit 1001`
            : sql`with v as (${workProjection}) select * from v where ${filter} order by "updatedAt" desc, id desc limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}`,
        );
        if (rows.length > 1000)
          throw new UnprocessableEntityException(
            "本页商品超过 1000 条，请减少每页订单数或缩小筛选范围",
          );
        const grouped = await tx.execute(sql`with v as (${workProjection})
        select "queueStage" as stage, count(*)::int as count, sum(quantity)::int as quantity,
        count(*) filter(where held or "sideState"='on_hold')::int as held,
        count(*) filter(where "dueAt"<now() and "shippedQuantity"<quantity and "sideState" is distinct from 'cancelled')::int as overdue,
        count(*) filter(where "sourceChanged")::int as changed,
        count(*) filter(where "labelStatus" in ('missing','partial'))::int as missing
        from v where ${workFilter({ ...query, stage: undefined })} group by "queueStage"`);
        const countOrders = await tx.execute(
          sql`with v as (${workProjection}) select count(distinct "orderId")::int as count from v where ${workFilter({ ...query, stage: undefined })}`,
        );
        const counts: OrderQueueCounts = {
          total: 0,
          orders: Number(countOrders[0]?.count ?? 0),
          quantity: 0,
          stages: Object.fromEntries(
            OrderQueueStageSchema.options.map((stage) => [stage, 0]),
          ) as OrderQueueCounts["stages"],
          held: 0,
          overdue: 0,
          sourceChanged: 0,
          missingLabels: 0,
        };
        for (const group of grouped) {
          counts.stages[OrderQueueStageSchema.parse(group.stage)] = Number(group.count);
          counts.total += Number(group.count);
          counts.quantity += Number(group.quantity);
          counts.held += Number(group.held);
          counts.overdue += Number(group.overdue);
          counts.sourceChanged += Number(group.changed);
          counts.missingLabels += Number(group.missing);
        }
        return {
          items: rows.map(parseLine),
          total: Number(totals[0]?.total ?? 0),
          ...(query.grouping === "orders" ? { groupTotal: Number(totals[0]?.groups ?? 0) } : {}),
          page: query.page,
          pageSize: query.pageSize,
          counts,
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }
  /** Rebuild only non-PII search metadata from the current encrypted revision. */
  private async refreshSearchProjection(context: TenantContext) {
    await withTenant(this.database.db, context, async (tx) => {
      const pending = await tx
        .select({ work: items, encryptedDraft: revisions.encryptedDraft })
        .from(items)
        .innerJoin(
          revisions,
          and(eq(revisions.workItemId, items.id), eq(revisions.revision, items.revision)),
        )
        .where(sql`${items.searchRevision} <> ${items.revision}`);
      for (const { work, encryptedDraft } of pending) {
        let key: Buffer | null = null;
        let draft: OrderWorkDraft | null = null;
        try {
          key = this.key(work);
          draft = OrderWorkDraftSchema.parse(openWork(key, encryptedDraft));
        } catch {
          /* Expired/unreadable metadata remains unknown, never a guessed executor. */
        } finally {
          key?.fill(0);
        }
        await tx
          .update(items)
          .set({
            searchRevision: work.revision,
            searchSpecificationVersionId: draft?.specificationVersionId ?? null,
            searchDesignExecutor: draft ? orderDesignExecutor(draft) : null,
          })
          .where(and(eq(items.id, work.id), eq(items.revision, work.revision)));
      }
    });
  }
  async selection(context: TenantContext, raw: unknown) {
    authorize(context, Permission.OrderRead);
    const query = OrderWorkQuerySchema.parse(raw);
    await this.refreshSearchProjection(context);
    return withTenant(this.database.db, context, async (tx) => {
      const rows = await tx.execute(
        sql`with v as (${workProjection}) select * from v where ${workFilter(query)} order by "updatedAt" desc, id desc limit 101`,
      );
      if (rows.length > 100)
        throw new UnprocessableEntityException(
          "筛选结果超过 100 条商品，请缩小范围后全选；也可以按页选择，单批最多 100 条。",
        );
      return { items: rows.map(parseLine) };
    });
  }

  /** Reversible archival removes a work item from all operational queues, retaining evidence. */
  async archive(context: TenantContext, id: string, raw: unknown) {
    authorize(context, Permission.OrderWrite);
    authorize(context, Permission.OrderPiiRead);
    const input = ArchiveOrderWorkInputSchema.parse(raw);
    await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, id);
      const [work] = await tx.select().from(items).where(eq(items.id, id));
      if (!work) throw new NotFoundException("订单制作记录不存在");
      if (await replay(tx, id, input.idempotencyKey, input)) return;
      if (work.projectionVersion !== input.expectedProjectionVersion)
        throw new ConflictException("订单已更新，请刷新后重试");
      const key = this.key(work);
      try {
        await tx
          .update(items)
          .set({
            archivedAt: input.archived ? new Date() : null,
            ...(input.archived ? { held: true } : {}),
            projectionVersion: work.projectionVersion + 1,
            updatedAt: new Date(),
          })
          .where(eq(items.id, id));
        await this.event(
          tx,
          context,
          work,
          key,
          input.archived ? "archive" : "unarchive",
          work.archivedAt ? "archived" : "active",
          input.archived ? "archived" : "active",
          work.revision,
          input.reason,
          input.idempotencyKey,
          input,
        );
      } finally {
        key.fill(0);
      }
    });
    return this.detail(context, id);
  }

  async summaries(context: TenantContext, raw: unknown) {
    authorize(context, Permission.OrderRead);
    authorize(context, Permission.OrderPiiRead);
    const { ids } = OrderWorkSelectionInputSchema.parse(raw);
    const state = await withTenant(this.database.db, context, async (tx) => {
      const rows = await tx.execute(
        sql`with v as (${workProjection}) select * from v where id in (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`,`,
        )})`,
      );
      const work = await tx.select().from(items).where(inArray(items.id, ids));
      const drafts = await tx
        .select({ id: revisions.workItemId, encryptedDraft: revisions.encryptedDraft })
        .from(revisions)
        .innerJoin(
          items,
          and(eq(items.id, revisions.workItemId), eq(items.revision, revisions.revision)),
        )
        .where(inArray(items.id, ids));
      return { lines: rows.map(parseLine), work, drafts };
    });
    // Read only records resolved through RLS, and never return history or the whole design catalog.
    const reports = await this.reports.reviewDetails(
      context,
      state.lines.flatMap((line) => (line.reportLineId ? [line.reportLineId] : [])),
    );
    const result: OrderWorkSummary[] = [];
    await withTenant(this.database.db, context, async (tx) => {
      const artworks = new Map<string, Awaited<ReturnType<typeof readArtwork>>>();
      const specifications = new Map<string, Awaited<ReturnType<typeof readSpecification>>>();
      for (const line of state.lines) {
        const summary: OrderWorkSummary = {
          id: line.id,
          revision: line.revision,
          sourceVersionId: null,
          printSku: line.printSku,
          spu: null,
          specification: null,
          designExecutor: DEFAULT_ORDER_DESIGN_EXECUTOR,
          fields: [],
          instructions: "",
          images: [],
          blockers: [],
          error: null,
        };
        let key: Buffer | null = null;
        try {
          await assertActiveForRead(tx, line.id);
          const report = reports.find((report) => report.line.id === line.reportLineId) ?? null;
          const work = state.work.find((work) => work.id === line.id);
          const revision = state.drafts.find((draft) => draft.id === line.id);
          if (work) key = this.key(work);
          const draft =
            key && revision
              ? OrderWorkDraftSchema.parse(openWork(key, revision.encryptedDraft))
              : defaultDraft(report);
          if (!revision) {
            const basis = await resolveOrderSalesBasis(tx, line.id);
            if (basis.recipe) {
              draft.artworkVersionId = basis.recipe.artwork.versionId;
              draft.specificationVersionId = basis.recipe.specification.versionId;
              draft.printProfileVersionId = basis.recipe.specification.processProfileVersionId;
            }
            if (basis.status === "ambiguous")
              summary.blockers.push("商品 SKU 匹配到多个方案，需人工确认");
          }
          if (draft.artworkVersionId) {
            if (!artworks.has(draft.artworkVersionId))
              artworks.set(draft.artworkVersionId, await readArtwork(tx, draft.artworkVersionId));
            const artwork = artworks.get(draft.artworkVersionId)!;
            summary.printSku = artwork.code;
            if (artwork.assetId)
              summary.images.push({
                path: `/api/product-development/assets/${artwork.assetId}/preview`,
                label: `${artwork.code} 印花`,
                kind: "artwork",
                selected: true,
              });
            for (const field of artwork.customization.fields.filter((field) => field.required)) {
              const filled =
                field.type === "image"
                  ? draft.images.some(
                      (image) => image.usage === field.key || image.usage === field.label,
                    )
                  : draft.fields.some(
                      (value) =>
                        (value.key === field.key || value.label === field.label) &&
                        value.value?.trim(),
                    );
              if (!filled) summary.blockers.push(`缺少${field.label}`);
            }
          } else summary.blockers.push("待匹配印花 SKU");
          if (draft.specificationVersionId) {
            if (!specifications.has(draft.specificationVersionId))
              specifications.set(
                draft.specificationVersionId,
                await readSpecification(tx, draft.specificationVersionId),
              );
            const specification = specifications.get(draft.specificationVersionId)!;
            summary.spu = `${specification.spuCode} · ${specification.spuName}`;
            summary.specification = specification.name;
          } else summary.blockers.push("待匹配产品 SPU 与规格");
          summary.sourceVersionId = report?.versionId ?? null;
          summary.designExecutor = orderDesignExecutor(draft);
          summary.fields = draft.fields.map((field) => ({
            label: field.label,
            value: field.value ?? "",
          }));
          summary.instructions = draft.instructions;
          summary.images.push(
            ...(report?.files
              .filter(
                (file) =>
                  ["preview", "buyer_image"].includes(file.role) &&
                  file.mediaType.startsWith("image/"),
              )
              .map((file) => ({
                path: `/api/orders/reports/lines/${report.line.id}/files/${encodeURIComponent(file.key)}${report.versionId ? `?versionId=${report.versionId}` : ""}`,
                label: file.name,
                kind: file.role === "preview" ? ("preview" as const) : ("buyer" as const),
                selected: draft.images.some(
                  (image) => image.origin === "report" && image.key === file.key,
                ),
              })) ?? []),
          );
          summary.images.push(
            ...draft.images
              .filter((image) => image.origin === "upload")
              .map((image) => ({
                path: `/api/order-centers/lines/${line.id}/images/${image.key}`,
                label: image.usage,
                kind: "buyer" as const,
                selected: true,
              })),
          );
          if (report && !["ready", "partial"].includes(report.line.state))
            summary.blockers.push("导入定制资料尚未就绪");
          if (line.sourceChanged) summary.blockers.push("导入资料有变化，请重新核对");
          if (line.held || line.sideState) summary.blockers.push("订单已暂停或取消");
        } catch (error) {
          summary.error =
            error instanceof NotFoundException || error instanceof ConflictException
              ? error.message
              : "定制摘要暂时无法读取";
          summary.designExecutor = null;
          summary.spu = null;
          summary.specification = null;
          summary.fields = [];
          summary.instructions = "";
          summary.images = [];
        } finally {
          key?.fill(0);
        }
        result.push(summary);
      }
    });
    return { items: result };
  }

  async bulkPreview(context: TenantContext, raw: unknown): Promise<OrderBulkPreview> {
    authorize(context, Permission.OrderWrite);
    authorize(context, Permission.OrderPiiRead);
    const input = OrderBulkPreviewInputSchema.parse(raw);
    const result: OrderBulkPreview = { items: [], failures: [] };
    for (const id of [...new Set(input.ids)]) {
      try {
        const detail = await this.detail(context, id);
        const entry: OrderBulkPreview["items"][number] = {
          line: detail.line,
          changes: [],
          blockers: [],
          save: null,
          action: null,
        };
        result.items.push(entry);
        try {
          if (detail.line.held || detail.line.sideState)
            throw new ConflictException("订单已暂停或取消");
          if (detail.line.sourceChanged)
            throw new ConflictException("导入资料已变化，请逐项核对并保存后重试");
          if (detail.line.preparation === "pushed")
            throw new ConflictException("已推送设计，需先撤回任务");
          const draft = structuredClone(detail.draft);
          if (input.operation === "bind") {
            if (!input.patch.artworkVersionId && !input.patch.specificationVersionId)
              throw new UnprocessableEntityException("请选择要绑定的印花或产品规格");
            if (
              input.patch.artworkVersionId &&
              (!input.onlyEmpty || !draft.artworkVersionId) &&
              draft.artworkVersionId !== input.patch.artworkVersionId
            ) {
              const next = detail.catalog?.artworks.find(
                (artwork) => artwork.id === input.patch.artworkVersionId,
              );
              if (!next) throw new NotFoundException("印花版本不存在");
              const before = detail.catalog?.artworks.find(
                (artwork) => artwork.id === draft.artworkVersionId,
              );
              entry.changes.push(
                `印花：${before?.code ?? "未绑定"} → ${next.code} V${next.version}`,
              );
              draft.artworkVersionId = next.id;
              draft.salesRecipeVersionId = null;
              draft.salesPackageId = null;
            }
            if (
              input.patch.specificationVersionId &&
              (!input.onlyEmpty || !draft.specificationVersionId) &&
              draft.specificationVersionId !== input.patch.specificationVersionId
            ) {
              const next = detail.catalog?.specifications.find(
                (spec) => spec.id === input.patch.specificationVersionId,
              );
              if (!next) throw new NotFoundException("产品规格不存在");
              const before = detail.catalog?.specifications.find(
                (spec) => spec.id === draft.specificationVersionId,
              );
              entry.changes.push(
                `产品：${before ? `${before.spuCode} / ${before.name}` : "未绑定"} → ${next.spuCode} / ${next.name}`,
              );
              draft.specificationVersionId = next.id;
              draft.printProfileVersionId = next.processProfileVersionId;
              draft.salesRecipeVersionId = null;
              draft.salesPackageId = null;
            }
          }
          if (input.operation === "assign") {
            if (!input.patch.designExecutor && !input.patch.dueAt)
              throw new UnprocessableEntityException("请选择执行方式或内部截止时间");
            if (
              input.patch.designExecutor &&
              (!input.onlyEmpty || !draft.designExecutor) &&
              draft.designExecutor !== input.patch.designExecutor
            ) {
              entry.changes.push(
                `执行方式：${orderDesignExecutor(draft) === "agent" ? "无人设计 Agent" : "美工"} → ${input.patch.designExecutor === "agent" ? "无人设计 Agent" : "美工"}`,
              );
              draft.designExecutor = input.patch.designExecutor;
            }
            if (
              input.patch.dueAt &&
              (!input.onlyEmpty || !draft.dueAt) &&
              draft.dueAt !== input.patch.dueAt
            ) {
              entry.changes.push(`内部截止时间：${draft.dueAt ?? "未设置"} → ${input.patch.dueAt}`);
              draft.dueAt = input.patch.dueAt;
            }
          }
          const checking = ["check", "ready_to_push", "push"].includes(input.operation);
          const status = checking
            ? "ready_to_push"
            : input.operation === "needs_information"
              ? "needs_information"
              : "pending_review";
          const save = SaveOrderWorkDraftInputSchema.parse({
            expectedRevision: detail.line.revision,
            expectedProjectionVersion: detail.line.projectionVersion,
            expectedSourceVersionId: detail.report?.versionId ?? null,
            draft,
            status,
            reason: input.reason,
            idempotencyKey: randomUUID(),
          });
          await this.validateDraft(context, id, save);
          if (input.operation === "push") {
            if (detail.line.preparation !== "ready_to_push")
              throw new ConflictException("请先确认审单，保存为待推送");
            if (draft.designExecutor === "agent") authorize(context, Permission.DesignWrite);
            entry.action = {
              action: "push",
              expectedRevision: detail.line.revision,
              expectedProjectionVersion: detail.line.projectionVersion,
              reason: input.reason,
              idempotencyKey: randomUUID(),
            };
            entry.changes.push("待推送 → 设计队列");
          } else if (input.operation === "check")
            entry.changes.push("审单必填项与素材关联检查通过");
          else if (["bind", "assign"].includes(input.operation) && !entry.changes.length)
            entry.blockers.push("无需修改：所选字段已有值或与目标相同");
          else {
            entry.save = save;
            entry.changes.push(
              status === "ready_to_push"
                ? "确认审单 → 待推送"
                : status === "needs_information"
                  ? "标记待补资料"
                  : "保存新需求版本 → 待审单",
            );
          }
        } catch (error) {
          entry.blockers.push(
            error instanceof ConflictException ||
              error instanceof UnprocessableEntityException ||
              error instanceof NotFoundException
              ? error.message
              : "检查未完成，请打开商品重试",
          );
        }
      } catch {
        result.failures.push({ id, message: "商品不存在、资料已过期或当前账号无法读取" });
      }
    }
    return result;
  }
  async detail(context: TenantContext, id: string): Promise<OrderWorkDetail> {
    authorize(context, Permission.OrderRead);
    authorize(context, Permission.OrderPiiRead);
    const state = await withTenant(this.database.db, context, async (tx) => {
      const lineRows = await tx.execute(
        sql`with v as (${workProjection}) select * from v where id = ${id}`,
      );
      if (!lineRows.length) throw new NotFoundException("订单商品不存在");
      const [work] = await tx.select().from(items).where(eq(items.id, id));
      const history = await tx
        .select({ event: events, actor: users.displayName })
        .from(events)
        .leftJoin(users, eq(users.id, events.actorId))
        .where(eq(events.workItemId, id))
        .orderBy(desc(events.occurredAt), desc(events.id))
        .limit(200);
      const versions = await tx
        .select()
        .from(revisions)
        .where(eq(revisions.workItemId, id))
        .orderBy(desc(revisions.revision))
        .limit(200);
      const images = await tx
        .select()
        .from(assets)
        .where(eq(assets.workItemId, id))
        .orderBy(assets.createdAt);
      return { line: parseLine(lineRows[0]!), work, history, versions, images };
    });
    const report = state.line.reportLineId
      ? await this.reports.detail(context, state.line.reportLineId)
      : null;
    const key = state.work ? this.key(state.work) : null;
    try {
      const draft =
        key && state.versions[0]
          ? OrderWorkDraftSchema.parse(openWork(key, state.versions[0].encryptedDraft))
          : defaultDraft(report);
      const catalog = await withTenant(this.database.db, context, async (tx) => {
        const resolved = await resolveOrderSalesBasis(tx, id);
        if (!state.versions.length && resolved.recipe) {
          draft.salesRecipeVersionId = resolved.recipe.id;
          draft.salesPackageId = resolved.packageId;
          draft.artworkVersionId = resolved.recipe.artwork.versionId;
          draft.printProfileVersionId = resolved.recipe.specification.processProfileVersionId;
          draft.specificationVersionId = resolved.recipe.specification.versionId;
        }
        const choices = await orderSalesChoices(
          tx,
          draft.specificationVersionId,
          draft.artworkVersionId,
          draft.salesRecipeVersionId,
        );
        if (!draft.specificationVersionId && draft.salesRecipeVersionId)
          draft.specificationVersionId = choices.recipes.find(
            (r) => r.id === draft.salesRecipeVersionId,
          )?.specificationVersionId;
        return {
          status:
            draft.salesRecipeVersionId || (draft.artworkVersionId && draft.specificationVersionId)
              ? state.versions.length
                ? ("pinned" as const)
                : resolved.status
              : resolved.status,
          packageId: draft.salesPackageId ?? resolved.packageId,
          ...choices,
        };
      });
      return {
        catalog,
        line: state.line,
        draft,
        report,
        profile: draft.printProfileVersionId
          ? await this.profile(context, draft.printProfileVersionId)
          : null,
        assets: key
          ? state.images.map((image) => ({
              id: image.id,
              ...openWork<ImageMetadata>(key, image.encryptedMetadata),
              checksum: image.checksum,
              path: `/api/order-centers/lines/${id}/images/${image.id}`,
            }))
          : [],
        events: key
          ? state.history.map(({ event, actor }) => ({
              id: event.id,
              action: event.action,
              from: event.fromState,
              to: event.toState,
              actor: actor ?? `成员 ${event.actorId}`,
              reason: openWork<string>(key, event.encryptedReason),
              revision: event.revision,
              occurredAt: event.occurredAt.toISOString(),
            }))
          : [],
        versions: state.versions.map((version) => ({
          id: version.id,
          revision: version.revision,
          createdAt: version.createdAt.toISOString(),
        })),
      };
    } finally {
      key?.fill(0);
    }
  }
  async templatePlan(context: TenantContext, id: string): Promise<OrderTemplatePlan> {
    const detail = await this.detail(context, id);
    const plan: OrderTemplatePlan = {
      orderLineId: id,
      revision: detail.line.revision,
      sourceVersionId: detail.report?.versionId ?? null,
      ready: false,
      templateVersionId: null,
      artworkVersionId: detail.draft.artworkVersionId ?? null,
      specificationVersionId: detail.draft.specificationVersionId ?? null,
      blockers: [],
      mappings: [],
      notes: [
        "文字按买家原文排版；所有选定顾客图片经默认图像模型保真美化后，适配已配置的定制区域。",
        "条件检查不会创建生产文件。确认推送后使用固定版本制作，完成后仍需审核。",
        "图片原文件解码与校验以实际制作结果为准。",
      ],
    };
    if (!detail.line.revision) plan.blockers.push("请先保存制作需求");
    if (detail.line.held) plan.blockers.push("订单已暂停");
    if (detail.line.sourceChanged) plan.blockers.push("导入报告已有新版本，请核对并重新保存需求");
    if (detail.draft.instructions.trim())
      plan.blockers.push(
        "本单包含自由文字制作说明，请由美工核对处理，或将已确认的要求配置为定制字段和区域",
      );
    try {
      const basis = await withTenant(this.database.db, context, (tx) =>
        validateOrderSalesBasis(tx, detail.draft),
      );
      if (!basis || !detail.profile)
        throw new ConflictException("请先绑定已审核的印花 SKU、产品 SPU 规格与工艺模板");
      plan.artworkVersionId = basis.artwork.versionId;
      plan.specificationVersionId = basis.specification.versionId;
      plan.templateVersionId = basis.recipe?.editorVersionId ?? detail.profile.sourceVersionId;
      plan.mappings = basis.artwork.customization.fields.map((field) => {
        const region = basis.artwork.layout.find((r) => r.fieldKey === field.key);
        return {
          fieldKey: field.key,
          label: field.label,
          type: field.type,
          value:
            field.type === "image"
              ? `${detail.draft.images.filter((i) => i.usage === field.key || i.usage === field.label).length} 张买家原图`
              : (detail.draft.fields.find((f) => f.key === field.key || f.label === field.label)
                  ?.value ?? ""),
          region: region
            ? `${region.xPercent}%, ${region.yPercent}% · ${region.widthPercent}% × ${region.heightPercent}%`
            : null,
        };
      });
      assertAutomaticArtwork(basis.artwork.customization, basis.artwork.layout, detail.draft, detail.profile.productType, isPhotoOnlyPillowArtwork(basis.artwork));
      await this.validateImages(context, id, detail.draft, detail.line.reportLineId);
      const template = await this.editor.get(
        context,
        basis.recipe?.editorProjectId ?? detail.profile.projectId,
        plan.templateVersionId,
      );
      if (template.project.source || template.project.workSource)
        throw new ConflictException("买家订单素材不能作为通用模板");
      // A dry layout validates text glyphs and configured regions without saving buyer data.
      await composeOrderArtwork(
        template.version.document,
        basis.artwork.layout,
        basis.artwork.customization,
        detail.draft,
        detail.draft.images.map((image) => ({
          usage: image.usage,
          id: createEntityId(),
          version: 1,
          width: 1,
          height: 1,
        })),
        isPhotoOnlyPillowArtwork(basis.artwork),
      );
    } catch (cause) {
      if (
        cause instanceof ConflictException ||
        cause instanceof NotFoundException ||
        cause instanceof UnprocessableEntityException
      )
        plan.blockers.push(cause.message);
      else throw cause;
    }
    plan.ready = plan.blockers.length === 0;
    return plan;
  }
  async revision(context: TenantContext, id: string, revisionId: string) {
    authorize(context, Permission.OrderRead);
    authorize(context, Permission.OrderPiiRead);
    const work = await this.work(context, id);
    const [revision] = await withTenant(this.database.db, context, (tx) =>
      tx
        .select()
        .from(revisions)
        .where(and(eq(revisions.workItemId, id), eq(revisions.id, revisionId))),
    );
    if (!revision) throw new NotFoundException("制作需求版本不存在");
    const key = this.key(work);
    try {
      return OrderWorkDraftSchema.parse(openWork(key, revision.encryptedDraft));
    } finally {
      key.fill(0);
    }
  }
  async artworkMaterial(context: TenantContext, id: string, assetId: string) {
    authorize(context, Permission.AssetRead);
    const detail = await this.detail(context, id);
    const basis = await withTenant(this.database.db, context, (tx) =>
      validateOrderSalesBasis(tx, detail.draft),
    );
    const pin = basis?.artwork.materials.find((m) => m.assetId === assetId);
    const file = basis?.materials.find((m) => m.id === assetId);
    if (!pin || !file) throw new NotFoundException("该素材不属于本单绑定的印花版本");
    const body = await this.storage.readPrivate(
      context,
      { ...file, assetDomain: "authorized" },
      { requiredDomain: "authorized" },
    );
    if (hash(body) !== pin.checksumSha256) throw new ConflictException("印花素材校验失败");
    return { body, name: pin.fileName };
  }

  /** AI copies must not outlive the protected order source or its saved work item. */
  async analysisExpiresAt(context: TenantContext, id: string) {
    authorize(context, Permission.OrderRead);
    authorize(context, Permission.OrderPiiRead);
    const source = await this.source(context, id);
    const [work] = await withTenant(this.database.db, context, (tx) =>
      tx.select({ expiresAt: items.expiresAt }).from(items).where(eq(items.id, id)),
    );
    return new Date(Math.min(source.expiresAt.getTime(), work?.expiresAt.getTime() ?? Infinity));
  }
  private async validateDraft(
    context: TenantContext,
    id: string,
    input: ReturnType<typeof SaveOrderWorkDraftInputSchema.parse>,
  ) {
    const source = await this.source(context, id);
    if ((source.report?.currentVersionId ?? null) !== input.expectedSourceVersionId)
      throw new ConflictException("导入资料已变化，请刷新后核对差异");
    const profile = input.draft.printProfileVersionId
      ? await this.profile(context, input.draft.printProfileVersionId)
      : null;
    const salesBasis = await withTenant(this.database.db, context, (tx) =>
      validateOrderSalesBasis(tx, input.draft, input.status !== "ready_to_push"),
    );
    if (input.status === "ready_to_push") {
      const enabled = await withTenant(this.database.db, context, (tx) =>
        tx.select({ id: artworkMasters.id }).from(artworkMasters).limit(1),
      );
      if (enabled.length && !salesBasis)
        throw new ConflictException("请先匹配本单印花 SKU、产品 SPU 和具体规格，再确认派单");
      if (salesBasis) {
        for (const field of salesBasis.artwork.customization.fields.filter((f) => f.required)) {
          if (
            field.type === "image"
              ? !input.draft.images.some((i) => i.usage === field.key || i.usage === field.label)
              : !input.draft.fields.some(
                  (f) => (f.key === field.key || f.label === field.label) && f.value?.trim(),
                )
          )
            throw new ConflictException(`请补齐必填定制内容：${field.label}`);
        }
        if (orderDesignExecutor(input.draft) === "agent")
          assertAutomaticArtwork(
            salesBasis.artwork.customization,
            salesBasis.artwork.layout,
            input.draft,
            profile?.productType,
            isPhotoOnlyPillowArtwork(salesBasis.artwork),
          );
      }
    }
    await this.validateImages(context, id, input.draft, source.report?.id ?? null);
    if (input.status === "ready_to_push" && !profile)
      throw new UnprocessableEntityException("请先选择印花与工艺版本");
    return { source, profile, salesBasis };
  }
  async save(context: TenantContext, id: string, raw: unknown) {
    authorize(context, Permission.OrderWrite);
    authorize(context, Permission.OrderPiiRead);
    const input = SaveOrderWorkDraftInputSchema.parse(raw);
    input.draft.designExecutor ??= DEFAULT_ORDER_DESIGN_EXECUTOR;
    const { source, profile, salesBasis } = await this.validateDraft(context, id, input);
    await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, id);
      let [work] = await tx.select().from(items).where(eq(items.id, id));
      const previousProjectionVersion = work?.projectionVersion ?? 0;
      if (!work) {
        const key = randomBytes(32);
        [work] = await tx
          .insert(items)
          .values({
            id,
            tenantId: context.tenantId,
            reportLineId: source.report?.id,
            encryptedDataKey: this.vault.encrypt(key.toString("base64")),
            expiresAt: source.expiresAt,
          })
          .returning();
        key.fill(0);
      }
      if (await replay(tx, id, input.idempotencyKey, input)) return;
      const [currentSource] = await tx
        .select()
        .from(amazonOrderReportLines)
        .where(eq(amazonOrderReportLines.orderLineId, id))
        .for("update");
      if ((currentSource?.currentVersionId ?? null) !== input.expectedSourceVersionId)
        throw new ConflictException("导入资料已变化，请刷新后核对差异");
      if (!work || work.revision !== input.expectedRevision)
        throw new ConflictException("订单已由其他人修改，请刷新后重试");
      if (
        input.expectedProjectionVersion !== undefined &&
        previousProjectionVersion !== input.expectedProjectionVersion
      )
        throw new ConflictException("订单状态已变化，请重新预览后操作");
      if (work.held) throw new ConflictException("订单已暂停，请先解除暂停");
      if (work.preparation === "pushed")
        throw new ConflictException("请先撤回制图任务，再修改需求");
      await assertActive(tx, id);
      const key = this.key(work),
        revision = work.revision + 1;
      try {
        await tx.insert(revisions).values({
          id: createEntityId(),
          tenantId: context.tenantId,
          workItemId: id,
          revision,
          sourceVersionId: input.expectedSourceVersionId,
          profileVersionId: input.draft.printProfileVersionId,
          encryptedDraft: sealWork(key, input.draft),
          checksum: hash(JSON.stringify(input.draft)),
          createdBy: context.userId,
        });
        await tx
          .update(items)
          .set({
            revision,
            searchRevision: revision,
            searchSpecificationVersionId: input.draft.specificationVersionId ?? null,
            searchDesignExecutor: orderDesignExecutor(input.draft),
            sourceVersionId: input.expectedSourceVersionId,
            preparation: input.status,
            artwork: "not_pushed",
            proof: input.draft.customerApprovalRequired ? "pending" : "not_required",
            printSku: salesBasis?.artwork.code ?? profile?.code ?? null,
            dueAt: input.draft.dueAt ? new Date(input.draft.dueAt) : null,
            projectionVersion: work.projectionVersion + 1,
            updatedAt: new Date(),
          })
          .where(eq(items.id, id));
        await this.event(
          tx,
          context,
          work,
          key,
          "save",
          work.preparation,
          input.status,
          revision,
          input.reason,
          input.idempotencyKey,
          input,
        );
      } finally {
        key.fill(0);
      }
    });
    return this.detail(context, id);
  }
  async action(context: TenantContext, id: string, raw: unknown) {
    authorize(context, Permission.OrderWrite);
    authorize(context, Permission.OrderPiiRead);
    const input = OrderWorkActionInputSchema.parse(raw);
    if (["approve_artwork", "reject_artwork"].includes(input.action))
      authorize(context, Permission.DesignReview);
    if (["start_artwork", "submit_artwork"].includes(input.action))
      authorize(context, Permission.DesignWrite);
    if (input.action === "start_artwork") return this.startArtwork(context, id, input);
    const detail = await this.detail(context, id);
    if (input.action === "push" && orderDesignExecutor(detail.draft) === "agent")
      authorize(context, Permission.DesignWrite);
    const editor =
      input.expectedEditorVersionId && detail.line.editorProjectId
        ? await this.editor.get(context, detail.line.editorProjectId)
        : null;
    if (["submit_artwork", "approve_artwork", "reject_artwork"].includes(input.action)) {
      if (!editor || editor.version.id !== input.expectedEditorVersionId)
        throw new ConflictException("制作文件版本已变化，请重新打开任务");
      if (input.action !== "reject_artwork") {
        const check = await this.editor.preflight(context, editor.project.id, {
          expectedVersionId: editor.version.id,
          format: "png",
          background: editor.version.document.exportBackground ?? "transparent",
          purpose: "production",
        });
        if (!check.productionReady) throw new ConflictException("请先完成生产文件检查和确认");
      }
    }
    await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, id);
      const [work] = await tx.select().from(items).where(eq(items.id, id));
      if (!work) throw new NotFoundException("请先保存审单内容");
      if (await replay(tx, id, input.idempotencyKey, input)) return;
      assertVersion(work, input.expectedRevision, input.expectedProjectionVersion);
      if (work.archivedAt) throw new ConflictException("订单已归档，请先恢复记录");
      if (!["hold", "resume"].includes(input.action)) {
        await assertActive(tx, id);
        if (work.held) throw new ConflictException("订单已暂停，请先解除暂停");
      }
      const changes: Partial<typeof items.$inferInsert> = {
        updatedAt: new Date(),
        projectionVersion: work.projectionVersion + 1,
      };
      let from = work.artwork,
        to: string;
      switch (input.action) {
        case "push": {
          if (work.preparation !== "ready_to_push")
            throw new ConflictException("请先完成审单并保存为待推送");
          const [source] = await tx
            .select()
            .from(amazonOrderReportLines)
            .where(eq(amazonOrderReportLines.orderLineId, id));
          if ((source?.currentVersionId ?? null) !== work.sourceVersionId)
            throw new ConflictException("导入内容已变化，请重新核对后推送");
          const [version] = await tx
            .select()
            .from(revisions)
            .where(and(eq(revisions.workItemId, id), eq(revisions.revision, work.revision)));
          if (!version?.profileVersionId)
            throw new ConflictException("制作依据不完整，请先选择印花与工艺版本");
          const basisKey = this.key(work);
          try {
            await validateOrderSalesBasis(
              tx,
              OrderWorkDraftSchema.parse(openWork(basisKey, version.encryptedDraft)),
            );
          } finally {
            basisKey.fill(0);
          }
          Object.assign(changes, {
            preparation: "pushed",
            artwork: "queued",
            pushedRevisionId: version.id,
            editorProjectId: null,
            approvedEditorVersionId: null,
          });
          to = "queued";
          break;
        }
        case "recall": {
          if (work.preparation !== "pushed" || work.artwork === "starting")
            throw new ConflictException("当前任务不能撤回");
          const [released] = await tx
            .select({ id: productionOrders.id })
            .from(productionOrders)
            .where(
              and(
                eq(productionOrders.sourceWorkItemId, id),
                sql`${productionOrders.status} <> 'cancelled'`,
              ),
            )
            .limit(1);
          if (released) throw new ConflictException("已下达生产，请先暂停并处理工厂变更或停单");
          Object.assign(changes, {
            preparation: "pending_review",
            artwork: "not_pushed",
            pushedRevisionId: null,
            editorProjectId: null,
            approvedEditorVersionId: null,
            proof: detail.draft.customerApprovalRequired ? "pending" : "not_required",
          });
          to = "not_pushed";
          break;
        }
        case "submit_artwork":
          if (!["in_progress", "changes_requested"].includes(work.artwork))
            throw new ConflictException("只有制作中的任务可以提交审核");
          await this.editor.confirmWorkVersion(
            tx,
            context,
            id,
            work.editorProjectId!,
            input.expectedEditorVersionId!,
            false,
          );
          changes.artwork = to = "in_review";
          break;
        case "approve_artwork":
          if (work.artwork !== "in_review") throw new ConflictException("请先提交文件审核");
          await this.editor.confirmWorkVersion(
            tx,
            context,
            id,
            work.editorProjectId!,
            input.expectedEditorVersionId!,
            true,
          );
          changes.artwork = to = "approved";
          changes.approvedEditorVersionId = input.expectedEditorVersionId;
          break;
        case "reject_artwork":
          if (!["in_review", "approved"].includes(work.artwork))
            throw new ConflictException("当前任务不在审核阶段");
          if (
            (
              await tx
                .select({ id: productionOrders.id })
                .from(productionOrders)
                .where(
                  and(
                    eq(productionOrders.sourceWorkItemId, id),
                    sql`${productionOrders.status} <> 'cancelled'`,
                  ),
                )
                .limit(1)
            ).length
          )
            throw new ConflictException("已下达生产，请先处理生产变更");
          await this.editor.confirmWorkVersion(
            tx, context, id, work.editorProjectId!, input.expectedEditorVersionId!, "reject",
          );
          changes.artwork = to = "changes_requested";
          changes.approvedEditorVersionId = null;
          changes.proof = detail.draft.customerApprovalRequired ? "pending" : "not_required";
          break;
        case "approve_proof":
        case "reject_proof":
          if (work.proof === "not_required" || work.artwork !== "approved")
            throw new ConflictException("请先完成文件审核，再记录客户确认");
          from = work.proof;
          changes.proof = to = input.action === "approve_proof" ? "approved" : "changes_requested";
          break;
        case "hold":
          from = work.held ? "held" : "active";
          changes.held = true;
          to = "held";
          break;
        case "resume":
          from = work.held ? "held" : "active";
          changes.held = false;
          to = "active";
          break;
        default:
          throw new UnprocessableEntityException("不支持的操作");
      }
      const key = this.key(work);
      try {
        await tx.update(items).set(changes).where(eq(items.id, id));
        await this.event(
          tx,
          context,
          work,
          key,
          input.action,
          from,
          to,
          work.revision,
          input.reason,
          input.idempotencyKey,
          input,
        );
      } finally {
        key.fill(0);
      }
    });
    const updated = await this.detail(context, id);
    if (
      input.action === "push" &&
      orderDesignExecutor(updated.draft) === "agent" &&
      updated.line.artwork === "queued"
    ) {
      return this.startArtwork(context, id, {
        ...input,
        action: "start_artwork",
        expectedRevision: updated.line.revision,
        expectedProjectionVersion: updated.line.projectionVersion,
        idempotencyKey: createEntityId(),
        reason: "无人设计 Agent 准备模板排版并提交顾客图片保真美化",
      });
    }
    return updated;
  }
  private async startArtwork(
    context: TenantContext,
    id: string,
    input: ReturnType<typeof OrderWorkActionInputSchema.parse>,
  ) {
    const detail = await this.detail(context, id);
    if (detail.line.editorProjectId) return detail;
    const revision = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, id);
      const [work] = await tx.select().from(items).where(eq(items.id, id));
      if (!work) throw new NotFoundException("制作任务不存在");
      assertVersion(work, input.expectedRevision, input.expectedProjectionVersion);
      await assertActive(tx, id);
      if (work.held || !["queued", "starting"].includes(work.artwork) || !work.pushedRevisionId)
        throw new ConflictException("任务尚未推送或已被领取");
      if (work.artwork === "starting") {
        if (Date.now() - work.updatedAt.getTime() < 10 * 60000)
          throw new ConflictException("素材正在准备，请刷新查看；若十分钟后仍未完成，可重试领取");
        await this.editor.discardInterruptedWork(tx, id, work.pushedRevisionId);
      }
      await tx
        .update(items)
        .set({
          artwork: "starting",
          projectionVersion: work.projectionVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(items.id, id));
      return { work, revisionId: work.pushedRevisionId };
    });
    let createdProjectId: string | undefined;
    try {
      if (!detail.profile) throw new ConflictException("任务缺少印花与工艺版本");
      const salesBasis = await withTenant(this.database.db, context, (tx) =>
        validateOrderSalesBasis(tx, detail.draft),
      );
      const template = await this.editor.get(
        context,
        salesBasis?.recipe?.editorProjectId ?? detail.profile.projectId,
        salesBasis?.recipe?.editorVersionId ?? detail.profile.sourceVersionId,
      );
      const artworkOverride = salesBasis?.asset
        ? {
            name: salesBasis.artwork.code,
            bytes: await this.storage.readPrivate(
              context,
              { ...salesBasis.asset, assetDomain: "authorized" },
              { requiredDomain: "authorized" },
            ),
          }
        : undefined;
      if (
        salesBasis?.asset &&
        artworkOverride &&
        hash(artworkOverride.bytes) !== salesBasis.asset.checksumSha256
      )
        throw new ConflictException("印花主文件内容已变化，请核对素材版本");
      const artworkMaterials: Array<{ name: string; bytes: Uint8Array; kind: "image" | "font" }> =
        [];
      if (salesBasis)
        for (const pin of salesBasis.artwork.materials.filter(
          (m) => m.role !== "master" && m.role !== "reference",
        )) {
          const file = salesBasis.materials.find((m) => m.id === pin.assetId)!;
          const kind = ["image/png", "image/jpeg", "image/webp"].includes(file.mediaType)
            ? ("image" as const)
            : pin.role === "font" && /\.(ttf|otf)$/i.test(file.fileName)
              ? ("font" as const)
              : null;
          if (kind) {
            const bytes = await this.storage.readPrivate(
              context,
              { ...file, assetDomain: "authorized" },
              { requiredDomain: "authorized" },
            );
            if (hash(bytes) !== pin.checksumSha256)
              throw new ConflictException(`印花素材内容已变化：${pin.usage}`);
            artworkMaterials.push({
              name: `${salesBasis.artwork.code} · ${pin.usage} · ${file.fileName}`,
              kind,
              bytes,
            });
          }
        }
      if (template.project.source || template.project.workSource)
        throw new ConflictException("买家订单素材不能作为通用印花");
      const originals: Array<{ name: string; bytes: Uint8Array }> = [];
      for (const selection of detail.draft.images) {
        if (selection.origin === "upload") {
          const file = await this.image(context, id, selection.key, true);
          originals.push({ name: `${selection.usage} · ${file.name}`, bytes: file.body });
        } else {
          if (!revision.work.reportLineId || !revision.work.sourceVersionId)
            throw new ConflictException("推送时缺少买家原图版本");
          const file = await this.reports.originalFromVersion(
            context,
            revision.work.reportLineId,
            revision.work.sourceVersionId,
            selection.key,
          );
          originals.push({ name: `${selection.usage} · ${file.name}`, bytes: file.body });
        }
      }
      const result = await this.editor.createFromWork(context, {
        workItemId: id,
        revisionId: revision.revisionId,
        expiresAt: revision.work.expiresAt,
        name: `${detail.line.externalOrderId} · ${detail.line.skuCode ?? detail.line.title}`.slice(
          0,
          160,
        ),
        template,
        originals,
        artworkOverride,
        artworkMaterials,
        copyTemplateLayers: salesBasis ? !!salesBasis.asset : true,
        ...(orderDesignExecutor(detail.draft) === "agent" && salesBasis
          ? {
              automaticLayout: {
                photoOnlyPillow: isPhotoOnlyPillowArtwork(salesBasis.artwork),
                layout: salesBasis.artwork.layout,
                customization: salesBasis.artwork.customization,
                draft: detail.draft,
              },
            }
          : {}),
      });
      createdProjectId = result.project.id;
      await withTenant(this.database.db, context, async (tx) => {
        await lock(tx, id);
        const [work] = await tx.select().from(items).where(eq(items.id, id));
        if (!work || work.artwork !== "starting" || work.pushedRevisionId !== revision.revisionId)
          throw new ConflictException("任务已变化，请重新打开");
        await tx
          .update(items)
          .set({
            editorProjectId: result.project.id,
            artwork: "in_progress",
            projectionVersion: work.projectionVersion + 1,
            updatedAt: new Date(),
          })
          .where(eq(items.id, id));
        const key = this.key(work);
        try {
          await this.event(
            tx,
            context,
            work,
            key,
            "start_artwork",
            "queued",
            "in_progress",
            work.revision,
            input.reason,
            input.idempotencyKey,
            input,
          );
        } finally {
          key.fill(0);
        }
      });
    } catch (error) {
      if (createdProjectId) await this.editor.remove(context, createdProjectId);
      await withTenant(this.database.db, context, async (tx) => {
        await lock(tx, id);
        const [work] = await tx.select().from(items).where(eq(items.id, id));
        if (!work || work.artwork !== "starting") return;
        await tx
          .update(items)
          .set({
            artwork: "queued",
            projectionVersion: sql`${items.projectionVersion} + 1`,
            updatedAt: new Date(),
          })
          .where(and(eq(items.id, id), eq(items.artwork, "starting")));
        const key = this.key(work);
        try {
          await this.event(
            tx,
            context,
            work,
            key,
            "artwork_failed",
            "starting",
            "queued",
            work.revision,
            error instanceof ConflictException
              ? error.message
              : "素材准备未完成，可重试；若需修改执行方式，请撤回后交给美工。",
            createEntityId(),
            { action: "artwork_failed", revisionId: revision.revisionId },
          );
        } finally {
          key.fill(0);
        }
      });
      throw error;
    }
    return this.detail(context, id);
  }
  async profiles(context: TenantContext): Promise<PrintProfileView[]> {
    authorize(context, Permission.OrderRead);
    const rows = await withTenant(this.database.db, context, (tx) =>
      tx
        .select({ profile: printProfiles, version: printProfileVersions })
        .from(printProfiles)
        .innerJoin(
          printProfileVersions,
          and(
            eq(printProfiles.id, printProfileVersions.profileId),
            eq(printProfiles.versionNumber, printProfileVersions.versionNumber),
          ),
        )
        .orderBy(printProfiles.code),
    );
    return rows.map(profileView);
  }
  async profile(context: TenantContext, versionId: string): Promise<PrintProfileView> {
    authorize(context, Permission.OrderRead);
    const [row] = await withTenant(this.database.db, context, (tx) =>
      tx
        .select({ profile: printProfiles, version: printProfileVersions })
        .from(printProfileVersions)
        .innerJoin(printProfiles, eq(printProfiles.id, printProfileVersions.profileId))
        .where(eq(printProfileVersions.id, versionId)),
    );
    if (!row) throw new NotFoundException("印花与工艺版本不存在");
    return profileView(row);
  }
  async saveProfile(context: TenantContext, raw: unknown) {
    authorize(context, Permission.DesignWrite);
    authorize(context, Permission.DesignReview);
    const input = PrintProfileInputSchema.parse(raw),
      template = await this.editor.get(context, input.projectId, input.versionId);
    if (template.project.source || template.project.workSource || template.project.catalogSource)
      throw new UnprocessableEntityException("订单或销售 SKU 素材不能登记为通用工艺底稿");
    if (!template.version.reviewed || !template.version.document.confirmations.physicalSize)
      throw new ConflictException("请先在底稿中确认物理规格并审核该版本");
    await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `profile:${input.code.toLowerCase()}`);
      const [replayed] = await tx
        .select()
        .from(printProfileVersions)
        .where(eq(printProfileVersions.idempotencyKey, input.idempotencyKey));
      if (replayed) {
        if (replayed.requestHash !== hash(JSON.stringify(input)))
          throw new ConflictException("重试内容已变化");
        return;
      }
      let [profile] = await tx
        .select()
        .from(printProfiles)
        .where(sql`lower(${printProfiles.code}) = ${input.code.toLowerCase()}`);
      if ((profile?.versionNumber ?? 0) !== input.expectedVersion)
        throw new ConflictException("印花版本已变化，请刷新");
      if (!profile)
        [profile] = await tx
          .insert(printProfiles)
          .values({ id: createEntityId(), tenantId: context.tenantId, code: input.code })
          .returning();
      const versionNumber = input.expectedVersion + 1;
      await tx.insert(printProfileVersions).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        profileId: profile!.id,
        versionNumber,
        name: input.name,
        productType: template.version.document.productType,
        projectId: input.projectId,
        sourceVersionId: input.versionId,
        instructions: input.instructions,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash(JSON.stringify(input)),
        createdBy: context.userId,
      });
      await tx
        .update(printProfiles)
        .set({ versionNumber })
        .where(eq(printProfiles.id, profile!.id));
    });
    return this.profiles(context);
  }
  async upload(context: TenantContext, id: string, name: string, bytes: Uint8Array) {
    authorize(context, Permission.OrderWrite);
    authorize(context, Permission.OrderPiiRead);
    if (!bytes.byteLength || bytes.byteLength > 32 * 1024 * 1024)
      throw new UnprocessableEntityException("图片最大 32 MiB");
    const work = await this.work(context, id);
    if (work.preparation === "pushed") throw new ConflictException("请先撤回任务，再替换图片");
    const scan = await this.scanner.scan(bytes, name, "application/octet-stream");
    if (scan.result !== "clean" || scan.signatureVersion === "unavailable")
      throw new UnprocessableEntityException("图片未通过安全扫描");
    const image = sharp(bytes, { limitInputPixels: 100000000, failOn: "warning", pages: 1 }),
      info = await image.metadata();
    if (
      !info.width ||
      !info.height ||
      !["png", "jpeg", "tiff"].includes(info.format ?? "") ||
      (info.pages ?? 1) !== 1
    )
      throw new UnprocessableEntityException("请选择单页 PNG、JPEG 或 TIFF 图片");
    const preview = await image
      .rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    const imageId = createEntityId(),
      key = this.key(work),
      rotated = (info.orientation ?? 0) >= 5;
    try {
      const original = await this.storage.putPrivate(context, {
        domain: "order",
        body: encryptProductionBytes(key, bytes),
        fileName: `${imageId}.pe`,
        mediaType: "application/octet-stream",
      });
      const thumbnail = await this.storage.putPrivate(context, {
        domain: "order",
        body: encryptProductionBytes(key, preview),
        fileName: `${imageId}-preview.pe`,
        mediaType: "application/octet-stream",
      });
      await withTenant(this.database.db, context, async (tx) => {
        await lock(tx, id);
        await assertActive(tx, id);
        const [current] = await tx.select().from(items).where(eq(items.id, id));
        if (!current?.encryptedDataKey || current.preparation === "pushed")
          throw new ConflictException("订单已推送，请刷新");
        await tx.insert(assets).values({
          id: imageId,
          tenantId: context.tenantId,
          workItemId: id,
          objectKey: original.objectKey,
          previewObjectKey: thumbnail.objectKey,
          checksum: hash(bytes),
          encryptedMetadata: sealWork(key, {
            name: name.split(/[\\/]/).at(-1)!.slice(0, 200),
            mediaType: `image/${info.format}`,
            width: rotated ? info.height : info.width,
            height: rotated ? info.width : info.height,
          }),
        });
      });
    } finally {
      key.fill(0);
    }
    return this.detail(context, id);
  }
  async image(context: TenantContext, id: string, imageId: string, original = false) {
    authorize(context, Permission.OrderPiiRead);
    authorize(context, Permission.OrderRead);
    const work = await this.work(context, id),
      key = this.key(work);
    const [image] = await withTenant(this.database.db, context, (tx) =>
      tx
        .select()
        .from(assets)
        .where(and(eq(assets.workItemId, id), eq(assets.id, imageId))),
    );
    if (!image) throw new NotFoundException("订单图片不存在");
    try {
      const metadata = openWork<ImageMetadata>(key, image.encryptedMetadata);
      const body = await this.storage.readPrivate(
        context,
        {
          id: image.id,
          tenantId: context.tenantId,
          assetDomain: "order",
          objectKey: original ? image.objectKey : image.previewObjectKey,
        },
        { requiredDomain: "order" },
      );
      await this.work(context, id);
      return {
        body: decryptProductionBytes(key, body),
        name: metadata.name,
        mediaType: original ? metadata.mediaType : "image/png",
      };
    } finally {
      key.fill(0);
    }
  }
  async reportImage(context: TenantContext, id: string, selectionIndex: number) {
    const work = await this.work(context, id),
      key = this.key(work);
    try {
      const [revision] = await withTenant(this.database.db, context, (tx) =>
        tx
          .select()
          .from(revisions)
          .where(and(eq(revisions.workItemId, id), eq(revisions.revision, work.revision))),
      );
      const draft = OrderWorkDraftSchema.parse(openWork(key, revision!.encryptedDraft)),
        selected = draft.images[selectionIndex];
      if (selected?.origin !== "report" || !work.reportLineId || !work.sourceVersionId)
        throw new NotFoundException("已确认的图片不存在");
      const file = await this.reports.originalFromVersion(
        context,
        work.reportLineId,
        work.sourceVersionId,
        selected.key,
      );
      const body = await sharp(file.body, { limitInputPixels: 100000000 })
        .rotate()
        .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer();
      await this.work(context, id);
      return { body, mediaType: "image/png" };
    } finally {
      key.fill(0);
    }
  }
  private async validateImages(
    context: TenantContext,
    id: string,
    draft: OrderWorkDraft,
    reportId: string | null,
  ) {
    const report = reportId ? await this.reports.detail(context, reportId) : null;
    const uploads = await withTenant(this.database.db, context, (tx) =>
      tx.select({ id: assets.id }).from(assets).where(eq(assets.workItemId, id)),
    );
    for (const image of draft.images)
      if (
        image.origin === "report"
          ? !report?.files.some(
              (file) =>
                file.key === image.key && file.role === "buyer_image" && file.originalFileKey,
            )
          : !uploads.some((file) => file.id === image.key)
      )
        throw new UnprocessableEntityException("选择的图片不属于当前订单或原图不可用");
  }
  private async source(context: TenantContext, id: string) {
    return withTenant(this.database.db, context, async (tx) => {
      const [line] = await tx
        .select({ id: orderLines.id, status: orders.addressStatus })
        .from(orderLines)
        .innerJoin(orders, eq(orders.id, orderLines.orderId))
        .where(eq(orderLines.id, id));
      if (!line || line.status === "anonymized")
        throw new NotFoundException("订单不存在或资料已清理");
      const [report] = await tx
        .select()
        .from(amazonOrderReportLines)
        .where(eq(amazonOrderReportLines.orderLineId, id));
      if (report && (report.state === "expired" || report.expiresAt <= new Date()))
        throw new ConflictException("订单定制资料已过期");
      return { report, expiresAt: report?.expiresAt ?? new Date(Date.now() + 30 * 86400000) };
    });
  }
  private async work(context: TenantContext, id: string) {
    await this.source(context, id);
    const [row] = await withTenant(this.database.db, context, (tx) =>
      tx.select().from(items).where(eq(items.id, id)),
    );
    if (!row || !row.encryptedDataKey || row.expiresAt <= new Date())
      throw new NotFoundException("请先保存订单资料，或资料已到保存期限");
    return row;
  }
  private key(work: Work) {
    if (!work.encryptedDataKey || work.expiresAt <= new Date())
      throw new NotFoundException("订单资料已到保存期限");
    return this.vault.withSecret(work.encryptedDataKey, (secret) => Buffer.from(secret, "base64"));
  }
  private async event(
    tx: TenantTransaction,
    context: TenantContext,
    work: Work,
    key: Uint8Array,
    action: string,
    from: string,
    to: string,
    revision: number,
    reason: string,
    idempotencyKey: string,
    request: unknown,
  ) {
    await tx.insert(events).values({
      id: createEntityId(),
      tenantId: context.tenantId,
      workItemId: work.id,
      action,
      fromState: from,
      toState: to,
      revision,
      encryptedReason: sealWork(key, reason),
      idempotencyKey,
      requestHash: hash(JSON.stringify(request)),
      actorId: context.userId,
    });
  }
}
function profileView({
  profile,
  version,
}: {
  profile: typeof printProfiles.$inferSelect;
  version: typeof printProfileVersions.$inferSelect;
}): PrintProfileView {
  return {
    id: profile.id,
    versionId: version.id,
    code: profile.code,
    name: version.name,
    versionNumber: version.versionNumber,
    productType: version.productType as PrintProfileView["productType"],
    projectId: version.projectId,
    sourceVersionId: version.sourceVersionId,
    instructions: version.instructions,
    createdAt: version.createdAt.toISOString(),
  };
}
function parseLine(row: Record<string, unknown>) {
  return OrderWorkListItemSchema.parse(
    Object.fromEntries(
      Object.entries(row)
        .filter(([key]) => key !== "batchId")
        .map(([key, value]) => [
          key,
          value != null &&
          ["placedAt", "updatedAt", "dueAt", "importedAt", "dispatchedAt", "archivedAt"].includes(
            key,
          )
            ? new Date(value as string | Date).toISOString()
            : value,
        ]),
    ),
  );
}
function defaultDraft(report: AmazonReportDetailView | null): OrderWorkDraft {
  return {
    designExecutor: DEFAULT_ORDER_DESIGN_EXECUTOR,
    printProfileVersionId: null,
    fields:
      report?.surfaces.flatMap((surface, surfaceIndex) =>
        surface.fields.map((field, index) => ({
          ...field,
          key: `surface-${surfaceIndex}-field-${index}`,
        })),
      ) ?? [],
    images: [],
    instructions: "",
    customerApprovalRequired: false,
    dueAt: null,
  };
}
export async function lock(tx: TenantTransaction, id: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`order-work:${id}`}, 0))`);
}
async function replay(tx: TenantTransaction, id: string, key: string, input: unknown) {
  const [event] = await tx
    .select()
    .from(events)
    .where(and(eq(events.workItemId, id), eq(events.idempotencyKey, key)));
  if (event && event.requestHash !== hash(JSON.stringify(input)))
    throw new ConflictException("同一次重试的内容不能改变");
  return !!event;
}
export function assertVersion(work: Work, revision: number, projection: number) {
  if (work.revision !== revision || work.projectionVersion !== projection)
    throw new ConflictException("订单内容或状态已变化，请刷新后再操作");
}
export async function assertActive(tx: TenantTransaction, id: string) {
  const [record] = await tx
    .select({
      state: orders.sideState,
      address: orders.addressStatus,
      archivedAt: items.archivedAt,
    })
    .from(orderLines)
    .innerJoin(orders, eq(orderLines.orderId, orders.id))
    .leftJoin(items, eq(items.id, orderLines.id))
    .where(eq(orderLines.id, id));
  if (!record || record.state || record.archivedAt || record.address === "anonymized")
    throw new ConflictException("订单已暂停、取消或资料已清理");
}

async function assertActiveForRead(tx: TenantTransaction, id: string) {
  const [row] = await tx
    .select({ status: orders.addressStatus })
    .from(orderLines)
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .where(eq(orderLines.id, id));
  if (!row || row.status === "anonymized") throw new NotFoundException("订单资料已清理");
}
