import { authorize, intersectPermissionContexts, permissionScope, Permission, type PermissionValue } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { AgentExceptionPageInputSchema, AgentExceptionItemSchema, AgentBalancePageInputSchema, AgentBalanceItemSchema,
 type AgentExceptionPageInput, type AgentExceptionItem, type AgentBalancePageInput, type AgentBalanceItem,
 type AgentReadOwnerPage, type AgentReadOwnerPosition } from "@yummyai/contracts/ai/agent-read";
import { stockQuantityValue, subtractStockQuantity } from "@yummyai/contracts/inventory/quantity";
import { loadCurrentMembershipContext, orderPrivateSourceAvailable, withTenant, type inventoryBalances, type TenantTransaction, type DatabaseConnection } from "@yummyai/database";
import { sql } from "drizzle-orm";
type BalanceRow = typeof inventoryBalances.$inferSelect;
export class AgentReadGatewayError extends Error {
 constructor(readonly statusCode:number,readonly code:string,message:string){super(message);this.name="AgentReadGatewayError";}
}
export async function sharedAgentReadAuthority(tx:TenantTransaction,ceiling:TenantContext,permission:PermissionValue){
 const current=intersectPermissionContexts(ceiling,await loadCurrentMembershipContext(tx,ceiling,{lock:true}));authorize(current,permission);
 if(permissionScope(current,permission)!=="tenant")throw new AgentReadGatewayError(403,"agent_read_scope_not_verified","当前读取需要此业务的全组织资料范围");
 return current;
}
export async function readOrderExceptionPage(
  database: DatabaseConnection,
  context: TenantContext,
  input: AgentExceptionPageInput,
  position: AgentReadOwnerPosition,
  signal?: AbortSignal,
): Promise<AgentReadOwnerPage<AgentExceptionItem>> {
  signal?.throwIfAborted();
  const { pageSize, status, orderId } = AgentExceptionPageInputSchema.parse(input);
  const result = await withTenant(database.db, context, async tx => {
    await tx.execute(sql`set local statement_timeout = '10000'`);
    const current = await sharedAgentReadAuthority(tx, context, Permission.OrderRead);
    signal?.throwIfAborted();
    const [page] = await tx.execute<{
      total: string; checkedAt: string; collectionFingerprint: string; anchorExists: boolean; items: AgentExceptionItem[];
    }>(sql`
      with metadata as materialized (
        select e.id, e.order_id as "orderId", e.category, coalesce(v.status, 'open') as status,
          v.id is null as "eventMissing", v.id as "eventId", coalesce(v.sequence, 0) as sequence,
          o.latest_event_sequence as "orderSequence",
          to_char(e.opened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "openedAt",
          case when v.status = 'resolved' then
            to_char(v.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            else null end as "resolvedAt"
        from order_exceptions e
        join orders o on o.tenant_id = e.tenant_id and o.id = e.order_id
        left join lateral (
          select ev.id, ev.sequence, ev.status, ev.occurred_at from order_exception_events ev
          where ev.tenant_id = e.tenant_id and ev.exception_id = e.id and ev.order_id = e.order_id
          order by ev.sequence desc limit 1
        ) v on true
        where e.tenant_id = ${current.tenantId}::uuid
          and ${orderPrivateSourceAvailable(sql`o.id`)}
          and ${orderId ? sql`e.order_id = ${orderId}::uuid` : sql`true`}
          and ${status === "all" ? sql`true` : sql`coalesce(v.status, 'open') = ${status}`}
      ), projected as materialized (
        select m.*, encode(sha256(convert_to(row_to_json(m)::text, 'UTF8')), 'hex') as "sourceChecksum"
        from metadata m
      ), summary as (
        select count(*)::text as total,
          encode(sha256(convert_to(coalesce(string_agg(row_to_json(p)::text, '' order by p.id desc), ''), 'UTF8')), 'hex') as fingerprint
        from projected p
      ), selected as (
        select p.* from projected p
        where ${position ? sql`p.id::text collate "C" < ${position.after}` : sql`true`}
        order by p.id desc limit ${pageSize + 1}
      )
      select summary.total, summary.fingerprint as "collectionFingerprint",
        to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "checkedAt",
        ${position ? sql`exists(select 1 from projected p where p.id::text = ${position.after})` : sql`true`} as "anchorExists",
        coalesce((select jsonb_agg(to_jsonb(s) order by s.id desc) from selected s), '[]'::jsonb) as items
      from summary
    `);
    signal?.throwIfAborted();
    if (!page) throw new Error("Agent exception collection query returned no summary");
    if (position && (position.collectionFingerprint !== page.collectionFingerprint || !page.anchorExists)) {
      throw new AgentReadGatewayError(409, "agent_collection_changed", "资料已变化 请从第一页重新读取");
    }
    const total = Number(page.total);
    if (!Number.isSafeInteger(total) || total < 0) throw new Error("Agent exception collection count is invalid");
    const items = page.items.slice(0, pageSize).map(item => AgentExceptionItemSchema.parse(item));
    return { items, total, checkedAt: page.checkedAt, collectionFingerprint: page.collectionFingerprint,
      hasMore: page.items.length > pageSize, lastKey: items.at(-1)?.id ?? null };
  }, { isolationLevel: "repeatable read", accessMode: "read write" });
  signal?.throwIfAborted();
  return result;
}


