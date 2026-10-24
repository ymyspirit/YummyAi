/** Only the nine disposable historical upgrade tests may import this fixture. */
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { SecretVault } from "@yummyai/ai-core";
import { createEntityId, NormalizeOrderInputSchema, type NormalizeOrderInput, type TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { ProductionManufacturingFactoryBasisSchema, type ProductionManufacturingSelection } from "@yummyai/contracts/order/production-manufacturing";
import { withTenant, migrateDatabase, readMigrationEvidence, type DatabaseConnection, type TenantTransaction,
  memberships, membershipRoles, roles, orderSourceSnapshots, orders, orderLines, orderExternalReferences, orderEvents,
  fulfillmentSuppliers, qualityStandardVersions, routingPolicyVersions, orderRoutingDecisions, purchaseOrders, purchaseOrderVersions,
  productionOrders, productionOrderVersions, qualityInspections, inventoryLots, inventoryMovements, inventoryBalances,
  productPlans, spus, productSpecifications, productSpecificationVersions, productionEditorProjects, productionEditorVersions,
  printProfiles, printProfileVersions, artworkMasters, artworkMasterVersions, inventoryStockItems,
  manufacturingRecipes, manufacturingRecipeVersions, manufacturingOperations, manufacturingBomLines, manufacturingRecipeReviews,
  fulfillmentFactories, fulfillmentFactoryVersions, factoryCapabilities, factoryCapabilityVersions, productionManufacturingBindings,
} from "@yummyai/database";
import { getTableColumns, getTableName, SQL, sql } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { syntheticSupplierProfile, syntheticFactoryProfile, syntheticFactoryCapability } from "../../../../tools/testing/factory-fixtures.js";
import { syntheticSpecificationFacts } from "../../../../tools/testing/specification-fixtures.js";

// The existing operational .mjs modules have no .d.mts. Keep their exact runtime
// inspectors/policy; this local test interface describes only the fields used.
type InspectionSql = Pick<DatabaseConnection["client"], "unsafe">;
type OriginalTable = { name: string; rows: number; sha256: string; columns: Array<{ name: string; type: string; category: string }> };
type OriginalSnapshot = { tables: OriginalTable[]; migrations: Array<{ hash: string; created_at: string }> };
const requireOperational = createRequire(import.meta.url);
const { inspectBackupDatabaseSnapshot, inspectMigration164UsersProjection } = requireOperational(fileURLToPath(new URL("../../../../tools/scripts/backup-restore.mjs", import.meta.url))) as {
  inspectBackupDatabaseSnapshot(sql: InspectionSql, projection?: OriginalTable[]): Promise<OriginalSnapshot>;
  inspectMigration164UsersProjection(sql: InspectionSql, original: OriginalTable): Promise<OriginalTable>;
};
const { FACTORY_RETENTION_ACTOR_POLICY: actorPolicy, evaluateMigration164ActorPreservation } = requireOperational(fileURLToPath(new URL("../../../../tools/scripts/upgrade-system-actor-policy.mjs", import.meta.url))) as {
  FACTORY_RETENTION_ACTOR_POLICY: { id: string; oidc_subject: string; email: string; display_name: string; arrayIndex: number; migrationOrdinal: number; hash: string; createdAt: number };
  evaluateMigration164ActorPreservation(facts: unknown): unknown;
};

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const same = (a: unknown, b: unknown, reason: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(reason); };
const targets = new Map<string, number>([["pre-0130",130],["pre-0131",131],["pre-0132",132],["pre-0134",134],
  ["pre-0135",135],["pre-0137",137],["pre-0142",142],["pre-0143",143],["pre-0146",148]]);
async function assertLegacyDatabase(database: DatabaseConnection) {
  requireDisposableIntegrationEnvironment();
  const expected = new URL(process.env.DATABASE_URL!).pathname.slice(1);
  if (!/^order_daily_e2e_[a-f0-9]{32}$/.test(expected) || process.env.E2E_ISOLATED_DAILY !== "1" || !targets.has(process.env.E2E_LEGACY_SCHEMA_TARGET ?? "")) throw new Error("legacy_upgrade_isolation_required");
  const [actual] = await database.client.unsafe("select current_database() as name");
  if (actual?.name !== expected) throw new Error("legacy_upgrade_database_mismatch");
}

/** Explicit supplied columns only; no current ORM defaults naming future columns. */
export async function insertLegacy(tx: TenantTransaction, table: AnyPgTable, values: Record<string, unknown> | readonly Record<string, unknown>[]) {
  const columns = getTableColumns(table);
  for (const row of Array.isArray(values) ? values : [values]) {
    const fields = Object.entries(row).filter(([, value]) => value !== undefined);
    if (!fields.length || fields.some(([name]) => !Object.hasOwn(columns, name))) throw new Error("legacy_fixture_unknown_column");
    await tx.execute(sql`insert into ${sql.identifier(getTableName(table))} (${sql.join(fields.map(([name]) => sql.identifier(columns[name]!.name)), sql`,`)})
      values (${sql.join(fields.map(([name, value]) => value instanceof SQL ? value : sql.param(value, columns[name]!)), sql`,`)})`);
  }
}

export async function ensureLegacyMembership(database: DatabaseConnection, context: TenantContext) {
  await assertLegacyDatabase(database);
  await withTenant(database.db, context, async tx => {
    const existing = await tx.execute(sql`select id from memberships where tenant_id=${context.tenantId} and user_id=${context.userId}`);
    if (existing.length) throw new Error("legacy_fixture_membership_already_present");
    const membershipId = createEntityId(), roleId = createEntityId();
    await insertLegacy(tx, memberships, { id: membershipId, tenantId: context.tenantId, userId: context.userId, status: "active" });
    await insertLegacy(tx, roles, { id: roleId, tenantId: context.tenantId, name: randomUUID(), permissions: [...context.permissions], dataScope: context.dataScope });
    await insertLegacy(tx, membershipRoles, { tenantId: context.tenantId, membershipId, roleId });
  });
}

/** Prove the exact historical journal target before invoking any current owner. */
export async function migrateLegacyThrough(database: DatabaseConnection, target: number) {
  await assertLegacyDatabase(database);
  if (targets.get(process.env.E2E_LEGACY_SCHEMA_TARGET!) !== target) throw new Error("legacy_upgrade_target_mismatch");
  const before = await database.client.begin("isolation level repeatable read read only", tx => inspectBackupDatabaseSnapshot(tx));
  const migrations = readMigrationFiles({ migrationsFolder: fileURLToPath(new URL("../../../../packages/database/migrations", import.meta.url)) });
  const canonical = migrations.map(m => ({ hash: m.hash, created_at: String(m.folderMillis) }));
  const expectedOriginal = Number(process.env.E2E_LEGACY_SCHEMA_TARGET!.slice(4)) - 1;
  if (before.migrations.length !== expectedOriginal || before.migrations.length >= target) throw new Error("legacy_upgrade_original_target_mismatch");
  same(before.migrations, canonical.slice(0, before.migrations.length), "legacy_upgrade_original_journal_mismatch");
  await database.client.begin(async tx => {
    await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('yummyai-schema-migrations',0))");
    const ledger = await tx.unsafe("select hash,created_at::text as created_at from drizzle.__drizzle_migrations order by created_at,id");
    same(Array.from(ledger), before.migrations, "legacy_upgrade_concurrent_migration");
    for (const migration of migrations.slice(ledger.length, target)) {
      for (const statement of migration.sql) await tx.unsafe(statement);
      await tx.unsafe("insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)", [migration.hash, migration.folderMillis]);
    }
  });
  const after = await database.client.begin("isolation level repeatable read read only", tx => inspectBackupDatabaseSnapshot(tx, before.tables));
  same(after.migrations, canonical.slice(0, target), "legacy_upgrade_target_journal_mismatch");
  const summaries = (tables: typeof after.tables) => tables.map((t: { name: string; rows: number; sha256: string }) => ({ name: t.name, rows: t.rows, sha256: t.sha256 }));
  same(summaries(after.tables), summaries(before.tables), "legacy_upgrade_original_data_changed");
  return { historicalTarget: target, originalTables: before.tables.length, originalMigrations: before.migrations.length };
}

