import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { SecretVault } from "../../packages/ai-core/src/secrets.js";
import { createEntityId } from "../../packages/contracts/src/common/ids.js";
import { ChangeFactoryErpBindingSchema, type ChangeFactoryErpBinding, type FactoryErpBindingView } from "../../packages/contracts/src/order/factory-erp-binding.js";
import type { FactoryErpImportView, FactoryErpItemSelection } from "../../packages/contracts/src/order/factory-erp-import.js";
import { withTenant, type DatabaseConnection } from "../../packages/database/src/index.js";
import { ClamAvScanner, createStorageFromEnvironment } from "../../packages/storage/src/index.js";
import type * as Drizzle from "../../packages/database/node_modules/drizzle-orm/index.js";
import { AuditService } from "../../apps/api/src/audit/audit.service.js";
import { ClamAvProductionEditorScanner, ProductionEditorService } from "../../apps/api/src/design/production-editor.service.js";
import { FactoryDirectoryService } from "../../apps/api/src/suppliers/factory-directory.service.js";
import { AmazonOrderReportService } from "../../apps/api/src/orders/amazon-order-report.service.js";
import { HttpAmazonReportArchiveGateway } from "../../apps/api/src/orders/amazon-report-archive.gateway.js";
import { FactoryErpImportService } from "../../apps/api/src/orders/factory-erp-import.service.js";
import { factoryErpImportFixture, factoryErpImportTables } from "../../apps/api/src/orders/factory-erp-import.test-fixture.js";
import { FactoryErpSourceGateway } from "../../apps/api/src/orders/factory-erp-source.gateway.js";
import { OrderProductionDeliveryService } from "../../apps/api/src/orders/order-production-delivery.service.js";
import { OrderProductionService } from "../../apps/api/src/orders/order-production.service.js";
import { OrderService } from "../../apps/api/src/orders/order.service.js";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

