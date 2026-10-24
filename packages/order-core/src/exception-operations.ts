import { createHash } from "node:crypto";
import { ForbiddenError, Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import {
  OrderExceptionOperationsQuerySchema,
  OrderExceptionOperationsViewSchema,
} from "@yummyai/contracts/order/exception-operations";
import { orderPrivateSourceAvailable, type TenantTransaction } from "@yummyai/database";
import { sql } from "drizzle-orm";
import { currentOrderAuthority, hasTenantOrderPermissions } from "./order-authority.js";
export class OrderExceptionAccessError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function orderExceptionActor(
  tx: TenantTransaction,
  input: TenantContext,
  write = false,
) {
  const required = [
    Permission.OrderRead,
    Permission.OrderPiiRead,
    ...(write ? [Permission.OrderWrite] : []),
  ];
  try {
    return await currentOrderAuthority(tx, input, required, {
      lock: write,
      requireMembership: true,
    });
  } catch (error) {
    if (!(error instanceof ForbiddenError)) throw error;
    throw new OrderExceptionAccessError(403, "当前成员没有处理该订单异常的权限或范围");
  }
}
export function orderExceptionChecksum(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export async function readOrderExceptionParent(tx: TenantTransaction, orderId: string) {
  const rows = await tx.execute<{
    id: string;
    label: string;
    sequence: number;
    address_status: string;
    available: boolean;
    line_id: string | null;
    now: Date;
  }>(sql`
    select o.id,o.external_order_id as label,o.latest_event_sequence as sequence,o.address_status,
      ${orderPrivateSourceAvailable(sql`o.id`)} as available,(select id from order_lines where order_id=o.id order by id limit 1) as line_id,clock_timestamp() as now from orders o where o.id=${orderId}`);
  const parent = rows[0];
  if (!parent) throw new OrderExceptionAccessError(404, "订单不存在或不在当前范围内");
  if (!parent.available)
    throw new OrderExceptionAccessError(410, "订单资料已过期或已清理 请核对原资料");
  return parent;
}
export async function readOrderExceptionOperations(
  tx: TenantTransaction,
  context: TenantContext,
  orderId: string,
  rawQuery: unknown = {},
) {
  const query = OrderExceptionOperationsQuerySchema.parse(rawQuery);
  const parent = await readOrderExceptionParent(tx, orderId);
  const sourceChecksum = orderExceptionChecksum({
    id: parent.id,
    sequence: parent.sequence,
    addressStatus: parent.address_status,
  });
  type Row = {
    id: string;
    category: string;
    code: string;
    message: string;
    opened_at: string;
    event_id: string | null;
    sequence: number | null;
    status: string | null;
    resolution: string | null;
    resolved_at: string | null;
  };
  const [result] = await tx.execute<{
    total: number;
    open: number;
    resolved: number;
    missing: number;
    items: Row[];
  }>(sql`
    with base as(select e.id,e.category,e.code,e.message,e.opened_at,v.id as event_id,v.sequence,v.status,v.resolution,case when v.status='resolved' then v.occurred_at else null end as resolved_at
    from order_exceptions e left join lateral(select id,sequence,status,resolution,occurred_at from order_exception_events where exception_id=e.id order by sequence desc limit 1) v on true
    where e.order_id=${orderId}),filtered as materialized(select * from base where
      ${query.exceptionId ? sql`id=${query.exceptionId}` : sql`true`} and ${query.status === "all" ? sql`true` : query.status === "open" ? sql`coalesce(status,'open')='open'` : sql`status='resolved'`}),
    paged as(select * from filtered order by opened_at desc,id desc limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize})
    select count(*)::int as total,count(*)filter(where coalesce(status,'open')='open')::int as open,count(*)filter(where status='resolved')::int as resolved,count(*)filter(where event_id is null)::int as missing,
      coalesce((select jsonb_agg(to_jsonb(p) order by p.opened_at desc,p.id desc) from paged p),'[]'::jsonb) as items from filtered`);
  const canWrite = hasTenantOrderPermissions(context, [Permission.OrderWrite]);
  return OrderExceptionOperationsViewSchema.parse({
    orderId,
    lineId: parent.line_id,
    label: parent.label,
    orderSequence: parent.sequence,
    sourceChecksum,
    asOf: new Date(parent.now).toISOString(),
    canCreate: canWrite,
    query,
    total: result!.total,
    page: query.page,
    pageSize: query.pageSize,
    summary: { open: result!.open, resolved: result!.resolved, missingEvent: result!.missing },
    items: result!.items.map((record) => ({
      sequence: record.sequence ?? 0,
      eventMissing: !record.event_id,
      canResolve: canWrite && record.sequence !== null && record.status === "open",
      sourceChecksum: orderExceptionChecksum({
        parent: sourceChecksum,
        id: record.id,
        category: record.category,
        code: record.code,
        message: orderExceptionChecksum(record.message),
        event: record.event_id,
        sequence: record.sequence,
        status: record.status,
        resolution: orderExceptionChecksum(record.resolution),
      }),
      exception: {
        id: record.id,
        orderId,
        category: record.category,
        code: record.code,
        message: record.message,
        status: record.status ?? "open",
        resolution: record.resolution,
        openedAt: new Date(record.opened_at).toISOString(),
        resolvedAt: record.resolved_at ? new Date(record.resolved_at).toISOString() : null,
      },
    })),
  });
}