/** app_users stays protected by the exact existing 0164 actor policy, never a table exclusion. */
export async function migrateLegacyToCurrentPreserving(database: DatabaseConnection) {
  await assertLegacyDatabase(database);
  const before = await database.client.begin("isolation level repeatable read read only", tx => inspectBackupDatabaseSnapshot(tx));
  const evidence = await readMigrationEvidence(database), canonicalMigration = evidence.canonicalRows[actorPolicy.arrayIndex];
  if (before.migrations.length >= actorPolicy.migrationOrdinal || canonicalMigration?.hash !== actorPolicy.hash || canonicalMigration.created_at !== String(actorPolicy.createdAt)) throw new Error("legacy_upgrade_system_actor_pin_mismatch");
  const [presence] = await database.client.unsafe("select count(*)::int as count from app_users where id=$1::uuid or oidc_subject=$2 or email=$3", [actorPolicy.id,actorPolicy.oidc_subject,actorPolicy.email]);
  const [membershipsBefore] = await database.client.unsafe("select count(*)::int as count from memberships where user_id=$1::uuid", [actorPolicy.id]);
  if (presence?.count !== 0 || membershipsBefore?.count !== 0) throw new Error("legacy_upgrade_system_actor_preexisted");
  await migrateDatabase(database);
  return database.client.begin("isolation level repeatable read read only", async tx => {
    const after = await inspectBackupDatabaseSnapshot(tx, before.tables);
    const originalUsers = before.tables.find((t: { name: string }) => t.name === "app_users"), currentUsers = after.tables.find((t: { name: string }) => t.name === "app_users");
    if (!originalUsers || !currentUsers) throw new Error("legacy_upgrade_users_missing");
    const columns = await tx.unsafe("select attname as name from pg_attribute where attrelid='public.app_users'::regclass and attnum>0 and not attisdropped order by attnum");
    const [actor] = await tx.unsafe("select count(*)::int as rows,bool_and(id=$1::uuid and oidc_subject=$2 and email=$3 and display_name=$4) as fixed_fields_match,bool_and(isfinite(created_at) and isfinite(updated_at) and created_at=updated_at) as finite_matching_timestamps,max(xmin::text) as tuple_xmin from app_users where id=$1::uuid", [actorPolicy.id,actorPolicy.oidc_subject,actorPolicy.email,actorPolicy.display_name]);
    const [membership] = await tx.unsafe("select count(*)::int as count from memberships where user_id=$1::uuid", [actorPolicy.id]);
    const ledger = await tx.unsafe("select hash,created_at::text as created_at,xmin::text as tuple_xmin from drizzle.__drizzle_migrations where created_at=$1 order by id", [String(actorPolicy.createdAt)]);
    const [appended] = await tx.unsafe("select encode(sha256(convert_to(to_jsonb(u)::text,'UTF8')),'hex') as sha256 from app_users u where id=$1::uuid", [actorPolicy.id]);
    const preserved = await inspectMigration164UsersProjection(tx, originalUsers);
    const actorProof = evaluateMigration164ActorPreservation({ phase: "post_migration", originalMigrationCount: before.migrations.length, preMigrationActorAbsent: true,
      canonicalMigration, actualMigration: { hash: ledger[0]?.hash, created_at: ledger[0]?.created_at }, matchingLedgerRows: ledger.length,
      originalColumns: originalUsers.columns.map((c: { name: string }) => c.name), currentColumns: columns.map(c => c.name),
      actorRows: actor?.rows, fixedFieldsMatch: actor?.fixed_fields_match, finiteMatchingTimestamps: actor?.finite_matching_timestamps,
      memberships: membership?.count, actorTupleXmin: actor?.tuple_xmin, ledgerTupleXmin: ledger[0]?.tuple_xmin, appendedRowSha256: appended?.sha256,
      originalUsers: { rows: originalUsers.rows, sha256: originalUsers.sha256 }, currentUsers: { rows: currentUsers.rows, sha256: currentUsers.sha256 }, preservedUsers: { rows: preserved.rows, sha256: preserved.sha256 } });
    after.tables[after.tables.indexOf(currentUsers)] = preserved;
    const summaries = (tables: typeof after.tables) => tables.map((t: { name: string; rows: number; sha256: string }) => ({ name: t.name, rows: t.rows, sha256: t.sha256 }));
    same(summaries(after.tables), summaries(before.tables), "legacy_upgrade_current_original_data_changed");
    same(after.migrations.slice(0,before.migrations.length), before.migrations, "legacy_upgrade_original_journal_changed");
    return { originalTables: before.tables.length, originalRows: before.tables.reduce((n: number,t: { rows: number }) => n+t.rows,0), actorProof };
  });
}

