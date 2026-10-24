import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { authorize, ForbiddenError, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  FactoryGrantCreateSchema,
  FactoryAccessRevokeSchema,
  FactoryTaskAssignSchema,
  FactoryGrantQuerySchema,
  FactoryTaskQuerySchema,
  FactoryGrantViewSchema,
  FactoryAssignmentViewSchema,
  FactoryAssignmentListSchema,
  FactoryCollaborationWorkspaceSchema,
} from "@yummyai/contracts/suppliers/factory-portal";
import {
  factoryAccessGrants as grants,
  factoryTaskAssignments as assignments,
  fulfillmentFactories as factories,
  fulfillmentSuppliers as suppliers,
  memberships,
  users,
  type DatabaseConnection,
  type TenantTransaction,
  withTenant,
} from "@yummyai/database";
import { and, asc, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { OrderProductionDeliveryService } from "./order-production-delivery.service.js";
import { factoryCursor, factoryCursorBefore, factoryCursorTimestamp, nextFactoryCursor, resolveFactoryCursor } from "./factory-pagination.js";
import { retryDatabaseTimeRollback } from "../database-time-retry.js";

const checksum = (input: unknown) =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");
@Injectable()
export class FactoryCollaborationService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OrderProductionDeliveryService)
    private readonly deliveries: OrderProductionDeliveryService,
  ) {}
  async workspace(context: TenantContext, raw: unknown) {
    this.access(context);
    const input = FactoryGrantQuerySchema.parse(raw),
      cursor = factoryCursor(input.cursor),
      search = input.q ? `%${input.q}%` : undefined;
    return withTenant(this.database.db, context, async (tx) => {
      const factoryRows = await tx
        .select({
          id: factories.id,
          name: factories.name,
          supplierId: factories.supplierId,
          status: factories.status,
        })
        .from(factories)
        .where(input.factoryId ? eq(factories.id, input.factoryId) : undefined)
        .orderBy(asc(factories.name), asc(factories.id))
        .limit(101);
      const memberRows = await tx
        .select({ id: memberships.id, displayName: users.displayName, email: users.email })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.status, "active"),
            search ? or(ilike(users.displayName, search), ilike(users.email, search)) : undefined,
          ),
        )
        .orderBy(asc(users.displayName), asc(memberships.id))
        .limit(101);
      const visible = and(
        input.factoryId ? eq(grants.factoryId, input.factoryId) : undefined,
        search ? or(ilike(users.displayName, search), ilike(users.email, search), ilike(factories.name, search)) : undefined,
      );
      const [anchor] = cursor ? await this.grantRows(tx).where(and(visible, eq(grants.id, cursor.id))).limit(1) : [];
      const position = resolveFactoryCursor(cursor, anchor ? { id: anchor.grant.id, createdAtExact: anchor.createdAtExact } : undefined);
      const rows = await this.grantRows(tx)
        .where(and(visible, factoryCursorBefore(grants.createdAt, grants.id, position)))
        .orderBy(desc(grants.createdAt), desc(grants.id))
        .limit(input.limit + 1);
      const last = rows[Math.min(rows.length, input.limit) - 1];
      return FactoryCollaborationWorkspaceSchema.parse({
        factories: factoryRows.slice(0, 100),
        members: memberRows.slice(0, 100),
        grants: rows.slice(0, input.limit).map((row) => this.grantView(row)),
        nextCursor: nextFactoryCursor(
          last ? { id: last.grant.id, createdAtExact: last.createdAtExact } : undefined,
          rows.length > input.limit,
        ),
        choicesTruncated: factoryRows.length > 100 || memberRows.length > 100,
      });
    });
  }
  async createGrant(context: TenantContext, raw: unknown) {
    this.access(context, true);
    const input = FactoryGrantCreateSchema.parse(raw),
      requestChecksum = checksum({ actor: context.userId, ...input });
    return withTenant(this.database.db, context, async (tx) => {
      await this.lock(tx, `factory-grant-request:${context.tenantId}:${input.idempotencyKey}`);
      const [old] = await tx
        .select()
        .from(grants)
        .where(eq(grants.idempotencyKey, input.idempotencyKey));
      if (old) {
        if (old.requestChecksum !== requestChecksum)
          throw new ConflictException("同一次工厂授权重试内容不能改变");
        return this.getGrant(tx, old.id);
      }
      await this.lock(tx, `factory-grant-member:${input.factoryId}:${input.membershipId}`);
      const [member] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.id, input.membershipId), eq(memberships.status, "active")))
        .for("share");
      const [factory] = await tx
        .select({ id: factories.id })
        .from(factories)
        .innerJoin(suppliers, eq(suppliers.id, factories.supplierId))
        .where(
          and(
            eq(factories.id, input.factoryId),
            eq(factories.status, "active"),
            eq(suppliers.status, "active"),
          ),
        )
        .for("share");
      if (!member || !factory) throw new NotFoundException("当前成员或工厂不可用");
      const [active] = await tx
        .select({ id: grants.id })
        .from(grants)
        .where(
          and(
            eq(grants.factoryId, input.factoryId),
            eq(grants.membershipId, input.membershipId),
            isNull(grants.revokedAt),
          ),
        );
      if (active) throw new ConflictException("请先撤销该成员的原工厂授权，再建立新授权");
      await this.assertExpiry(tx, input.expiresAt);
      const id = createEntityId();
      await tx
        .insert(grants)
        .values({
          ...input,
          id,
          tenantId: context.tenantId,
          expiresAt: new Date(input.expiresAt),
          requestChecksum,
          createdBy: context.userId,
        });
      await this.audit.recordInTransaction(tx, context, {
        action: "factory_collaboration.grant",
        resourceType: "factory_access",
        resourceId: id,
        result: "success",
        metadata: {
          factoryId: input.factoryId,
          membershipId: input.membershipId,
          canRespond: input.canRespond,
        },
      });
      return this.getGrant(tx, id);
    });
  }
  async revokeGrant(context: TenantContext, id: string, raw: unknown) {
    this.access(context, true);
    const input = FactoryAccessRevokeSchema.parse(raw);
    return retryDatabaseTimeRollback(() => withTenant(this.database.db, context, async (tx) => {
      const [row] = await tx.select().from(grants).where(eq(grants.id, id)).for("update");
      if (!row) throw new NotFoundException("工厂授权不存在");
      if (row.revokedAt) {
        if (row.revocationKey === input.idempotencyKey && row.revocationReason === input.reason)
          return this.getGrant(tx, id);
        throw new ConflictException("原工厂授权已撤销，请刷新");
      }
      await tx
        .update(grants)
        .set({
          revokedAt: sql`clock_timestamp()`,
          revokedBy: context.userId,
          revocationKey: input.idempotencyKey,
          revocationReason: input.reason,
        })
        .where(eq(grants.id, id));
      await this.audit.recordInTransaction(tx, context, {
        action: "factory_collaboration.revoke_grant",
        resourceType: "factory_access",
        resourceId: id,
        result: "success",
        metadata: { factoryId: row.factoryId },
      });
      return this.getGrant(tx, id);
    }), "factory_access_grants_closure_check");
  }
  async assign(context: TenantContext, grantId: string, raw: unknown) {
    this.access(context, true);
    const input = FactoryTaskAssignSchema.parse(raw),
      requestChecksum = checksum({ actor: context.userId, grantId, ...input });
    return withTenant(this.database.db, context, async (tx) => {
      await this.lock(tx, `factory-assignment-request:${context.tenantId}:${input.idempotencyKey}`);
      const [old] = await tx
        .select()
        .from(assignments)
        .where(eq(assignments.idempotencyKey, input.idempotencyKey));
      if (old) {
        if (old.requestChecksum !== requestChecksum)
          throw new ConflictException("同一次任务分配重试内容不能改变");
        return this.getAssignment(tx, old.id);
      }
      const grant = await this.getGrant(tx, grantId, true);
      if (!grant.available) throw new ConflictException(grant.blockers.join("；"));
      await this.assertExpiry(tx, input.expiresAt, grant.expiresAt);
      const pinned = await this.deliveries.assertFactoryAssignableInTransaction(
        tx,
        context,
        input.deliveryItemId,
      );
      if (
        pinned.factoryId !== grant.factoryId ||
        pinned.fileChecksum !== input.fileChecksum ||
        pinned.packageChecksum !== input.packageChecksum
      )
        throw new ConflictException("所选文件与工厂或交付版本不同，请重新核对");
      await this.lock(tx, `factory-assignment-item:${grantId}:${input.deliveryItemId}`);
      const [existing] = await tx
        .select({ id: assignments.id })
        .from(assignments)
        .where(
          and(
            eq(assignments.grantId, grantId),
            eq(assignments.deliveryItemId, input.deliveryItemId),
            isNull(assignments.revokedAt),
          ),
        );
      if (existing) throw new ConflictException("本文件已有该授权下的分配，请先撤销原任务");
      const id = createEntityId();
      await tx
        .insert(assignments)
        .values({
          id,
          tenantId: context.tenantId,
          grantId,
          deliveryItemId: input.deliveryItemId,
          fileChecksum: input.fileChecksum,
          expiresAt: new Date(input.expiresAt),
          idempotencyKey: input.idempotencyKey,
          requestChecksum,
          createdBy: context.userId,
        });
      await this.audit.recordInTransaction(tx, context, {
        action: "factory_collaboration.assign",
        resourceType: "factory_task",
        resourceId: id,
        result: "success",
        metadata: { grantId, deliveryItemId: input.deliveryItemId },
      });
      return this.getAssignment(tx, id);
    });
  }
  async assignmentList(context: TenantContext, grantId: string, raw: unknown) {
    this.access(context);
    const input = FactoryTaskQuerySchema.parse(raw),
      cursor = factoryCursor(input.cursor);
    if (input.q || input.status !== "all") throw new ConflictException("授权任务列表仅支持分页");
    return withTenant(this.database.db, context, async (tx) => {
      await this.getGrant(tx, grantId);
      const [anchor] = cursor ? await tx.select({ id: assignments.id, createdAtExact: factoryCursorTimestamp(assignments.createdAt) })
        .from(assignments).where(and(eq(assignments.grantId, grantId), eq(assignments.id, cursor.id))).limit(1) : [];
      const position = resolveFactoryCursor(cursor, anchor);
      const rows = await tx
        .select({ id: assignments.id, createdAtExact: factoryCursorTimestamp(assignments.createdAt) })
        .from(assignments)
        .where(
          and(
            eq(assignments.grantId, grantId),
            factoryCursorBefore(assignments.createdAt, assignments.id, position),
          ),
        )
        .orderBy(desc(assignments.createdAt), desc(assignments.id))
        .limit(input.limit + 1);
      const views = [];
      for (const row of rows.slice(0, input.limit))
        views.push(await this.getAssignment(tx, row.id));
      return FactoryAssignmentListSchema.parse({
        items: views,
        nextCursor: nextFactoryCursor(
          rows[Math.min(rows.length, input.limit) - 1],
          rows.length > input.limit,
        ),
      });
    });
  }
  async revokeAssignment(context: TenantContext, id: string, raw: unknown) {
    this.access(context, true);
    const input = FactoryAccessRevokeSchema.parse(raw);
    return retryDatabaseTimeRollback(() => withTenant(this.database.db, context, async (tx) => {
      const [row] = await tx.select().from(assignments).where(eq(assignments.id, id)).for("update");
      if (!row) throw new NotFoundException("工厂任务分配不存在");
      if (row.revokedAt) {
        if (row.revocationKey === input.idempotencyKey && row.revocationReason === input.reason)
          return this.getAssignment(tx, id);
        throw new ConflictException("任务分配已撤销，请刷新");
      }
      await tx
        .update(assignments)
        .set({
          revokedAt: sql`clock_timestamp()`,
          revokedBy: context.userId,
          revocationKey: input.idempotencyKey,
          revocationReason: input.reason,
        })
        .where(eq(assignments.id, id));
      await this.audit.recordInTransaction(tx, context, {
        action: "factory_collaboration.revoke_assignment",
        resourceType: "factory_task",
        resourceId: id,
        result: "success",
        metadata: { grantId: row.grantId },
      });
      return this.getAssignment(tx, id);
    }), "factory_task_assignments_closure_check");
  }
  private grantRows(tx: TenantTransaction) {
    return tx
      .select({
        grant: grants,
        createdAtExact: factoryCursorTimestamp(grants.createdAt),
        factoryName: factories.name,
        factoryStatus: factories.status,
        supplierStatus: suppliers.status,
        memberName: users.displayName,
        memberEmail: users.email,
        memberStatus: memberships.status,
        unexpired: sql<boolean>`${grants.expiresAt}>clock_timestamp()`,
      })
      .from(grants)
      .innerJoin(factories, eq(factories.id, grants.factoryId))
      .innerJoin(suppliers, eq(suppliers.id, factories.supplierId))
      .innerJoin(memberships, eq(memberships.id, grants.membershipId))
      .innerJoin(users, eq(users.id, memberships.userId));
  }
  private grantView(row: {
    grant: typeof grants.$inferSelect;
    factoryName: string;
    factoryStatus: string;
    supplierStatus: string;
    memberName: string;
    memberEmail: string;
    memberStatus: string;
    unexpired: boolean;
  }) {
    const g = row.grant,
      blockers = [
        ...(g.revokedAt ? ["工厂授权已撤销"] : []),
        ...(!row.unexpired ? ["工厂授权已到期"] : []),
        ...(row.memberStatus !== "active" ? ["成员已停用"] : []),
        ...(row.factoryStatus !== "active" || row.supplierStatus !== "active"
          ? ["工厂或供应商已停用"]
          : []),
      ];
    return FactoryGrantViewSchema.parse({
      id: g.id,
      factoryId: g.factoryId,
      membershipId: g.membershipId,
      canRespond: g.canRespond,
      factoryName: row.factoryName,
      memberName: row.memberName,
      memberEmail: row.memberEmail,
      expiresAt: g.expiresAt.toISOString(),
      createdAt: g.createdAt.toISOString(),
      revokedAt: g.revokedAt?.toISOString() ?? null,
      revocationReason: g.revocationReason,
      status: g.revokedAt ? "revoked" : row.unexpired ? "active" : "expired",
      available: !blockers.length,
      blockers,
    });
  }
  private async getGrant(tx: TenantTransaction, id: string, lock = false) {
    const query = this.grantRows(tx).where(eq(grants.id, id)),
      [row] = lock
        ? await query.for("share", { of: [grants, memberships, factories, suppliers] })
        : await query;
    if (!row) throw new NotFoundException("工厂授权不存在");
    return this.grantView(row);
  }
  private async getAssignment(tx: TenantTransaction, id: string) {
    const [row] = await tx
      .select({
        assignment: assignments,
        unexpired: sql<boolean>`${assignments.expiresAt}>clock_timestamp()`,
      })
      .from(assignments)
      .where(eq(assignments.id, id));
    if (!row) throw new NotFoundException("工厂任务分配不存在");
    const a = row.assignment,
      grant = await this.getGrant(tx, a.grantId),
      blockers = [
        ...grant.blockers,
        ...(a.revokedAt ? ["任务分配已撤销"] : []),
        ...(!row.unexpired ? ["任务分配已到期"] : []),
      ];
    return FactoryAssignmentViewSchema.parse({
      id: a.id,
      grantId: a.grantId,
      deliveryItemId: a.deliveryItemId,
      fileChecksum: a.fileChecksum,
      expiresAt: a.expiresAt.toISOString(),
      createdAt: a.createdAt.toISOString(),
      revokedAt: a.revokedAt?.toISOString() ?? null,
      revocationReason: a.revocationReason,
      status: a.revokedAt ? "revoked" : row.unexpired ? "active" : "expired",
      available: !blockers.length,
      blockers,
    });
  }
  private async assertExpiry(tx: TenantTransaction, expiresAt: string, maximum?: string) {
    const rows = await tx.execute(
      sql`select ${expiresAt}::timestamptz>clock_timestamp() and (${maximum ?? expiresAt}::timestamptz>=${expiresAt}::timestamptz) as valid`,
    );
    if (!rows[0]?.valid) throw new ConflictException("有效期须在将来，且不能超过工厂授权期限");
  }
  private access(context: TenantContext, write = false) {
    for (const permission of [
      Permission.MembershipManage,
      Permission.OrderRead,
      ...(write ? [Permission.OrderWrite] : []),
    ])
      authorize(context, permission);
    if (context.dataScope !== "tenant")
      throw new ForbiddenError(Permission.MembershipManage, "outside_data_scope");
  }
  private async lock(tx: TenantTransaction, key: string) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`);
  }
}
