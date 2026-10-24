import { ForbiddenError, Permission, permissionScope } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { OriginalOwnerError } from "@yummyai/contracts/common/original-owner-error";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { FACTORY_ERP_TEMPLATE, FactoryErpSourceLifecycleSchema } from "@yummyai/contracts/order/factory-erp-import";
import { factoryErpImports as imports, factoryErpSourcePurges, fulfillmentFactories, fulfillmentSuppliers, withTenant, type DatabaseConnection, type FactoryErpSourceClaim, type TenantTransaction } from "@yummyai/database";
import { and, eq, sql } from "drizzle-orm";
import { currentOrderAuthority } from "./order-authority.js";
import { assertFactoryErpProof, assertFactoryErpProofDigest, type FactoryErpDigestProofSource } from "./factory-erp-evidence.js";
import type { OrderReadVault } from "./order-private-payload.js";

const readPermissions = [Permission.OrderRead, Permission.OrderPiiRead, Permission.DesignRead, Permission.AssetRead] as const;
export type FactoryErpFulfillmentPrivateAccess = { orderId: string; bindingId: string; deliveryItemId?: string; productionOrderId?: string;
  importIds: readonly string[]; observationIds: readonly string[] };
type Import = typeof imports.$inferSelect;
type SourceAccessRow = { id: string; importId: string; rowNumber: number; rowChecksum: string; rawStatus: FactoryErpSourceClaim["rawStatus"];
  bindingKey: string; bindingQuantity: number; bindingFactoryId: string; readable: boolean; sourceProof: FactoryErpDigestProofSource;
  sourceClaim: FactoryErpSourceClaim | null; sourceClaimCount: number };

function invalidAccessInput(): never { throw new OriginalOwnerError(400, { code: "factory_erp_source_access_invalid", message: "原工厂来源位置无法核对" }); }
function accessInput(raw: unknown): FactoryErpFulfillmentPrivateAccess {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalidAccessInput();
  const record = raw as Record<string, unknown>;
  const keys = ["orderId", "bindingId", "deliveryItemId", "productionOrderId", "importIds", "observationIds"];
  if (Object.keys(record).some(key => !keys.includes(key))) return invalidAccessInput();
  const id = (value: unknown) => { const parsed = EntityIdSchema.safeParse(value); return parsed.success ? parsed.data.toLowerCase() : invalidAccessInput(); };
  const ids = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 200) return invalidAccessInput();
    return value.map(id);
  };
  return { orderId: id(record.orderId), bindingId: id(record.bindingId),
    ...(record.deliveryItemId === undefined ? {} : { deliveryItemId: id(record.deliveryItemId) }),
    ...(record.productionOrderId === undefined ? {} : { productionOrderId: id(record.productionOrderId) }),
    importIds: ids(record.importIds), observationIds: ids(record.observationIds) };
}