export async function upgradeLegacyDatabase(database: DatabaseConnection, target: number) {
  const historical = await migrateLegacyThrough(database,target);
  return { ...historical, ...await migrateLegacyToCurrentPreserving(database) };
}

/** Pin original columns once. Tests assert each new evidence column separately. */
export async function legacyTableSnapshot(database: DatabaseConnection, context: TenantContext, tables: readonly string[]) {
  const names = new Map<string,string[]>();
  for (const table of tables) {
    if (!/^[a-z][a-z0-9_]*$/.test(table)) throw new Error("legacy_fixture_invalid_identifier");
    const fields = await database.client.unsafe("select column_name as name from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position",[table]);
    if (!fields.length) throw new Error("legacy_fixture_table_missing");
    names.set(table,fields.map(f => String(f.name)));
  }
  return async (table: string) => {
    const fields = names.get(table); if (!fields) throw new Error("legacy_fixture_unpinned_table");
    return withTenant(database.db, context, async tx => {
      await tx.execute(sql`set local time zone 'UTC'`);
      return Array.from(await tx.execute<{ id: string; hash: string }>(sql`select s.id::text as id,md5(row_to_json(s)::text) as hash from
        (select ${sql.join(fields.map(f => sql.identifier(f)),sql`,`)} from ${sql.identifier(table)} where tenant_id=${context.tenantId}) s order by s.id`));
    });
  };
}

