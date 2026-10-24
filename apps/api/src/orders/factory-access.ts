import { factoryReceiptIds as sharedFactoryReceiptIds } from "@yummyai/order-core";
import { createHash } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { authorize, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { factoryTaskAssignments as assignments, factoryAccessGrants as grants, factoryTaskReceipts as receipts, fulfillmentFactories as factories, fulfillmentSuppliers as suppliers, memberships, productionDeliveryItems as items, productionDeliveryPackages as packages, type TenantTransaction } from "@yummyai/database";
import { and, eq, isNull, sql } from "drizzle-orm";

/** Opaque comparison stamp; it never substitutes for a live task authorization. */
export function factoryPortalAuthority(context: TenantContext): string {
  const permissions = [Permission.FactoryTaskRead, Permission.FactoryTaskRespond]
    .filter(permission => context.permissions.includes(permission)).sort();
  return createHash("sha256").update(canonicalJson({ version: 1,
    tenantId: context.tenantId, userId: context.userId, permissions,
    scopes: Object.fromEntries(permissions.map(permission => [permission,
      context.permissionScopes?.[permission] ?? context.dataScope])),
  })).digest("hex");
}

/** Server-only scope, resolved afresh under non-owner tenant RLS. Never a DTO. */
export async function requireFactoryTask(
  tx: TenantTransaction,
  context: TenantContext,
  assignmentId: string,
  respond = false,
) {
  authorize(context, respond ? Permission.FactoryTaskRespond : Permission.FactoryTaskRead);
  const [scope] = await tx
    .select({
      assignment: assignments,
      grant: grants,
      item: items,
      package: packages,
      factoryName: factories.name,
    })
    .from(assignments)
    .innerJoin(
      grants,
      and(eq(grants.tenantId, assignments.tenantId), eq(grants.id, assignments.grantId)),
    )
    .innerJoin(
      memberships,
      and(eq(memberships.tenantId, grants.tenantId), eq(memberships.id, grants.membershipId)),
    )
    .innerJoin(
      factories,
      and(eq(factories.tenantId, grants.tenantId), eq(factories.id, grants.factoryId)),
    )
    .innerJoin(
      suppliers,
      and(eq(suppliers.tenantId, factories.tenantId), eq(suppliers.id, factories.supplierId)),
    )
    .innerJoin(
      items,
      and(eq(items.tenantId, assignments.tenantId), eq(items.id, assignments.deliveryItemId)),
    )
    .innerJoin(
      packages,
      and(
        eq(packages.tenantId, items.tenantId),
        eq(packages.id, items.packageId),
        eq(packages.factoryId, factories.id),
      ),
    )
    .where(
      and(
        eq(assignments.id, assignmentId),
        eq(memberships.userId, context.userId),
        eq(memberships.status, "active"),
        eq(factories.status, "active"),
        eq(suppliers.status, "active"),
        isNull(assignments.revokedAt),
        isNull(grants.revokedAt),
        sql`${assignments.expiresAt}>clock_timestamp()`,
        sql`${grants.expiresAt}>clock_timestamp()`,
        eq(assignments.fileChecksum, items.fileChecksum),
        respond ? eq(grants.canRespond, true) : undefined,
      ),
    )
    .for("share", { of: [assignments, grants, memberships, factories, suppliers] });
  if (!scope) throw new NotFoundException("工厂任务不存在或授权已失效");
  return scope;
}
export type FactoryTaskScope = Awaited<ReturnType<typeof requireFactoryTask>>;
export async function recordFactoryTaskOrigin(
  tx: TenantTransaction,
  context: TenantContext,
  assignmentId: string,
  feedbackId: string,
) {
  await requireFactoryTask(tx, context, assignmentId, true);
  const [old] = await tx.select().from(receipts).where(eq(receipts.feedbackId, feedbackId));
  if (old) {
    if (old.assignmentId !== assignmentId || old.recordedBy !== context.userId)
      throw new NotFoundException("工厂回执与原任务不同");
    return;
  }
  await tx
    .insert(receipts)
    .values({
      id: createEntityId(),
      tenantId: context.tenantId,
      assignmentId,
      feedbackId,
      recordedBy: context.userId,
    });
}
export async function factoryReceiptIds(tx: TenantTransaction, feedbackIds: string[]) { return sharedFactoryReceiptIds(tx, feedbackIds); }
