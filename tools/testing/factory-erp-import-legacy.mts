import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatabaseConnection } from "../../packages/database/src/client.ts";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

/** Importable by the disposable runner; importing never connects or seeds. */
export async function migrateFactoryErpImportLegacyDatabase(connection: DatabaseConnection, expectedName: string, environment: NodeJS.ProcessEnv = process.env) {
  requireDisposableIntegrationEnvironment(environment);
  if (environment.E2E_FACTORY_ERP_IMPORT_ISOLATED !== "1" || environment.E2E_LEGACY_SCHEMA_TARGET !== "pre-0163" ||
      !/^order_daily_e2e_[a-f0-9]{32}$/.test(expectedName) ||
      environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${expectedName.slice("order_daily_e2e_".length)}`)
    throw new Error("Factory ERP legacy migration requires its exact isolated runner");
  const [actual] = await connection.client.unsafe("select current_database() as name,to_regclass('drizzle.__drizzle_migrations') as ledger,exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')) as populated");
  if (actual?.name !== expectedName || actual.ledger !== null || actual.populated !== false)
    throw new Error("Factory ERP legacy migration requires the exact fresh nonce database");
  const requireDatabase = createRequire(new URL("../../packages/database/package.json", import.meta.url));
  const { readMigrationFiles } = requireDatabase("drizzle-orm/migrator");
  const migrationsFolder = fileURLToPath(new URL("../../packages/database/migrations/", import.meta.url));
  const journal = JSON.parse(await readFile(new URL("../../packages/database/migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ tag: string; when: number }> };
  const target = journal.entries.find(row => row.tag === "0163_factory_erp_imports");
  if (!target) throw new Error("Canonical factory ERP migration missing");
  const migrations = (readMigrationFiles({ migrationsFolder }) as Array<{ folderMillis: number; sql: string[]; hash: string }>)
    .filter(row => row.folderMillis < target.when);
  if (migrations.length !== 162) throw new Error("The genuine162 migration prefix is required");
  await connection.client.begin(async tx => {
    await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('yummyai-schema-migrations',0))");
    await tx.unsafe("create schema drizzle");
    await tx.unsafe("create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
    for (const migration of migrations) {
      for (const statement of migration.sql) await tx.unsafe(statement);
      await tx.unsafe("insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)", [migration.hash, migration.folderMillis]);
    }
  });
}

async function seedActual162() {
  // All guards precede the first business import, connection, scan, or object I/O.
  const value = requireDisposableIntegrationEnvironment();
  const root = process.env.E2E_FACTORY_ERP_IMPORT_LEGACY_SOURCE;
  const expectedRoot = fileURLToPath(new URL("../../tmp/factory-erp-import-20261021-f3a7c920/old162-source", import.meta.url));
  const url = new URL(value), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  if (!process.connected || process.env.E2E_FACTORY_ERP_IMPORT_ISOLATED !== "1" ||
      process.env.E2E_FACTORY_ERP_IMPORT_LEGACY_CHILD !== "162" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" ||
      process.env.E2E_FACTORY_QUANTITY_ISOLATED !== "1" || !nonce ||
      process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` ||
      !root || !isAbsolute(root) || resolve(root) !== resolve(expectedRoot))
    throw new Error("Actual162 factory ERP IPC requires its pinned source and exact disposable resources");
  const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
  const oldRequire = createRequire(pathToFileURL(resolve(root, "apps/api/package.json")));
  oldRequire("reflect-metadata");
  const d = await load("packages/database/src/index.ts") as typeof import("../../packages/database/src/index.js");
  const { createEntityId, ProductionEditorDocumentSchema } = await load("packages/contracts/src/index.ts") as typeof import("../../packages/contracts/src/index.js");
  const { OrderWorkDraftSchema } = await load("packages/contracts/src/order/workspace.ts") as typeof import("../../packages/contracts/src/order/workspace.js");
  const { JobEnvelopeSchema } = await load("packages/jobs/src/index.ts") as typeof import("../../packages/jobs/src/index.js");
  const { encryptProductionBytes } = await load("packages/production-editor/src/index.ts") as typeof import("../../packages/production-editor/src/index.js");
  const { ClamAvScanner } = await load("packages/storage/src/index.ts") as typeof import("../../packages/storage/src/index.js");
  const { factoryQuantityFixture } = await load("apps/api/src/orders/factory-quantity.test-fixture.ts") as typeof import("../../apps/api/src/orders/factory-quantity.test-fixture.js");
  const { createSyntheticFactory } = await load("apps/api/src/suppliers/factory-directory.test-fixture.ts") as typeof import("../../apps/api/src/suppliers/factory-directory.test-fixture.js");
  const { createSyntheticFactoryCapacity } = await load("apps/api/src/suppliers/factory-capacity.test-fixture.ts") as typeof import("../../apps/api/src/suppliers/factory-capacity.test-fixture.js");
  const { syntheticManufacturingProduct } = await load("apps/api/src/orders/manufacturing-production.test-fixture.ts") as typeof import("../../apps/api/src/orders/manufacturing-production.test-fixture.js");
  const { sealWork } = await load("apps/api/src/orders/order-workspace.service.ts") as typeof import("../../apps/api/src/orders/order-workspace.service.js");
  const { ProductionEditorRenderProcessor } = await load("apps/worker/src/processors/production-editor.processor.ts") as typeof import("../../apps/worker/src/processors/production-editor.processor.js");
  const { eq, sql } = oldRequire("drizzle-orm") as typeof import("drizzle-orm");
  const database = d.connectDatabase(), fixture = factoryQuantityFixture(database), sha = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");
  let phase = "ledger", photo: Buffer | undefined;
  const send = (message: object) => new Promise<void>((done, reject) => process.send!(message, error => error ? reject(error) : done()));
  try {
    if ((await d.readMigrationEvidence(database)).actualRows.length !== 162) throw new Error("Actual162 ledger required");
    await d.assertDatabaseMigrationsCurrent(database);
    phase = "bucket";
    await fixture.storage.ensureBucket();
    phase = "template";
    // Reuse only the original template/member initialization. Its old scene's
    // upstream workflow shortcuts are deliberately not part of this test.
    await fixture.initialize();
    const context = fixture.base.context, profiles = await fixture.work.profiles(context);
    if (profiles.length !== 1) throw new Error("One synthetic original162 template required");
    const profile = profiles[0]!, template = await fixture.editor.get(context, profile.projectId, profile.sourceVersionId);
    const templateDocument = template.version.document;
    if (templateDocument.productType !== "shaped_pillow" || templateDocument.layers.length !== 1 || templateDocument.layers[0]!.kind !== "image")
      throw new Error("Pinned original162 synthetic template required");
    const image = await fixture.editor.image(context, template.project.id, templateDocument.layers[0]!.assetId, "original");
    photo = Buffer.from(image.body); image.body.fill(0);
    phase = "factory";
    const supplier = await fixture.base.factory(), site = await createSyntheticFactory(fixture.base.factories, context, supplier.supplierId, "shaped_pillow");
    const capacity = await createSyntheticFactoryCapacity(database, context, { factory: site.factory,
      bindings: [{ capabilityVersionId: site.capability.versionId, unitsPerItem: 1 }], capacityUnits: 10000 });
    const orderId = createEntityId(), sourceId = createEntityId(), lineId = createEntityId(), revisionId = createEntityId(),
      projectId = createEntityId(), versionId = createEntityId(), assetId = createEntityId();
    const document = ProductionEditorDocumentSchema.parse(structuredClone(templateDocument));
    if (document.productType !== "shaped_pillow" || document.layers[0]?.kind !== "image") throw new Error("Synthetic pinned image layer required");
    document.layers[0].assetId = assetId;
    const manufacturing = await syntheticManufacturingProduct(database, context, { profileVersionId: profile.versionId, document });
    const draft = OrderWorkDraftSchema.parse({ printProfileVersionId: profile.versionId, artworkVersionId: manufacturing.artworkVersionId,
      specificationVersionId: manufacturing.specificationVersionId, salesRecipeVersionId: manufacturing.salesRecipeVersionId,
      designExecutor: "human", fields: [], images: [], instructions: "Synthetic reviewed original162 manufacturing", customerApprovalRequired: false, dueAt: null });
    const workKey = randomBytes(32), projectKey = randomBytes(32);
    const blob = await fixture.storage.putPrivate(context, { body: encryptProductionBytes(projectKey, photo), domain: "order", fileName: `${assetId}.pe`, mediaType: "application/octet-stream" });
    phase = "synthetic-private-admission";
    const now = new Date((await fixture.base.clock()).now);
    // Explicit NEW synthetic order/source/work admission, matching the original
    // delivery fixture. No existing order state or approval is updated to pass.
    try {
      await d.withTenant(database.db, context, async tx => {
        const orderNumber = `SYNTHETIC-ORIGINAL162-${orderId}`;
        await tx.insert(d.orderSourceSnapshots).values({ id: sourceId, tenantId: context.tenantId, accountId: fixture.base.owner.accountId,
          platform: "etsy", externalEventId: randomUUID(), externalOrderId: orderNumber, normalizedOrderId: orderId,
          redactedPayload: { synthetic: true }, payloadChecksum: sha(JSON.stringify({ synthetic: true })) });
        await tx.insert(d.orders).values({ id: orderId, tenantId: context.tenantId, accountId: fixture.base.owner.accountId,
          sourceSnapshotId: sourceId, platform: "etsy", externalOrderId: orderNumber, providerStatus: "paid", workflowState: "in_production",
          lineCount: 1, addressStatus: "protected", placedAt: now });
        await tx.insert(d.orderLines).values({ id: lineId, tenantId: context.tenantId, orderId, externalLineId: lineId, title: "Synthetic original162 pillow", quantity: 2 });
        await tx.insert(d.orderWorkItems).values({ id: lineId, tenantId: context.tenantId, encryptedDataKey: fixture.base.vault.encrypt(workKey.toString("base64")),
          revision: 1, projectionVersion: 1, preparation: "pushed", artwork: "in_review", expiresAt: new Date(now.getTime() + 86400000) });
        await tx.insert(d.orderWorkRevisions).values({ id: revisionId, tenantId: context.tenantId, workItemId: lineId, revision: 1,
          profileVersionId: profile.versionId, encryptedDraft: sealWork(workKey, draft), checksum: sha(JSON.stringify(draft)), createdBy: context.userId });
        await tx.insert(d.productionEditorProjects).values({ id: projectId, tenantId: context.tenantId, name: "shaped_pillow",
          encryptedDataKey: fixture.base.vault.encrypt(projectKey.toString("base64")), sourceWorkItemId: lineId, sourceWorkRevisionId: revisionId,
          expiresAt: new Date(now.getTime() + 86400000), createdBy: context.userId });
        await tx.insert(d.productionEditorVersions).values({ id: versionId, tenantId: context.tenantId, projectId, versionNumber: 1,
          encryptedDocument: sealWork(projectKey, document), checksum: sha(JSON.stringify(document)), createdBy: context.userId });
        await tx.update(d.productionEditorProjects).set({ currentVersionId: versionId, versionNumber: 1 }).where(eq(d.productionEditorProjects.id, projectId));
        await tx.insert(d.productionEditorImages).values({ id: assetId, tenantId: context.tenantId, projectId,
          encryptedMetadata: sealWork(projectKey, { name: "Synthetic owned original162 image", kind: "image", mediaType: "image/png", width: 2048, height: 2048 }),
          originalObjectKey: blob.objectKey, previewObjectKey: blob.objectKey, checksum: sha(photo!), byteSize: photo!.byteLength });
        await tx.update(d.orderWorkItems).set({ pushedRevisionId: revisionId, editorProjectId: projectId }).where(eq(d.orderWorkItems.id, lineId));
      });
    } finally { workKey.fill(0); projectKey.fill(0); }
    phase = "actual-review-render";
    const check = await fixture.editor.preflight(context, projectId, { expectedVersionId: versionId, purpose: "production", format: "jpeg", background: "white" });
    if (check.issues.some(issue => issue.severity === "error" || issue.severity === "manual")) throw new Error("Actual original162 preflight required");
    const approval = await fixture.work.action(context, lineId, { action: "approve_artwork", expectedRevision: 1, expectedProjectionVersion: 1,
      expectedEditorVersionId: versionId, reason: "Synthetic operator checked original162 geometry", idempotencyKey: randomUUID() });
    const render = (await fixture.editor.get(context, projectId)).renders.find(row => row.purpose === "production");
    if (!render) throw new Error("Actual original162 render required");
    const worker = new ProductionEditorRenderProcessor(database, fixture.storage, fixture.base.vault, fixture.base.vault,
      { generate: async () => { throw new Error("No model calls in original162 factory ERP fixture"); } }, new ClamAvScanner());
    await worker.process(JobEnvelopeSchema.parse({ jobId: render.id, type: "production_editor_render", tenantId: context.tenantId, requestedBy: context.userId,
      correlationId: render.id, idempotencyKey: render.id, payload: { renderId: render.id } }));
    if ((await fixture.editor.getRender(context, projectId, render.id)).status !== "completed") throw new Error("Actual original162 JPG required");
    phase = "actual-release-submission";
    const released = await fixture.production.releaseArtwork(context, lineId, { ...site.pins, expectedRevision: approval.line.revision,
      expectedProjectionVersion: approval.line.projectionVersion, renderId: render.id, supplierId: supplier.supplierId, quantity: 2,
      manufacturing: manufacturing.manufacturing, capacityPlan: capacity.capacityPlan, instructions: "Synthetic original162 fixed formal JPG",
      expectedCompletionAt: capacity.expectedCompletionAt, idempotencyKey: randomUUID() });
    const deliveryInput = { supplierId: supplier.supplierId, factoryId: site.factory.id,
      items: [{ productionOrderId: released.productionOrder.id, productionVersionId: released.versions[0]!.id,
        expectedProjectionVersion: released.productionOrder.projectionVersion }], idempotencyKey: randomUUID() };
    const packet = await fixture.delivery.create(context, deliveryInput), item = packet.items[0]!, pin = item.snapshot;
    if (!pin?.manufacturing) throw new Error("Actual original162 fixed manufacturing required");
    const feedbackInput = { kind: "submitted" as const, expectedSequence: 0, idempotencyKey: randomUUID(), fileChecksum: pin.file.checksum,
      manufacturingChecksum: pin.manufacturing.plan.checksum, reference: "SYNTHETIC_ORIGINAL162_SUBMITTED", note: "Synthetic operator actually submitted this fixed file",
      occurredAt: (await fixture.base.clock()).now, verifiedByOperator: true as const };
    const submitted = await fixture.delivery.recordFeedback(context, packet.id, item.id, feedbackInput);
    const file = await fixture.editor.renderFile(context, pin.editorProjectId, pin.renderId, pin.file.key);
    let jpeg: { checksum: string; byteSize: number; mediaType: string };
    try {
      if (file.mediaType !== "image/jpeg" || file.body[0] !== 255 || file.body[1] !== 216 || sha(file.body) !== pin.file.checksum)
        throw new Error("Original162 formal JPEG bytes required");
      jpeg = { checksum: sha(file.body), byteSize: file.body.byteLength, mediaType: file.mediaType };
    } finally { file.body.fill(0); }
    const cipher = await fixture.storage.readPrivate(context, { id: assetId, tenantId: context.tenantId, assetDomain: "order", objectKey: blob.objectKey }, { requiredDomain: "order" });
    let objectChecksum: string;
    try { objectChecksum = sha(cipher); } finally { cipher.fill(0); }
    const [counts] = await d.withTenant(database.db, context, tx => tx.execute<{ reports: number; reviews: number; feedback: number }>(sql`
      select (select count(*)::int from production_quantity_reports) as reports,
        (select count(*)::int from production_quantity_reviews) as reviews,
        (select count(*)::int from production_delivery_feedback) as feedback`));
    if (counts?.reports !== 0 || counts.reviews !== 0 || counts.feedback !== 1 || submitted.items[0]?.status !== "submitted")
      throw new Error("Original162 submitted-only facts required");
    await send({ type: "factory.erp.seeded162", context, foreignContext: fixture.base.foreignContext, productionOrderId: released.productionOrder.id, factoryId: site.factory.id,
      packetId: packet.id, deliveryItemId: item.id, deliveryInput, feedbackInput, snapshot: pin, feedback: submitted.items[0]!.feedback,
      jpeg, sourceObject: { id: assetId, key: blob.objectKey, checksum: objectChecksum } });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Za-z0-9_]{1,80}$/.test(error.code) ? error.code : undefined;
    await send({ type: "factory.erp.failed", phase, ...(code ? { code } : {}) });
    throw new Error("Synthetic genuine162 factory ERP setup failed");
  } finally { photo?.fill(0); fixture.dispose(); await database.client.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await seedActual162();