/** Compare every original field of exact immutable records, including after new versions are appended. */
export async function legacyRecordSnapshot(database: DatabaseConnection, context: TenantContext, records: Record<string,{ table:string;id:string }>) {
  const pinned = new Map<string,{ table:string;id:string;columns:string[] }>();
  for (const [alias,record] of Object.entries(records)) {
    if (!/^[a-z][a-z0-9_]*$/.test(record.table)) throw new Error("legacy_fixture_invalid_identifier");
    const columns = await database.client.unsafe("select column_name as name from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position",[record.table]);
    if (!columns.length) throw new Error("legacy_fixture_table_missing");
    pinned.set(alias,{...record,columns:columns.map(c=>String(c.name))});
  }
  return () => withTenant(database.db,context,async tx=>{
    await tx.execute(sql`set local time zone 'UTC'`);
    const result:Record<string,unknown>={};
    for (const [alias,record] of pinned) {
      const [row] = await tx.execute<{ value:unknown }>(sql`select row_to_json(s) as value from (select ${sql.join(record.columns.map(c=>sql.identifier(c)),sql`,`)}
        from ${sql.identifier(record.table)} where id=${record.id}::uuid and tenant_id=${context.tenantId}) s`);
      if (!row) throw new Error("legacy_fixture_original_record_missing");
      result[alias]=row.value;
    }
    return result;
  });
}

export async function seedLegacyOrder(database: DatabaseConnection, context: TenantContext, raw: NormalizeOrderInput) {
  await assertLegacyDatabase(database);
  const input = NormalizeOrderInputSchema.parse(raw);
  if (input.protectedDetails) throw new Error("legacy_fixture_no_private_order_payload");
  const id = createEntityId(), snapshotId = createEntityId(), lines = input.lines.map(l => ({ ...l,id:createEntityId() }));
  await withTenant(database.db, context, async tx => {
    await insertLegacy(tx,orderSourceSnapshots,{ id:snapshotId,tenantId:context.tenantId,accountId:input.accountId,platform:input.platform,
      externalEventId:input.externalEventId,externalOrderId:input.externalOrderId,normalizedOrderId:id,redactedPayload:input.redactedSource,payloadChecksum:hash(JSON.stringify(input.redactedSource)) });
    await insertLegacy(tx,orders,{ id,tenantId:context.tenantId,accountId:input.accountId,sourceSnapshotId:snapshotId,platform:input.platform,externalOrderId:input.externalOrderId,
      providerStatus:input.providerStatus,orderTotalMinor:input.orderTotal?.amountMinor ?? null,orderCurrency:input.orderTotal?.currency ?? null,lineCount:lines.length,addressStatus:"missing",placedAt:new Date(input.placedAt),latestEventSequence:1 });
    for (const line of lines) await insertLegacy(tx,orderLines,{ id:line.id,tenantId:context.tenantId,orderId:id,externalLineId:line.externalLineId,externalListingId:line.externalListingId,
      skuCode:line.skuCode,title:line.title,quantity:line.quantity,unitPriceMinor:line.unitPrice?.amountMinor ?? null,unitPriceCurrency:line.unitPrice?.currency ?? null,customizationCount:line.customizationCount });
    await insertLegacy(tx,orderExternalReferences,{ id:createEntityId(),tenantId:context.tenantId,orderId:id,provider:input.platform,kind:"order",externalId:input.externalOrderId });
    for (const line of lines) await insertLegacy(tx,orderExternalReferences,{ id:createEntityId(),tenantId:context.tenantId,orderId:id,orderLineId:line.id,provider:input.platform,kind:"order_line",externalId:line.externalLineId });
    await insertLegacy(tx,orderEvents,{ id:createEntityId(),tenantId:context.tenantId,orderId:id,sequence:1,type:"order_ingested",toWorkflowState:"pending",
      idempotencyKey:`ingest:${input.platform}:${input.externalEventId}`,actorUserId:context.userId,metadata:{sourceSnapshotId:snapshotId,lineCount:lines.length} });
  });
  return { id,externalOrderId:input.externalOrderId,lines };
}

