import { createEntityId } from "@yummyai/contracts";
import { Permission } from "../../../packages/authz/src/index";
import { OrderExceptionOperationsViewSchema } from "@yummyai/contracts/order/exception-operations";
import { businessFollowupFixture } from "./business-followup-fixture";
import {
  connectDatabase,
  memberships,
  membershipRoles,
  roles,
  withTenant,
} from "@yummyai/database";
import { eq, inArray } from "drizzle-orm";
export const exceptionRoles = {
  handling: [
    Permission.OrderRead,
    Permission.OrderPiiRead,
    Permission.OrderWrite,
    Permission.NotificationRead,
  ],
  reader: [Permission.OrderRead, Permission.OrderPiiRead, Permission.NotificationRead],
  assigner: [
    Permission.OrderRead,
    Permission.OrderPiiRead,
    Permission.OrderAssign,
    Permission.NotificationRead,
  ],
};
export async function exceptionOperationsFixture() {
  const base = await businessFollowupFixture("order_exception");
  const database = connectDatabase(),
    scopedRoles = new Set<string>();
  return {
    ...base,
    async mixedOrderScope(permission: string, scope: "self" | "team") {
      await base.permissions(exceptionRoles.handling.filter((p) => p !== permission));
      const id = createEntityId();
      await withTenant(database.db, base.context, async (tx) => {
        const [member] = await tx
          .select()
          .from(memberships)
          .where(eq(memberships.userId, base.context.userId));
        if (!member) throw new Error("Synthetic exception membership missing");
        await tx
          .insert(roles)
          .values({
            id,
            tenantId: base.context.tenantId,
            name: "Synthetic mixed exception scope",
            permissions: [permission],
            dataScope: scope,
          });
        await tx
          .insert(membershipRoles)
          .values({ tenantId: base.context.tenantId, membershipId: member.id, roleId: id });
      });
      scopedRoles.add(id);
    },
    async operations(exceptionId?: string) {
      return OrderExceptionOperationsViewSchema.parse(
        await base.api(
          `orders/${base.orderId}/exception-operations${exceptionId ? "?exceptionId=" + exceptionId : ""}`,
        ),
      );
    },
    async create(message = "Synthetic concurrent order issue") {
      const view = OrderExceptionOperationsViewSchema.parse(
        await base.api(`orders/${base.orderId}/exception-operations`),
      );
      return base.api(`orders/${base.orderId}/exceptions`, {
        category: "quality",
        code: "SYNTHETIC",
        message,
        expectedOrderSequence: view.orderSequence,
        expectedSourceChecksum: view.sourceChecksum,
        idempotencyKey: createEntityId(),
      });
    },
    async close() {
      try {
        if (scopedRoles.size)
          await withTenant(database.db, base.context, async (tx) => {
            await tx
              .delete(membershipRoles)
              .where(inArray(membershipRoles.roleId, [...scopedRoles]));
            await tx.delete(roles).where(inArray(roles.id, [...scopedRoles]));
          });
        await base.expire(false);
      } finally {
        try {
          await base.close();
        } finally {
          await database.client.end();
        }
      }
    },
  };
}