/** Exact original factory-source reads. No purge, object-store, queue or business mutation dependency. */
export class FactoryErpSourceReadOwner {
  constructor(private readonly database: DatabaseConnection, private readonly vault: OrderReadVault) {}
  private transaction<T>(context: TenantContext, use: (tx: TenantTransaction) => Promise<T>, snapshot = false): Promise<T> {
    return withTenant(this.database.db, context, async tx => {
      const current = await currentOrderAuthority(tx, context, readPermissions, { requireMembership: true, lock: true });
      for (const permission of readPermissions) if (permissionScope(current, permission) !== "tenant") throw new ForbiddenError(permission, "outside_data_scope");
      return use(tx);
    }, snapshot ? { isolationLevel: "repeatable read", accessMode: "read write" } : undefined);
  }

private async factory(tx: TenantTransaction, id: string, active = true, lock = true) {
    const query = tx.select({ factory: fulfillmentFactories }).from(fulfillmentFactories)
      .innerJoin(fulfillmentSuppliers, eq(fulfillmentSuppliers.id, fulfillmentFactories.supplierId))
      .where(and(eq(fulfillmentFactories.id, id), active ? eq(fulfillmentFactories.status, "active") : undefined, active ? eq(fulfillmentSuppliers.status, "active") : undefined));
    const [row] = lock ? await query.for("share") : await query;
    if (!row) throw new OriginalOwnerError(404, "工厂不可用"); return row.factory;
  }
lifecycleView(row: Import, purge: typeof factoryErpSourcePurges.$inferSelect | null, lastApplicationId: string | null, checkedAt: Date) {
    assertFactoryErpProof(this.vault, row);
    const retained = row.expiresAt.getTime() > checkedAt.getTime() && row.privateRedactedAt === null;
    const purgeStatus = retained ? "not_due" : purge?.purgedAt ? "purged" : purge?.leaseExpiresAt && purge.leaseExpiresAt > checkedAt ? "running" : purge?.lastFailureCode ? "failed" : "pending";
    return FactoryErpSourceLifecycleSchema.parse({ id: row.id, factoryId: row.factoryId, fileChecksum: row.fileChecksum, byteSize: row.byteSize,
      templateVersion: FACTORY_ERP_TEMPLATE, previewChecksum: row.previewChecksum, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), checkedAt: checkedAt.toISOString(),
      access: retained ? "retained" : "expired", privateRedactedAt: row.privateRedactedAt?.toISOString() ?? null, purgeStatus,
      attempts: purge?.attempts ?? 0, nextAttemptAt: purgeStatus === "failed" ? purge?.nextAttemptAt.toISOString() ?? null : null,
      purgedAt: purge?.purgedAt?.toISOString() ?? null, lastApplicationId });
  }
async sourceNow(tx: TenantTransaction) {
    const [row] = await tx.execute<{ now: Date | string }>(sql`select factory_erp_source_now() as now`);
    if (!row) throw new Error("Factory source clock required"); return new Date(row.now);
  }