/** Explicit synthetic completed history, never a current production/acceptance flow. */
export async function seedLegacyPassedProduction(database: DatabaseConnection, context: TenantContext, orderId: string, lines: Array<{ id:string;quantity:number }>,
  work?: { vault:SecretVault;workSources:ReadonlyMap<string,{ revisionId:string;manufacturing?:ProductionManufacturingSelection }> }) {
  await assertLegacyDatabase(database);
  const supplierId=createEntityId(),standardId=createEntityId(),policyId=createEntityId(),purchaseId=createEntityId(),purchaseVersionId=createEntityId();
  return withTenant(database.db,context,async tx => {
    await insertLegacy(tx,fulfillmentSuppliers,{ id:supplierId,tenantId:context.tenantId,name:`Synthetic legacy stock ${supplierId}`,kind:"manual",status:"active",regionCode:"US",settlementCurrency:"USD",priority:1,profile:syntheticSupplierProfile,createdBy:context.userId });
    await insertLegacy(tx,qualityStandardVersions,{ id:standardId,tenantId:context.tenantId,name:`Synthetic original stock standard ${standardId}`,versionNumber:1,minimumScoreBps:9000,criteria:[{code:"STOCK",label:"Synthetic complete stock inspection",weightBps:10000,blocking:true}],createdBy:context.userId });
    await insertLegacy(tx,routingPolicyVersions,{ id:policyId,tenantId:context.tenantId,name:randomUUID(),versionNumber:1,weights:{capability:2000,region:1000,cost:2000,leadTime:2000,capacity:1000,quality:1500,priority:500},thresholds:{minimumQualityBps:8000,maximumLeadTimeDays:10,maximumUnitCostMinor:2000,manualApprovalCostMinor:2000,manualApprovalRiskBps:2000},tieBreaker:["total_score","unit_cost","lead_time","supplier_id"],active:true,createdBy:context.userId });
    const decisions=new Map<string,string>();
    for(const line of lines) { const decisionId=createEntityId();decisions.set(line.id,decisionId);
      await insertLegacy(tx,orderRoutingDecisions,{id:decisionId,tenantId:context.tenantId,orderId,orderLineId:line.id,routingPolicyVersionId:policyId,versionNumber:1,status:"approved",selectedSupplierId:supplierId,inputChecksum:"a".repeat(64),requiresApproval:false,approvalReasons:[],idempotencyKey:randomUUID()}); }
    await insertLegacy(tx,purchaseOrders,{id:purchaseId,tenantId:context.tenantId,supplierId,orderId,status:"approved",currentVersionNumber:1,createdBy:context.userId});
    await insertLegacy(tx,purchaseOrderVersions,{id:purchaseVersionId,tenantId:context.tenantId,purchaseOrderId:purchaseId,versionNumber:1,currency:"USD",totalMinor:lines.reduce((n,l)=>n+l.quantity*800,0),lineSnapshot:lines.map(l=>({orderLineId:l.id,quantity:l.quantity,unitCostMinor:800})),routingDecisionIds:[...decisions.values()],checksum:"b".repeat(64),createdBy:context.userId});
    const [schema]=await tx.execute<{assessment:boolean;manufacturing:boolean}>(sql`select exists(select 1 from information_schema.columns where table_schema='public' and table_name='quality_inspections' and column_name='assessment_version') as assessment,to_regclass('production_manufacturing_bindings') is not null as manufacturing`);
    let factory:Awaited<ReturnType<typeof seedLegacyFactory>>|undefined;
    if(schema!.manufacturing) factory=await seedLegacyFactory(tx,context,supplierId);
    const result=[];
    for(const line of lines) {
      const id=createEntityId(),versionId=createEntityId(),inspectionId=createEntityId(),source=work?.workSources.get(line.id),completion=new Date("2026-07-23T00:00:00Z");
      await insertLegacy(tx,productionOrders,{id,tenantId:context.tenantId,orderId,orderLineId:line.id,supplierId,...(source?{sourceWorkItemId:line.id}:{}),routingDecisionId:decisions.get(line.id)!,purchaseOrderVersionId:purchaseVersionId,...(factory?{factoryId:factory.factoryId}:{}),status:"completed",projectionVersion:5,expectedCompletionAt:completion,idempotencyKey:randomUUID(),createdBy:context.userId});
      await insertLegacy(tx,productionOrderVersions,{id:versionId,tenantId:context.tenantId,productionOrderId:id,versionNumber:1,quantity:line.quantity,...(source?{sourceWorkRevisionId:source.revisionId}:{}),...(factory?{factoryId:factory.factoryId,factoryVersionId:factory.factoryVersionId,capabilityVersionId:factory.capabilityVersionId}:{}),encryptedInstructions:(work?.vault ?? new SecretVault(Buffer.alloc(32,62))).encrypt("Explicit synthetic legacy stock instructions"),instructionsChecksum:"c".repeat(64),expectedCompletionAt:completion,createdBy:context.userId});
      if(schema!.manufacturing) {
        if(!source?.manufacturing) throw new Error("legacy_fixture_explicit_manufacturing_required");
        await seedLegacyBinding(tx,context,id,versionId,line.id,line.quantity,source.revisionId,source.manufacturing.versionId);
      }
      await insertLegacy(tx,qualityInspections,{id:inspectionId,tenantId:context.tenantId,productionOrderId:id,qualityStandardVersionId:standardId,result:"passed",scoreBps:10000,evidenceAssetIds:[],idempotencyKey:`synthetic-stock-quality-${id}`,inspectedBy:context.userId,inspectedAt:completion,...(schema!.assessment?{assessmentVersion:2,criterionResults:[{code:"STOCK",passed:true,scoreBps:10000,evidenceAssetIds:[]}],requestChecksum:"e".repeat(64),productionVersionId:versionId,productionProjectionVersion:4}:{})});
      result.push({productionOrderId:id,productionVersionId:versionId,qualityInspectionId:inspectionId,expectedProductionProjectionVersion:5,quantity:line.quantity,orderLineId:line.id,standardId,expectedCompletionAt:completion.toISOString()});
    }
    return result;
  });
}