const testWorkspace = resolve(__dirname, "../.."), requireDatabase = createRequire(resolve(testWorkspace, "packages/database/package.json"));
const { sql } = requireDatabase("drizzle-orm") as typeof Drizzle;
export const bindingSha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export function requireFactoryBindingEnvironment(target: "current" | "pre-0165", environment: NodeJS.ProcessEnv = process.env) {
  const url = new URL(requireDisposableIntegrationEnvironment(environment));
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  if (!nonce || environment.E2E_FACTORY_ERP_BINDING_ISOLATED !== "1" || environment.E2E_FACTORY_ERP_IMPORT_ISOLATED !== "1" ||
      environment.E2E_FACTORY_ERP_SOURCE_RETENTION_ISOLATED !== "1" || environment.E2E_LEGACY_SCHEMA_TARGET !== target ||
      environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
    throw new Error("Factory binding fixture requires its exact isolated schema, database and bucket before connection");
  return { url, nonce };
}

/** Reuses the real scanned JPG/BOM/capacity/submitted-only graph. Its initial
 * synthetic order admission does not cover upstream customization or routing. */
export function factoryBindingFixture(database: DatabaseConnection) {
  requireFactoryBindingEnvironment("current");
  const f = factoryErpImportFixture(database);
  type Scene = Awaited<ReturnType<typeof f.scene>>;
  async function upload(scene: Scene, status = "已审核", externalId = `SYNTHETIC-BINDING-${createEntityId()}`) {
    const row = f.rawRow(scene.quantity, status, externalId); row[6] = String(scene.items.length);
    const view = await f.service().upload(f.base.context, f.uploadInput(scene.site.factory.id, [row]));
    return { view, externalId };
  }
  function applyInput(view: FactoryErpImportView, items: FactoryErpItemSelection[], legacy = false) {
    const input = f.applyInput(view, items);
    if (legacy) return input;
    const association = view.rows[0]?.association;
    if (!association) throw new Error("The actual owner must return a complete current association pin");
    return { ...input, rows: input.rows.map(row => ({ ...row, association: {
      expectedActiveBindingId: association.activeBindingId, expectedRevision: association.revision,
      expectedReleaseId: association.releaseId, confirmed: true as const,
    } })) };
  }
  async function seed(scene: Scene, status = "已出库", externalId?: string, legacy = false) {
    const uploaded = await upload(scene, status, externalId), input = applyInput(uploaded.view, scene.items, legacy);
    const result = await f.service().apply(f.base.context, uploaded.view.id, input);
    const binding = await f.service().binding(f.base.context, result.observations[0]!.bindingId);
    return { ...uploaded, input, result, binding };
  }
  function change(binding: FactoryErpBindingView, source: FactoryErpImportView, items?: FactoryErpItemSelection[]): ChangeFactoryErpBinding {
    const common = { expectedRevision: binding.revision, expectedItemsChecksum: binding.itemsChecksum,
      expectedObservationSequence: binding.observationSequence, source: { importId: source.id, fileChecksum: source.fileChecksum,
        previewChecksum: source.previewChecksum, rowNumber: source.rows[0]!.rowNumber }, reasonCode: "wrong_group" as const,
      idempotencyKey: createEntityId(), confirmed: true as const };
    return ChangeFactoryErpBindingSchema.parse(items ? { ...common, action: "correct", items, wholeGroupConfirmed: true } : { ...common, action: "release" });
  }
  async function state() {
    return withTenant(database.db, f.base.context, async tx => {
      const values: Record<string, { rows: number; hash: string }> = {};
      for (const table of [...factoryErpImportTables, "factory_erp_binding_changes", "factory_erp_source_purges", "audit_events"])
        values[table] = (await tx.execute<{ rows: number; hash: string }>(sql`select count(*)::int as rows,
          md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as hash from ${sql.identifier(table)} t`))[0]!;
      return values;
    });
  }
  async function auditCount(action: string, id: string) {
    return (await withTenant(database.db, f.base.seed(), tx => tx.execute<{ count: number }>(sql`
      select count(*)::int as count from audit_events where action=${action} and entity_id=${id}`)))[0]!.count;
  }
  return { ...f, upload, applyInput, seed, change, state, auditCount };
}

/** Fresh current owner over an already seeded historical graph; no new facts. */
export function factoryBindingOwner(database: DatabaseConnection, vault = new SecretVault(Buffer.alloc(32, 121))) {
  const audit = new AuditService(database), storage = createStorageFromEnvironment();
  const orders = new OrderService(database, vault, audit), factories = new FactoryDirectoryService(database, audit);
  const forbiddenJob = async () => { throw new Error("Historical binding reads must not enqueue synthetic production or external work"); };
  const reports = new AmazonOrderReportService(database, vault, orders, audit, new HttpAmazonReportArchiveGateway(),
    { schedule: forbiddenJob }, { schedule: forbiddenJob });
  const editor = new ProductionEditorService(database, vault, storage, reports, audit, { enqueue: forbiddenJob }, new ClamAvProductionEditorScanner());
  const production = new OrderProductionService(database, vault, orders, audit, editor, factories);
  const delivery = new OrderProductionDeliveryService(database, vault, editor, production, audit, factories);
  const importer = new FactoryErpImportService(database, vault, new FactoryErpSourceGateway(storage, vault, new ClamAvScanner()), delivery, audit);
  return { importer, production, delivery, audit, storage, vault };
}

/** Only the disposable source clock changes, never orders/work or their TTLs. */
export async function withFactoryBindingSourceClock<T>(database: DatabaseConnection, use: (set: (at: string) => Promise<void>) => Promise<T>, label: "current" | "upgrade" = "current") {
  const { nonce } = requireFactoryBindingEnvironment(label === "current" ? "current" : "pre-0165");
  const [row] = await database.client.unsafe("select current_database() as name,pg_get_functiondef('public.factory_erp_source_now()'::regprocedure) as definition");
  if (row?.name !== `order_daily_e2e_${nonce}`) throw new Error("Exact nonce source-clock database required");
  const original = String(row.definition), before = bindingSha(original); let after: string | null = null;
  const set = async (at: string) => {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,6}Z$/.test(at)) throw new Error("Exact synthetic source-clock instant required");
    const changed = original.replace(/AS \$function\$[\s\S]*?\$function\$/, `AS $function$ SELECT '${at}'::timestamptz $function$`);
    if (changed === original) throw new Error("Unexpected source-clock DDL"); await database.client.unsafe(changed);
  };
  const failures: unknown[] = []; let outcome: { value: T } | undefined;
  try { outcome = { value: await use(set) }; }
  catch (error) { failures.push(error); }
  finally {
    try {
      await database.client.unsafe(original);
      const [restored] = await database.client.unsafe("select pg_get_functiondef('public.factory_erp_source_now()'::regprocedure) as definition");
      after = bindingSha(String(restored!.definition));
      if (after !== before) failures.push(new Error("Source-clock DDL was not restored exactly"));
    } catch (error) { failures.push(error); }
    try {
      const owned = resolve(testWorkspace, "tmp/factory-erp-binding-20261021-c6b2e941/qa");
      await mkdir(owned, { recursive: true });
      await writeFile(resolve(owned, `clock-${label}.json`), JSON.stringify({ nonce, beforeSha256: before, afterSha256: after, restored: before === after }, null, 2) + "\n");
    } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Source-clock operation or exact restoration failed");
  if (!outcome) throw new Error("Source-clock operation returned no outcome");
  return outcome.value;
}