async lifecycle(context: TenantContext, id: string) {
    return this.transaction(context, async tx => {
      // One READ COMMITTED snapshot: never pair an old unredacted source with
      // a newly completed purge read by a later statement.
      const [row] = await tx.select({ source: imports, purge: factoryErpSourcePurges,
        applicationId: sql<string | null>`(select a.id from factory_erp_applications a where a.tenant_id=${imports.tenantId} and a.import_id=${imports.id} order by a.id desc limit 1)` })
        .from(imports).leftJoin(factoryErpSourcePurges, eq(factoryErpSourcePurges.importId, imports.id)).where(eq(imports.id, id));
      if (!row) throw new OriginalOwnerError(404, "导入记录不存在");
      await this.factory(tx, row.source.factoryId, false);
      return this.lifecycleView(row.source, row.purge, row.applicationId, await this.sourceNow(tx));
    });
  }
  /** Only the pinned old imports and observations are checked; new versions,
   * observations and binding releases never replace or revoke retained history. */
  async assertFulfillmentPrivateAccess(context: TenantContext, raw: FactoryErpFulfillmentPrivateAccess): Promise<void> {
    const input = accessInput(raw);
    const observationIds = [...new Set(input.observationIds)], importIds = [...new Set(input.importIds)].sort();
    return this.transaction(context, async tx => {
      const ids = sql`ARRAY[${sql.join(observationIds.map(id => sql`${id}::uuid`), sql`, `)}]::uuid[]`;
      // Same original observation/binding/delivery/work/order chain as
      // factoryErpProgress, with exact saved IDs rather than latest selection.
      // Hash each distinct original source once; never return its private cells.
      const rows = await tx.execute<SourceAccessRow>(sql`
        with selected as materialized (
          select o.id,o.import_id,o.row_number,o.row_checksum,o.raw_status,
            b.external_key,b.quantity,b.factory_id,
            bool_and(o.encrypted_payload is not null and o.private_redacted_at is null
              and w.encrypted_data_key is not null and w.expires_at>clock_timestamp()
              and ord.address_status<>'anonymized') as original_readable
          from factory_erp_observations o
          join factory_erp_bindings b on b.tenant_id=o.tenant_id and b.id=o.binding_id
          join factory_erp_binding_items bi on bi.tenant_id=b.tenant_id and bi.binding_id=b.id
          join production_delivery_items di on di.tenant_id=bi.tenant_id and di.id=bi.delivery_item_id
          join production_orders p on p.tenant_id=di.tenant_id and p.id=di.production_order_id
          join order_work_items w on w.tenant_id=di.tenant_id and w.id=di.work_item_id
          join orders ord on ord.tenant_id=p.tenant_id and ord.id=p.order_id
          where o.tenant_id=${context.tenantId}::uuid and o.id=any(${ids}) and b.id=${input.bindingId}::uuid
            and ord.id=${input.orderId}::uuid
            ${input.deliveryItemId ? sql`and di.id=${input.deliveryItemId}::uuid` : sql``}
            ${input.productionOrderId ? sql`and p.id=${input.productionOrderId}::uuid` : sql``}
          group by o.id,o.import_id,o.row_number,o.row_checksum,o.raw_status,b.external_key,b.quantity,b.factory_id
        ), sources as materialized (
          select s.id,s.tenant_id,s.factory_id,s.file_checksum,s.preview_checksum,s.source_claims,s.source_proof,
            (s.expires_at>factory_erp_source_now() and s.encrypted_payload is not null and s.private_redacted_at is null) as retained,
            encode(sha256(convert_to(invoice_reconciliation_canonical(s.source_claims),'UTF8')),'hex') as claims_checksum
          from factory_erp_imports s join (select distinct import_id from selected) ids on ids.import_id=s.id
          where s.tenant_id=${context.tenantId}::uuid
        ) select o.id,o.import_id as "importId",o.row_number as "rowNumber",o.row_checksum as "rowChecksum",o.raw_status as "rawStatus",
          o.external_key as "bindingKey",o.quantity as "bindingQuantity",o.factory_id as "bindingFactoryId",
          (o.original_readable and s.retained) as readable,
          jsonb_build_object('id',s.id,'tenantId',s.tenant_id,'factoryId',s.factory_id,'fileChecksum',s.file_checksum,
            'previewChecksum',s.preview_checksum,'claimsChecksum',s.claims_checksum,'sourceProof',s.source_proof) as "sourceProof",
          claim.value as "sourceClaim",claim.matches as "sourceClaimCount"
        from selected o join sources s on s.id=o.import_id
        cross join lateral (select (jsonb_agg(c.value)->0) as value,count(*)::double precision as matches
          from jsonb_array_elements(s.source_claims) c(value) where c.value->>'rowNumber'=o.row_number::text) claim
        order by o.id`);
      const actualImports = [...new Set(rows.map(row => row.importId))].sort();
      if (rows.length !== observationIds.length || new Set(rows.map(row => row.id)).size !== observationIds.length ||
          actualImports.length !== importIds.length || actualImports.some((id, index) => id !== importIds[index]))
        throw new OriginalOwnerError(404, "原工厂来源不存在或不属于此订单交付记录");
      for (const row of rows) {
        assertFactoryErpProofDigest(this.vault, row.sourceProof);
        const claim = row.sourceClaim;
        if (row.sourceClaimCount !== 1 || !claim || row.sourceProof.id !== row.importId || row.sourceProof.factoryId !== row.bindingFactoryId ||
            claim.rowNumber !== row.rowNumber || claim.rowChecksum !== row.rowChecksum || claim.rawStatus !== row.rawStatus ||
            claim.externalKey !== row.bindingKey || claim.quantity !== row.bindingQuantity)
          throw new OriginalOwnerError(409, "工厂观察与原表来源不一致 请保留记录核对");
        if (row.readable !== true) throw new OriginalOwnerError(404, "导入记录不存在或私有资料已到期");
      }
    }, true);
  }

}