async function seedLegacyFactory(tx:TenantTransaction,context:TenantContext,supplierId:string) {
  const factoryId=createEntityId(),factoryVersionId=createEntityId(),capabilityId=createEntityId(),capabilityVersionId=createEntityId(),profile=syntheticFactoryProfile();
  await insertLegacy(tx,fulfillmentFactories,{id:factoryId,tenantId:context.tenantId,supplierId,code:randomUUID(),name:profile.name,status:"active",currentVersionNumber:1,createdBy:context.userId});
  await insertLegacy(tx,fulfillmentFactoryVersions,{id:factoryVersionId,tenantId:context.tenantId,factoryId,versionNumber:1,profile,idempotencyKey:randomUUID(),requestChecksum:"a".repeat(64),createdBy:context.userId});
  const capability=syntheticFactoryCapability("rectangular_print");
  await insertLegacy(tx,factoryCapabilities,{id:capabilityId,tenantId:context.tenantId,factoryId,name:capability.name,status:"active",currentVersionNumber:1,createdBy:context.userId});
  await insertLegacy(tx,factoryCapabilityVersions,{id:capabilityVersionId,tenantId:context.tenantId,factoryId,capabilityId,versionNumber:1,profile:capability,idempotencyKey:randomUUID(),requestChecksum:"b".repeat(64),createdBy:context.userId});
  return {factoryId,factoryVersionId,capabilityVersionId};
}

