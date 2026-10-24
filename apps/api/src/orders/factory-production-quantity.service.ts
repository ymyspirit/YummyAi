import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { ProductionQuantityReportInputSchema } from "@yummyai/contracts/order/production-quantity";
import {
  FactoryQuantityHistoryEntrySchema, FactoryQuantityHistoryQuerySchema, FactoryQuantityReportInputSchema,
  FactoryQuantityReportResultSchema, FactoryQuantityReportViewSchema, FactoryQuantityWorkspaceSchema,
  type FactoryQuantityReportInput,
} from "@yummyai/contracts/suppliers/factory-quantity";
import { factoryQuantityReportOrigins as origins, productionQuantityReviews, withTenant,
  type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { requireFactoryTask } from "./factory-access.js";
import { OrderProductionDeliveryService } from "./order-production-delivery.service.js";
import { appendProductionQuantityReport, lockProductionQuantityReportRequest } from "./production-quantity.service.js";
import { factoryQuantityAccess, readFactoryProductionQuantityBasis, readFactoryQuantityTask,
  type FactoryQuantityTask } from "./factory-production-quantity-basis.js";

const readOptions = { isolationLevel: "repeatable read", accessMode: "read write" } as const;
const entityId = (value: string) => EntityIdSchema.parse(value).toLowerCase();
type Origin = typeof origins.$inferSelect;
type ReportProjection = Pick<Origin, "reportId" | "assignmentId" | "input" | "createdAt">;

function normalizedInput(raw: unknown): FactoryQuantityReportInput {
  const value = FactoryQuantityReportInputSchema.parse(raw);
  const fraction = /\.(\d+)/.exec(value.observedAt)?.[1];
  if (fraction && /[1-9]/.test(fraction.slice(3)))
    throw new UnprocessableEntityException({ code: "factory_quantity_time_invalid", message: "清点发生时间须能精确表示到毫秒" });
  return FactoryQuantityReportInputSchema.parse({ ...value, idempotencyKey: value.idempotencyKey.toLowerCase(),
    acceptedFeedbackId: entityId(value.acceptedFeedbackId), observedAt: new Date(value.observedAt).toISOString() });
}

function request(assignmentId: string, input: FactoryQuantityReportInput) {
  const canonical = canonicalJson({ version: 1, operation: "factory-report", assignmentId, input });
  return { canonical, checksum: createHash("sha256").update(canonical).digest("hex") };
}

function reportView(row: ReportProjection) {
  return FactoryQuantityReportViewSchema.parse({ reportId: row.reportId, assignmentId: row.assignmentId, origin: "factory",
    scope: "full_production_version", input: row.input, recordedAt: row.createdAt.toISOString() });
}

function conflict(code: string): never {
  throw new ConflictException({ code, message: "原任务或数量依据已变化 请保留清点填写并重新核对" });
}

function assertPrivateTask(task: FactoryQuantityTask) {
  if (!task.source.privateCurrent)
    throw new NotFoundException({ code: "factory_quantity_not_found", message: "工厂任务不存在或制作资料已失效" });
}

@Injectable()
export class FactoryProductionQuantityService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(OrderProductionDeliveryService) private readonly deliveries: OrderProductionDeliveryService,
    @Inject(AuditService) private readonly audit: AuditService) {}

  private async task(tx: TenantTransaction, context: TenantContext, assignmentId: string, respond = false) {
    return readFactoryQuantityTask(tx, context, await this.deliveries.factoryQuantitySourceInTransaction(tx, context, assignmentId, respond));
  }

  async access(context: TenantContext, assignmentId: string) {
    authorize(context, Permission.FactoryTaskRead);
    assignmentId = entityId(assignmentId);
    return withTenant(this.database.db, context, async tx => factoryQuantityAccess(context, await this.task(tx, context, assignmentId)), readOptions);
  }

  async workspace(context: TenantContext, assignmentId: string, rawQuery: unknown = {}) {
    authorize(context, Permission.FactoryTaskRead);
    assignmentId = entityId(assignmentId);
    const query = FactoryQuantityHistoryQuerySchema.parse(rawQuery), before = query.before && entityId(query.before);
    return withTenant(this.database.db, context, async tx => {
      const task = await this.task(tx, context, assignmentId);
      assertPrivateTask(task);
      const state = await readFactoryProductionQuantityBasis(tx, context, task);
      if (before && !(await tx.select({ id: origins.reportId }).from(origins).where(and(eq(origins.reportId, before),
        eq(origins.assignmentId, assignmentId), eq(origins.createdBy, context.userId))).limit(1)).length)
        throw new BadRequestException({ code: "factory_quantity_cursor_invalid", message: "清点分页位置不属于本人原任务" });
      const rows = await tx.select({ reportId: origins.reportId, assignmentId: origins.assignmentId, input: origins.input,
        createdAt: origins.createdAt, reviewedAt: productionQuantityReviews.createdAt }).from(origins)
        .leftJoin(productionQuantityReviews, and(eq(productionQuantityReviews.tenantId, origins.tenantId), eq(productionQuantityReviews.reportId, origins.reportId)))
        .where(and(eq(origins.assignmentId, assignmentId), eq(origins.createdBy, context.userId), before ? lt(origins.reportId, before) : undefined))
        .orderBy(desc(origins.reportId)).limit(query.limit + 1);
      return FactoryQuantityWorkspaceSchema.parse({ ...factoryQuantityAccess(context, task, state.canReport), basis: state.basis,
        reports: rows.slice(0, query.limit).map(row => FactoryQuantityHistoryEntrySchema.parse({ ...reportView(row), reviewedAt: row.reviewedAt?.toISOString() ?? null })),
        nextCursor: rows.length > query.limit ? rows[query.limit - 1]!.reportId : null });
    }, readOptions);
  }

  async recordReport(context: TenantContext, assignmentId: string, raw: unknown) {
    authorize(context, Permission.FactoryTaskRead);
    authorize(context, Permission.FactoryTaskRespond);
    assignmentId = entityId(assignmentId);
    const input = normalizedInput(raw), identity = request(assignmentId, input), reportKey = "factory-quantity:" + input.idempotencyKey;
    return withTenant(this.database.db, context, async tx => {
      await lockProductionQuantityReportRequest(tx, context, reportKey);
      const scope = await requireFactoryTask(tx, context, assignmentId, true);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'production-delivery-item:' + scope.item.id},0))`);
      await tx.execute(sql`select production_quantity_lock(${context.tenantId}::uuid,${scope.item.productionOrderId}::uuid)`);
      const task = await this.task(tx, context, assignmentId, true);
      assertPrivateTask(task);
      const [previous] = await tx.select().from(origins).where(eq(origins.idempotencyKey, input.idempotencyKey)).limit(1);
      if (previous) {
        if (previous.createdBy !== context.userId || previous.assignmentId !== assignmentId || previous.requestCanonical !== identity.canonical ||
            previous.requestChecksum !== identity.checksum) conflict("factory_quantity_request_mismatch");
        return FactoryQuantityReportResultSchema.parse({ ...factoryQuantityAccess(context, task), report: reportView(previous), replayed: true });
      }

      const state = await readFactoryProductionQuantityBasis(tx, context, task);
      if (!state.canReport) conflict("factory_quantity_source_unavailable");
      if (input.expectedBasisFingerprint !== state.basis.fingerprint || input.acceptedFeedbackId !== task.acceptedFeedbackId ||
          input.fileChecksum !== state.basis.fileChecksum || input.manufacturingChecksum !== state.basis.manufacturingChecksum)
        conflict("factory_quantity_basis_changed");
      const reportInput = ProductionQuantityReportInputSchema.parse({ idempotencyKey: reportKey,
        productionVersionId: state.internal.productionVersionId, expectedProductionProjectionVersion: state.internal.projectionVersion,
        expectedReviewId: state.internal.reviewId, expectedBasisFingerprint: state.internal.fingerprint,
        observedAt: input.observedAt, quantities: input.quantities, evidenceCode: input.evidenceCode, evidenceAssetIds: [] });
      const saved = await appendProductionQuantityReport(tx, context, scope.item.productionOrderId, reportInput, this.audit);
      if (saved.replayed) conflict("factory_quantity_request_mismatch");
      const [origin] = await tx.insert(origins).values({ reportId: saved.row.id, tenantId: context.tenantId, assignmentId,
        acceptedFeedbackId: input.acceptedFeedbackId, productionOrderId: scope.item.productionOrderId,
        productionVersionId: saved.row.productionVersionId, factoryId: scope.package.factoryId!, factoryName: scope.factoryName,
        input, idempotencyKey: input.idempotencyKey, requestCanonical: identity.canonical, requestChecksum: identity.checksum,
        creationTransactionId: sql`pg_current_xact_id()::text`, createdBy: context.userId }).returning();
      await this.audit.recordInTransaction(tx, context, { action: "factory_portal.quantity_reported", resourceType: "factory_quantity_report",
        resourceId: saved.row.id, result: "success", metadata: { assignmentId, acceptedFeedbackId: input.acceptedFeedbackId,
          productionVersionId: saved.row.productionVersionId } });
      const currentTask = await this.task(tx, context, assignmentId, true);
      assertPrivateTask(currentTask);
      return FactoryQuantityReportResultSchema.parse({ ...factoryQuantityAccess(context, currentTask), report: reportView(origin!), replayed: false });
    });
  }
}
