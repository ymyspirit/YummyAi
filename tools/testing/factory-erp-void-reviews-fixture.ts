import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { TenantContext } from "../../packages/contracts/src/tenant/tenant-context.js";
import { createEntityId } from "../../packages/contracts/src/common/ids.js";
import { ReviewFactoryErpVoidSchema, type FactoryErpVoidObservationView, type ReviewFactoryErpVoid } from "../../packages/contracts/src/order/factory-erp-void-review.js";
import type { FactoryErpImportView } from "../../packages/contracts/src/order/factory-erp-import.js";
import { withTenant, type DatabaseConnection } from "../../packages/database/src/index.js";
import type * as Drizzle from "../../packages/database/node_modules/drizzle-orm/index.js";
import { bindingSha, factoryBindingFixture, factoryBindingOwner } from "./factory-erp-binding-corrections-fixture.js";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

const workspace = resolve(__dirname, "../.."), requireDatabase = createRequire(resolve(workspace, "packages/database/package.json"));
const { sql } = requireDatabase("drizzle-orm") as typeof Drizzle;
export const voidReviewSha = bindingSha;
export function requireFactoryVoidEnvironment(target: "current" | "pre-0166", environment: NodeJS.ProcessEnv = process.env) {
  const url = new URL(requireDisposableIntegrationEnvironment(environment)), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  if (!nonce || environment.E2E_FACTORY_ERP_VOID_REVIEW_ISOLATED !== "1" || environment.E2E_FACTORY_ERP_BINDING_ISOLATED !== "1" ||
      environment.E2E_FACTORY_ERP_IMPORT_ISOLATED !== "1" || environment.E2E_FACTORY_ERP_SOURCE_RETENTION_ISOLATED !== "1" ||
      environment.E2E_LEGACY_SCHEMA_TARGET !== target || environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
    throw new Error("Factory void fixture requires its exact schema, isolation flags, nonce database and bucket before connection");
  return { url, nonce };
}
export function voidObservationIdentity(value: FactoryErpVoidObservationView) {
  const { id, sequence, importId, rowNumber, rowChecksum, fileChecksum, previewChecksum, recordedAt } = value;
  return { id, sequence, importId, rowNumber, rowChecksum, fileChecksum, previewChecksum, recordedAt };
}

/** Initial order admission remains explicitly synthetic. Real private work,
 * preflight, approved JPG/BOM, finite capacity and submitted-only owners follow. */
export function factoryVoidFixture(database: DatabaseConnection) {
  requireFactoryVoidEnvironment("current");
  const f = factoryBindingFixture(database);
  type Scene = Awaited<ReturnType<typeof f.scene>>;
  let sourceOrdinal = 0;
  async function uploadEvidence(scene: Scene, status: "已审核" | "已出库" | "已作废", externalId = `SYNTHETIC-VOID-${createEntityId()}`) {
    const row = f.rawRow(scene.quantity, status, externalId); row[6] = String(scene.items.length);
    row[11] = "2026-10-21 00:00:00";
    row[12] = new Date(Date.UTC(2026, 9, 21, 8, 0, ++sourceOrdinal)).toISOString().slice(0, 19).replace("T", " ");
    const input = f.uploadInput(scene.site.factory.id, [row]), view = await f.service().upload(f.base.context, input);
    return { view, input, externalId };
  }
  async function observe(scene: Scene, status: "已审核" | "已出库" | "已作废", externalId?: string) {
    const uploaded = await uploadEvidence(scene, status, externalId), input = f.applyInput(uploaded.view, scene.items);
    const result = await f.service().apply(f.base.context, uploaded.view.id, input);
    const binding = await f.service().binding(f.base.context, result.observations[0]!.bindingId);
    return { ...uploaded, applicationInput: input, result, binding, observationId: result.observations[0]!.observationId };
  }
  async function reviewInput(bindingId: string, observationId: string, source: FactoryErpImportView,
    outcome: ReviewFactoryErpVoid["outcome"] = "confirmed_active", reasonCode: ReviewFactoryErpVoid["reasonCode"] = "factory_contact", context?: TenantContext) {
    const current = await f.service().voidObservation(context ?? f.base.context, bindingId, observationId);
    return ReviewFactoryErpVoidSchema.parse({ expectedBindingRevision: current.basis.bindingRevision, expectedItemsChecksum: current.basis.itemsChecksum,
      expectedObservationSequence: current.basis.observationSequence, observation: voidObservationIdentity(current.observation),
      expectedPreviousReviewId: current.observation.latestReview?.id ?? null,
      source: { importId: source.id, rowNumber: source.rows[0]!.rowNumber, fileChecksum: source.fileChecksum, previewChecksum: source.previewChecksum },
      outcome, reasonCode, provenance: "operator_attested", confirmed: true, idempotencyKey: createEntityId() });
  }
  async function crossOrderScene() {
    const first = await f.scene({ quantities: [1] }), second = await f.scene({ site: first.site, quantities: [2] });
    return { first, second, scene: { ...first, items: [...first.items, ...second.items],
      productions: [...first.productions, ...second.productions], quantity: first.quantity + second.quantity } };
  }
  async function state(): Promise<Record<string, { rows: number; hash: string }>> {
    const base = await f.state();
    const [reviews] = await withTenant(database.db, f.base.context, tx => tx.execute<{ rows: number; hash: string }>(sql`select count(*)::int as rows,
      md5(coalesce(jsonb_agg(to_jsonb(r) order by r.id)::text,'[]')) as hash from factory_erp_void_reviews r`));
    return { ...base, factory_erp_void_reviews: reviews! };
  }
  return { ...f, uploadEvidence, observe, reviewInput, crossOrderScene, state };
}
export function factoryVoidOwner(database: DatabaseConnection) {
  requireFactoryVoidEnvironment(process.env.E2E_LEGACY_SCHEMA_TARGET === "pre-0166" ? "pre-0166" : "current");
  return factoryBindingOwner(database);
}

/** Change only the protected source clock in this exact disposable database. */
export async function withFactoryVoidSourceClock<T>(database: DatabaseConnection, use: (set: (at: string) => Promise<void>) => Promise<T>, label: "current" | "upgrade" = "current") {
  const { nonce } = requireFactoryVoidEnvironment(label === "current" ? "current" : "pre-0166");
  const [row] = await database.client.unsafe("select current_database() as name,pg_get_functiondef('public.factory_erp_source_now()'::regprocedure) as definition");
  if (row?.name !== `order_daily_e2e_${nonce}`) throw new Error("Exact void-review source-clock database required");
  const original = String(row.definition), before = voidReviewSha(original); let after: string | null = null;
  const set = async (at: string) => {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,6}Z$/.test(at)) throw new Error("Exact synthetic source-clock instant required");
    const changed = original.replace(/AS \$function\$[\s\S]*?\$function\$/, `AS $function$ SELECT '${at}'::timestamptz $function$`);
    if (changed === original) throw new Error("Unexpected source-clock DDL"); await database.client.unsafe(changed);
  };
  const failures: unknown[] = []; let outcome: { value: T } | undefined;
  try { outcome = { value: await use(set) }; } catch (error) { failures.push(error); }
  finally {
    try {
      await database.client.unsafe(original);
      const [restored] = await database.client.unsafe("select pg_get_functiondef('public.factory_erp_source_now()'::regprocedure) as definition");
      after = voidReviewSha(String(restored!.definition));
      if (after !== before) failures.push(new Error("Source-clock DDL restoration was not exact"));
    } catch (error) { failures.push(error); }
    try {
      const owned = resolve(workspace, "tmp/factory-erp-void-review-20261021-b8d4c307/qa"); await mkdir(owned, { recursive: true });
      await writeFile(resolve(owned, `clock-${label}.json`), JSON.stringify({ nonce, beforeSha256: before, afterSha256: after, restored: before === after }, null, 2) + "\n");
    } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Void-review operation or exact clock restoration failed");
  if (!outcome) throw new Error("Void-review clock operation returned no outcome"); return outcome.value;
}