export async function seedLegacyManufacturingProduct(database:DatabaseConnection,context:TenantContext) {
  await assertLegacyDatabase(database);
  const planId=createEntityId(),spuId=createEntityId(),specificationId=createEntityId(),specificationVersionId=createEntityId(),projectId=createEntityId(),editorVersionId=createEntityId(),profileId=createEntityId(),profileVersionId=createEntityId(),stockId=createEntityId(),artworkId=createEntityId(),artworkVersionId=createEntityId(),recipeId=createEntityId(),versionId=createEntityId(),reviewId=createEntityId();
  const material={code:"MATERIAL",name:"Synthetic material",stockItemId:stockId,quantityNumerator:1,quantityDenominator:2,unit:"meter",lossBps:0,lossBasis:"add_to_net",responsibility:"merchant",operationCode:"MAKE",notes:""};
  const operation={code:"MAKE",name:"Synthetic manufacture",processCode:"make",responsibility:"factory",expectedSecondsPerOutput:null,notes:""};
  await withTenant(database.db,context,async tx=>{
    await insertLegacy(tx,productPlans,{id:planId,tenantId:context.tenantId,name:"Synthetic historical textile",createdBy:context.userId,status:"approved",customization:{version:1,fields:[]}});
    await insertLegacy(tx,spus,{id:spuId,tenantId:context.tenantId,productPlanId:planId,code:randomUUID(),name:"Synthetic historical textile",customization:{version:1,fields:[]}});
    await insertLegacy(tx,productionEditorProjects,{id:projectId,tenantId:context.tenantId,name:"Synthetic original process",createdBy:context.userId});
    await insertLegacy(tx,productionEditorVersions,{id:editorVersionId,tenantId:context.tenantId,projectId,versionNumber:1,encryptedDocument:"synthetic-unused-process-reference",checksum:"a".repeat(64),createdBy:context.userId});
    await insertLegacy(tx,printProfiles,{id:profileId,tenantId:context.tenantId,code:randomUUID()});
    await insertLegacy(tx,printProfileVersions,{id:profileVersionId,tenantId:context.tenantId,profileId,versionNumber:1,name:"Synthetic original process",productType:"rectangular_print",projectId,sourceVersionId:editorVersionId,instructions:"Synthetic reference only",idempotencyKey:randomUUID(),requestHash:"b".repeat(64),createdBy:context.userId});
    await insertLegacy(tx,productSpecifications,{id:specificationId,tenantId:context.tenantId,spuId,code:randomUUID(),createdBy:context.userId});
    await insertLegacy(tx,productSpecificationVersions,{id:specificationVersionId,tenantId:context.tenantId,specificationId,versionNumber:1,name:"Synthetic original measured specification",attributes:{},facts:syntheticSpecificationFacts({physicalDimensions:{basis:"artwork_longest",unit:"mm",length:254,width:null,height:null}}),processProfileVersionId:profileVersionId,createdBy:context.userId});
    await insertLegacy(tx,inventoryStockItems,{id:stockId,tenantId:context.tenantId,code:randomUUID(),name:"Synthetic historical fabric",baseUnit:"meter",createdBy:context.userId});
    await insertLegacy(tx,artworkMasters,{id:artworkId,tenantId:context.tenantId,code:randomUUID(),createdBy:context.userId});
    await insertLegacy(tx,artworkMasterVersions,{id:artworkVersionId,tenantId:context.tenantId,artworkId,versionNumber:1,name:"Synthetic original order reference",mode:"personalized_text",tags:[],researchItemIds:[],customization:{version:1,fields:[]},materials:[],layout:[],instructions:"Synthetic historical reference only",createdBy:context.userId});
    await insertLegacy(tx,manufacturingRecipes,{id:recipeId,tenantId:context.tenantId,spuId,specificationId,code:randomUUID(),versionNumber:1,createdBy:context.userId});
    await insertLegacy(tx,manufacturingRecipeVersions,{id:versionId,tenantId:context.tenantId,recipeId,specificationId,specificationVersionId,versionNumber:1,name:"Synthetic historical approved recipe",outputQuantity:1,outputUnit:"each",notes:"Synthetic original history; no actual production or factory approval",createdBy:context.userId});
    await insertLegacy(tx,manufacturingOperations,{id:createEntityId(),tenantId:context.tenantId,versionId,position:1,code:operation.code,payload:operation,createdBy:context.userId});
    await insertLegacy(tx,manufacturingBomLines,{id:createEntityId(),tenantId:context.tenantId,versionId,position:1,code:material.code,stockItemId:stockId,operationCode:operation.code,payload:material,createdBy:context.userId});
    await insertLegacy(tx,manufacturingRecipeReviews,{id:reviewId,tenantId:context.tenantId,recipeId,versionId,decision:"approved",note:"Synthetic historical approval for lineage testing only",createdBy:context.userId});
  });
  return {spuId,specificationId,specificationVersionId,artworkVersionId,profileVersionId,manufacturing:{versionId,orderUnitConfirmed:true as const}};
}