export async function readInventoryBalancePage(
  database: DatabaseConnection,
  context: TenantContext,
  input: AgentBalancePageInput,
  position: AgentReadOwnerPosition,
  signal?: AbortSignal,
): Promise<AgentReadOwnerPage<AgentBalanceItem>> {
  signal?.throwIfAborted();
  const { pageSize, stockItemId, locationId } = AgentBalancePageInputSchema.parse(input);
  const result = await withTenant(database.db, context, async tx => {
    await tx.execute(sql`set local statement_timeout = '10000'`);
    const current = await sharedAgentReadAuthority(tx, context, Permission.InventoryRead);
    signal?.throwIfAborted();
    const [page] = await tx.execute<{
      total: string; checkedAt: string; collectionFingerprint: string; anchorExists: boolean;
      items: (Omit<BalanceRow, "tenantId" | "updatedAt"> & { updatedAt: string })[];
    }>(sql`
      with projected as materialized (
        select b.id, b.dimension_key as "dimensionKey", b.stock_item_id as "stockItemId",
          b.location_id as "locationId", b.lot_id as "lotId", b.unit,
          b.physical_quantity::text as "physicalQuantity", b.reserved_quantity::text as "reservedQuantity",
          b.in_transit_quantity::text as "inTransitQuantity", b.provider_quantity::text as "providerQuantity",
          b.virtual_quantity::text as "virtualQuantity", b.projection_version as "projectionVersion",
          to_char(b.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt"
        from inventory_balances b
        where b.tenant_id = ${current.tenantId}::uuid
          and ${stockItemId ? sql`b.stock_item_id = ${stockItemId}::uuid` : sql`true`}
          and ${locationId ? sql`b.location_id = ${locationId}::uuid` : sql`true`}
      ), rebuilds as (
        select r.id, r.aggregate_checksum,
          to_char(r.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "occurredAt"
        from inventory_projection_rebuilds r where r.tenant_id = ${current.tenantId}::uuid
      ), epoch as (
        select encode(sha256(convert_to(coalesce(string_agg(row_to_json(r)::text, '' order by r.id), ''), 'UTF8')), 'hex') as fingerprint
        from rebuilds r
      ), summary as (
        select count(*)::text as total,
          encode(sha256(convert_to((select fingerprint from epoch) || ':' ||
            coalesce(string_agg(row_to_json(p)::text, '' order by p."dimensionKey" collate "C"), ''), 'UTF8')), 'hex') as fingerprint
        from projected p
      ), selected as (
        select p.* from projected p
        where ${position ? sql`p."dimensionKey" collate "C" > ${position.after}` : sql`true`}
        order by p."dimensionKey" collate "C" limit ${pageSize + 1}
      )
      select summary.total, summary.fingerprint as "collectionFingerprint",
        to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "checkedAt",
        ${position ? sql`exists(select 1 from projected p where p."dimensionKey" collate "C" = ${position.after})` : sql`true`} as "anchorExists",
        coalesce((select jsonb_agg(to_jsonb(s) order by s."dimensionKey" collate "C") from selected s), '[]'::jsonb) as items
      from summary
    `);
    signal?.throwIfAborted();
    if (!page) throw new Error("Agent balance collection query returned no summary");
    if (position && (position.collectionFingerprint !== page.collectionFingerprint || !page.anchorExists)) {
      throw new AgentReadGatewayError(409, "agent_collection_changed", "资料已变化 请从第一页重新读取");
    }
    const total = Number(page.total);
    if (!Number.isSafeInteger(total) || total < 0) throw new Error("Agent balance collection count is invalid");
    const items = page.items.slice(0, pageSize).map(row => AgentBalanceItemSchema.parse({
      id: row.id, dimensionKey: row.dimensionKey,
      ...inventoryBalanceView({ ...row, tenantId: current.tenantId, updatedAt: new Date(row.updatedAt),
        physicalQuantity: stockQuantityValue(row.physicalQuantity), reservedQuantity: stockQuantityValue(row.reservedQuantity),
        inTransitQuantity: stockQuantityValue(row.inTransitQuantity), providerQuantity: stockQuantityValue(row.providerQuantity),
        virtualQuantity: stockQuantityValue(row.virtualQuantity) }),
    }));
    return { items, total, checkedAt: page.checkedAt, collectionFingerprint: page.collectionFingerprint,
      hasMore: page.items.length > pageSize, lastKey: items.at(-1)?.dimensionKey ?? null };
  }, { isolationLevel: "repeatable read", accessMode: "read write" });
  signal?.throwIfAborted();
  return result;
}


export function inventoryBalanceView(row: BalanceRow) {
  return {
    stockItemId: row.stockItemId,
    locationId: row.locationId,
    lotId: row.lotId,
    unit: row.unit,
    physicalQuantity: row.physicalQuantity,
    reservedQuantity: row.reservedQuantity,
    availableQuantity: subtractStockQuantity(row.physicalQuantity, row.reservedQuantity),
    inTransitQuantity: row.inTransitQuantity,
    providerQuantity: row.providerQuantity,
    virtualQuantity: row.virtualQuantity,
    projectionVersion: row.projectionVersion,
    updatedAt: row.updatedAt.toISOString(),
  };
}

