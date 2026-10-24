import { sql, type SQL } from "drizzle-orm";

/** One statement derives every original void's own latest review. It never
 * collects private cells, never adopts another void's conclusion, and includes
 * all observations rather than only the current page. Alias names are fixed. */
export function factoryErpVoidRowsSql(tenantId: SQL, bindingId: SQL) {
  return sql`select o.id,o.sequence,o.import_id,o.row_number,
    (r.id is null or r.outcome='followup_required') as pending,
    coalesce(r.outcome='confirmed_voided',false) as requires_order_handling,
    jsonb_build_object('id',o.id,'sequence',o.sequence,'importId',o.import_id,
      'rowNumber',o.row_number,'rowChecksum',o.row_checksum,'fileChecksum',s.file_checksum,'previewChecksum',s.preview_checksum,
      'recordedAt',to_char(o.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'sourceReadable',s.expires_at>factory_erp_source_now() and o.encrypted_payload is not null and s.encrypted_payload is not null,
      'latestReview',r.result,'pending',r.id is null or r.outcome='followup_required',
      'requiresOrderHandling',coalesce(r.outcome='confirmed_voided',false)) as value
    from factory_erp_observations o
    join factory_erp_imports s on s.tenant_id=o.tenant_id and s.id=o.import_id
    join factory_erp_bindings b on b.tenant_id=o.tenant_id and b.id=o.binding_id
    left join lateral (select r0.id,r0.outcome,r0.result from factory_erp_void_reviews r0
      where r0.tenant_id=o.tenant_id and r0.binding_id=o.binding_id and r0.observation_id=o.id
      order by r0.review_revision desc limit 1) r on true
    where o.tenant_id=${tenantId} and o.binding_id=${bindingId} and o.raw_status='已作废'`;
}

/** Bound the selected page before touching its sources. Each distinct source's
 * complete claim array is hashed once inside this statement. Only the small
 * authenticated commitment and its uniquely selected claim leave the database. */
export function factoryErpVoidProofRowsSql(tenantId: SQL, bindingId: SQL, selection: { observationId?: string; cursor?: number; limit: number }) {
  return sql`with selected as materialized (
    select v.* from (${factoryErpVoidRowsSql(tenantId, bindingId)}) v
    where true ${selection.observationId ? sql`and v.id=${selection.observationId}::uuid` : sql``}
      ${selection.cursor ? sql`and v.sequence<${selection.cursor}` : sql``}
    order by v.sequence desc limit ${selection.limit}
  ), sources as materialized (
    select s.id,s.tenant_id,s.factory_id,s.file_checksum,s.preview_checksum,s.source_claims,s.source_proof,
      encode(sha256(convert_to(invoice_reconciliation_canonical(s.source_claims),'UTF8')),'hex') as claims_checksum
    from factory_erp_imports s join (select distinct import_id from selected) ids on ids.import_id=s.id
    where s.tenant_id=${tenantId}
  ) select v.value,
    jsonb_build_object('id',s.id,'tenantId',s.tenant_id,'factoryId',s.factory_id,'fileChecksum',s.file_checksum,
      'previewChecksum',s.preview_checksum,'claimsChecksum',s.claims_checksum,'sourceProof',s.source_proof) as "sourceProof",
    claim.value as "sourceClaim",claim.matches as "sourceClaimCount",
    b.external_key as "bindingKey",b.quantity as "bindingQuantity",b.factory_id as "bindingFactoryId"
  from selected v join sources s on s.id=v.import_id
  join factory_erp_bindings b on b.id=${bindingId} and b.tenant_id=${tenantId}
  cross join lateral (select (jsonb_agg(c.value)->0) as value,count(*)::double precision as matches
    from jsonb_array_elements(s.source_claims) c(value) where c.value->>'rowNumber'=v.row_number::text) claim
  order by v.sequence desc`;
}

export function factoryErpVoidSummarySql(tenantId: SQL, bindingId: SQL) {
  return sql`(with voids as (${factoryErpVoidRowsSql(tenantId, bindingId)})
    select jsonb_build_object('total',count(*),'pending',count(*) filter(where pending),
      'requiresOrderHandling',count(*) filter(where requires_order_handling),
      'latest',(select value from voids order by sequence desc limit 1),
      'nextPending',(select value from voids where pending order by sequence asc limit 1)) from voids)`;
}