async function seedLegacyBinding(tx:TenantTransaction,context:TenantContext,productionOrderId:string,productionVersionId:string,lineId:string,quantity:number,revisionId:string,versionId:string) {
  const [source]=await tx.execute<{recipe_id:string;review_id:string;specification_version_id:string;profile_id:string;plan_id:string;content:Record<string,unknown>}>(sql`select mv.recipe_id,mr.id as review_id,mv.specification_version_id,spec.process_profile_version_id as profile_id,s.product_plan_id as plan_id,
    jsonb_build_object('specificationVersionId',mv.specification_version_id,'name',mv.name,'outputQuantity',mv.output_quantity,'outputUnit',mv.output_unit,'notes',mv.notes,
      'materials',(select jsonb_agg(payload order by position) from manufacturing_bom_lines where version_id=mv.id),
      'operations',(select jsonb_agg(payload order by position) from manufacturing_operations where version_id=mv.id)) as content
    from manufacturing_recipe_versions mv join manufacturing_recipe_reviews mr on mr.version_id=mv.id and mr.decision='approved'
    join product_specification_versions spec on spec.id=mv.specification_version_id join product_specifications p on p.id=spec.specification_id join spus s on s.id=p.spu_id
    where mv.id=${versionId} and mv.tenant_id=${context.tenantId}`);
  if(!source)throw new Error("legacy_fixture_approved_manufacturing_missing");
  const contentCanonical=canonicalJson(source.content),factoryBasis=ProductionManufacturingFactoryBasisSchema.parse({productType:"rectangular_print",productPlanId:source.plan_id,skuId:null,longestMm:254,templateVersionId:source.profile_id,sideMode:null,factoryStandardId:null});
  await insertLegacy(tx,productionManufacturingBindings,{id:createEntityId(),tenantId:context.tenantId,productionOrderId,productionVersionId,orderLineId:lineId,recipeId:source.recipe_id,manufacturingVersionId:versionId,reviewId:source.review_id,specificationVersionId:source.specification_version_id,source:"order_work_revision",sourceWorkRevisionId:revisionId,skuId:null,factoryBasis,quantity,outputUnit:"each",orderUnitConfirmed:true,contentCanonical,contentChecksum:hash(contentCanonical),createdBy:context.userId});
}

export async function seedLegacyProcurementStock(tx:TenantTransaction,context:TenantContext,input:{receiptId:string;stockItemId:string;locationId:string;lotCode:string;quantity:number;unit:string;unitCostMinor:number;currency:string;receivedAt:string;expiresAt:string|null;idempotencyKey:string}) {
  const lotId=createEntityId(),movementId=createEntityId();
  await insertLegacy(tx,inventoryLots,{id:lotId,tenantId:context.tenantId,stockItemId:input.stockItemId,code:input.lotCode,sourceType:"receipt",sourceId:input.receiptId,unitCostMinor:input.unitCostMinor,unitCostCurrency:input.currency,receivedAt:new Date(input.receivedAt),expiresAt:input.expiresAt?new Date(input.expiresAt):null,createdBy:context.userId});
  await insertLegacy(tx,inventoryMovements,{id:movementId,tenantId:context.tenantId,stockItemId:input.stockItemId,locationId:input.locationId,lotId,bucket:"physical",type:"receipt",quantityDelta:input.quantity,unit:input.unit,sourceType:"receipt",sourceId:input.receiptId,reasonCode:"PROCUREMENT_RECEIPT",occurredAt:new Date(input.receivedAt),idempotencyKey:input.idempotencyKey,recordedBy:context.userId});
  await insertLegacy(tx,inventoryBalances,{id:createEntityId(),tenantId:context.tenantId,dimensionKey:`${input.stockItemId}:${input.locationId}:${lotId}`,stockItemId:input.stockItemId,locationId:input.locationId,lotId,unit:input.unit,physicalQuantity:input.quantity,projectionVersion:1});
  return {lot:{id:lotId},movement:{id:movementId}};
}
