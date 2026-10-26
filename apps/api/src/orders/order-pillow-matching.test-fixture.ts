import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import type { AmazonReportFieldView } from "@yummyai/contracts/order/report";
import type { OrderWorkDetail, OrderWorkDraft } from "@yummyai/contracts/order/workspace";
import type { ProductionEditorDocument } from "@yummyai/contracts/pod/production-editor";
import {
  amazonOrderReportBatches, amazonOrderReportLines, amazonOrderReportReadModels, amazonOrderReportVersions,
  connectDatabase, loadCurrentMembershipContext, marketplaceAccounts, membershipRoles, memberships,
  migrateDatabase, orderSourceSnapshots, orderWorkRevisions, productSpecifications,
  productSpecificationVersions, productionEditorProjects, productionEditorRenders, roles, withTenant,
} from "@yummyai/database";
import type { Storage } from "@yummyai/storage";
import { syntheticSpecificationFacts } from "../../../../tools/testing/specification-fixtures.js";
import { AuditService } from "../audit/audit.service.js";
import { ProductDevelopmentService } from "../catalog/product-development.service.js";
import { ProductionEditorService } from "../design/production-editor.service.js";
import { AmazonOrderReportService } from "./amazon-order-report.service.js";
import { OrderService } from "./order.service.js";
import { OrderWorkspaceService } from "./order-workspace.service.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Field = Pick<AmazonReportFieldView, "label" | "value">;
export type PillowMatchingActor = { context: TenantContext; roleId: string; accountId: string };
export type PillowMatchingOrder = { lineId: string; orderId: string; externalOrderId: string; reportLineId: string; versionId: string };

/** All records belong to the acceptance runner's disposable database. No fixture
 * marks a product, rule, artwork or factory file approved, and no object is put. */
export async function createPillowMatchingFixture() {
  const database = connectDatabase();
  try {
    await migrateDatabase(database);
    const audit = new AuditService(database), vault = new SecretVault(Buffer.alloc(32, 109));
    const external = vi.fn(async () => { throw new Error("Pillow matching must not perform an external action"); });
    const scan = vi.fn(async () => ({ result: "clean" as const, engine: "synthetic-unused", signatureVersion: "unused", scannedAt: new Date().toISOString() }));
    const storage = { putPrivate: external, readPrivate: external } as unknown as Storage;
    const orders = new OrderService(database, vault, audit);
    const reports = new AmazonOrderReportService(database, vault, orders, audit,
      { download: external, scan }, { schedule: external }, { schedule: external });
    const editor = new ProductionEditorService(database, vault, storage, reports, audit, { enqueue: external }, { scan });
    const work = new OrderWorkspaceService(database, vault, storage, reports, editor, { scan });
    const catalog = new ProductDevelopmentService(database, storage);
    const expiry = new Date(Date.now() + 30 * 86400_000);
    const permissions = [Permission.OrderRead, Permission.OrderPiiRead, Permission.OrderWrite,
      Permission.ProductRead, Permission.ProductWrite, Permission.DesignRead, Permission.DesignWrite, Permission.AssetRead];

    async function actor(additionalPermissions: TenantContext["permissions"] = []): Promise<PillowMatchingActor> {
      const seed: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: [...permissions, ...additionalPermissions], dataScope: "tenant" };
      await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic pillow matching',$2)", [seed.tenantId, randomUUID()]);
      await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic pillow operator')", [seed.userId, randomUUID(), `${seed.userId}@example.invalid`]);
      const membershipId = createEntityId(), roleId = createEntityId(), accountId = createEntityId();
      await withTenant(database.db, seed, async tx => {
        await tx.insert(memberships).values({ id: membershipId, tenantId: seed.tenantId, userId: seed.userId, status: "active" });
        await tx.insert(roles).values({ id: roleId, tenantId: seed.tenantId, name: randomUUID(), permissions: seed.permissions, dataScope: "tenant" });
        await tx.insert(membershipRoles).values({ tenantId: seed.tenantId, membershipId, roleId });
        await tx.insert(marketplaceAccounts).values({ id: accountId, tenantId: seed.tenantId, platform: "amazon", displayName: "Synthetic pillow store", region: "NA", authorizationMode: "amazon_private", marketplaceIds: ["ATVPDKIKX0DER"], createdBy: seed.userId });
      });
      return { context: await withTenant(database.db, seed, tx => loadCurrentMembershipContext(tx, seed)), roleId, accountId };
    }

    async function createSpu(owner: PillowMatchingActor, code = "CUSTOM-SHAPED-PILLOW") {
      return (await catalog.createSpu(owner.context, { code, name: "Synthetic custom shaped pillow", idempotencyKey: randomUUID() })).spu;
    }

    async function specification(owner: PillowMatchingActor, spuId: string, size: number, expectedVersion = 0) {
      return (await catalog.saveSpecification(owner.context, {
        spuId, code: `SIZE-${size}IN`, name: `Synthetic ${size} inch pillow`, attributes: { Size: `${size} inches` },
        facts: syntheticSpecificationFacts({ factsConfirmed: false, productionConfirmed: false, weightGrams: null,
          physicalDimensions: { basis: "artwork_longest", unit: "mm", length: size * 25.4, width: null, height: null } }),
        processProfileVersionId: null, canvasPrintSpecVersionId: null, stockItemId: null,
        expectedVersion, idempotencyKey: randomUUID(),
      })).specification;
    }

    async function registerCustomerArtwork(owner: PillowMatchingActor, expectedVersion = 0, code = "ART-CUSTOM-SHAPED-PILLOW") {
      // Registration uses its real catalog permission boundary. This masterless
      // scheme approves no image, editor version, manufacturing file or order.
      return (await catalog.registerArtwork(owner.context, {
        code, name: `Synthetic customer pillow scheme V${expectedVersion + 1}`, mode: "customer_image", creativeVersionId: null,
        expectedVersion, idempotencyKey: randomUUID(), materials: [], layout: [],
        instructions: "Synthetic customer photo scheme only; preserve original and require operator review before production.",
        customization: { version: 1, fields: [
          { key: "buyer_photo", label: "Buyer photo", type: "image", required: true,
            validation: { allowedMediaTypes: ["image/png"], maxFiles: 1, maxBytes: 32_000_000 } },
          { key: "crop_scope", label: "Crop scope", type: "single_choice", required: true,
            options: [{ value: "head", label: "Only Face" }, { value: "half_body", label: "Half Body" }, { value: "body", label: "Whole Body" }] },
          { key: "print_sides", label: "Print sides", type: "single_choice", required: true,
            options: [{ value: "single", label: "Single Sided Printing" }, { value: "double", label: "Double Sided Printing" }] },
        ] },
      })).artwork;
    }

    async function seedOrder(owner: PillowMatchingActor, fields: Field[] = [{ label: "Size", value: "16 inches" }], title = "Synthetic custom shaped pillow 10–24 inches"): Promise<PillowMatchingOrder> {
      const externalOrderId = `SYNTHETIC-PILLOW-${createEntityId()}`, externalLineId = createEntityId();
      const result = await orders.materializeNormalized(owner.context, {
        accountId: owner.accountId, platform: "amazon", externalEventId: randomUUID(), externalOrderId,
        providerStatus: "UNSHIPPED", placedAt: new Date().toISOString(), orderTotal: null,
        redactedSource: { source: "synthetic-pillow-read-projection" }, protectedDetails: null,
        lines: [{ externalLineId, externalListingId: null, skuCode: "SYNTHETIC-PILLOW", title, quantity: 2, unitPrice: null, customizationCount: fields.length }],
      });
      const orderId = result.order.id, lineId = result.order.lines[0]!.id;
      const batchId = createEntityId(), reportLineId = createEntityId(), versionId = createEntityId();
      const metadata = { surfaces: [{ key: "front", label: "Synthetic front", fields: fields.map((field, index) => ({ key: `choice-${index}`, kind: "choice", ...field })), previewFileKey: null, buyerFileKeys: [] }], files: [], warnings: [] };
      // Seed only synthetic encrypted read inputs. The actual report service
      // decrypts/authorizes this projection; it does not download or approve it.
      await withTenant(database.db, owner.context, async tx => {
        await tx.insert(amazonOrderReportBatches).values({ id: batchId, tenantId: owner.context.tenantId, accountId: owner.accountId,
          marketplaceId: "ATVPDKIKX0DER", fileName: "synthetic-pillow.txt", reportChecksum: digest(metadata), rowCount: 1, orderCount: 1, status: "completed", createdBy: owner.context.userId, expiresAt: expiry });
        await tx.insert(amazonOrderReportLines).values({ id: reportLineId, tenantId: owner.context.tenantId, orderId, orderLineId: lineId,
          batchId, sourceChecksum: digest(metadata), state: "ready", expiresAt: expiry });
        await tx.insert(amazonOrderReportVersions).values({ id: versionId, tenantId: owner.context.tenantId, reportLineId, versionNumber: 1,
          checksum: digest(metadata), encryptedDocument: vault.encrypt(JSON.stringify({ syntheticReadProjectionOnly: true })),
          scanEngine: "synthetic-metadata-only", scanSignature: "no-files", expiresAt: expiry });
        await tx.insert(amazonOrderReportReadModels).values({ tenantId: owner.context.tenantId, versionId,
          encryptedMetadata: vault.encrypt(JSON.stringify(metadata)), encryptedThumbnails: vault.encrypt("[]") });
        await tx.update(amazonOrderReportLines).set({ currentVersionId: versionId, versionNumber: 1 }).where(eq(amazonOrderReportLines.id, reportLineId));
      });
      return { lineId, orderId, externalOrderId, reportLineId, versionId };
    }

    async function saveDraft(owner: PillowMatchingActor, detail: OrderWorkDetail, draft: OrderWorkDraft = detail.draft) {
      return work.save(owner.context, detail.line.id, { expectedRevision: detail.line.revision,
        expectedProjectionVersion: detail.line.projectionVersion, expectedSourceVersionId: detail.report?.versionId ?? null,
        status: "needs_information", draft: { ...draft, designExecutor: "human" }, reason: "Synthetic partial intake, no approval", idempotencyKey: randomUUID() });
    }

    async function appendSource(owner: PillowMatchingActor, order: PillowMatchingOrder, payload: Record<string, unknown>, receivedAt = new Date()) {
      const id = createEntityId();
      await withTenant(database.db, owner.context, tx => tx.insert(orderSourceSnapshots).values({
        id, tenantId: owner.context.tenantId, accountId: owner.accountId, platform: "amazon", externalEventId: randomUUID(),
        externalOrderId: order.externalOrderId, normalizedOrderId: order.orderId, payloadChecksum: digest(payload), redactedPayload: payload, receivedAt,
      }));
      return id;
    }

    function officialSource(order: PillowMatchingOrder, at: unknown, updated: unknown = "2026-10-25T12:00:00.000Z") {
      return { apiVersion: "2026-01-01", orderId: order.externalOrderId, marketplaceId: "ATVPDKIKX0DER", lastUpdatedTime: updated,
        platformShipByAt: at, platformShipBySource: "amazon_orders_2026_fulfillment_ship_by_window", platformShipByField: "fulfillment.shipByWindow.latestDateTime" };
    }

    async function revisions(owner: PillowMatchingActor, lineId: string) {
      return withTenant(database.db, owner.context, tx => tx.select().from(orderWorkRevisions).where(eq(orderWorkRevisions.workItemId, lineId)));
    }

    async function setPermissions(owner: PillowMatchingActor, value: TenantContext["permissions"]) {
      await withTenant(database.db, owner.context, tx => tx.update(roles).set({ permissions: [...value] }).where(eq(roles.id, owner.roleId)));
    }

    async function unreviewedTemplate(owner: PillowMatchingActor) {
      const document: ProductionEditorDocument = { schemaVersion: 1, name: "Synthetic unreviewed common pillow", productType: "shaped_pillow",
        spec: { factoryStandardId: "ps-pillow-2026-09-17", widthMm: 300, heightMm: 400, dpi: 150, sideMode: "single",
          declaredLongestMm: 406.4, sizeBasis: "artwork", whiteBorderMm: 200 * 25.4 / 150, cutLineMm: 6 * 25.4 / 150,
          minimumNeckMm: 50, minimumNeckBasis: "unconfirmed", panelGapMm: 100 * 25.4 / 150,
          barcodeTab: { widthMm: null, heightMm: null, centerXMm: 150 } },
        contour: [{ xMm: 0, yMm: 0, smooth: false }, { xMm: 300, yMm: 0, smooth: false }, { xMm: 300, yMm: 400, smooth: false }, { xMm: 0, yMm: 400, smooth: false }],
        layers: [], confirmations: { physicalSize: false, whiteBorderRule: false, narrowParts: false, barcodeTab: false, backText: false, visualReview: false } };
      let result = await editor.create(owner.context, { name: document.name, document });
      for (let version = 2; version <= 4; version++) result = await editor.save(owner.context, result.project.id, { expectedVersionId: result.version.id, document: { ...document, name: `Synthetic unreviewed V${version}` } });
      return result;
    }

    async function productionState(owner: PillowMatchingActor, projectId: string) {
      return withTenant(database.db, owner.context, async tx => ({
        project: (await tx.select().from(productionEditorProjects).where(eq(productionEditorProjects.id, projectId)))[0],
        renders: await tx.select().from(productionEditorRenders).where(eq(productionEditorRenders.projectId, projectId)),
        specs: await tx.select().from(productSpecificationVersions).orderBy(productSpecificationVersions.id),
      }));
    }

    async function setInternalDue(owner: PillowMatchingActor, order: PillowMatchingOrder, at: string) {
      const detail = await work.detail(owner.context, order.lineId);
      await saveDraft(owner, detail, { ...detail.draft, dueAt: at });
    }

    async function rawRole(owner: PillowMatchingActor) {
      return withTenant(database.db, owner.context, tx => tx.execute<{ role: string }>(sql`select current_user as role`));
    }

    async function visibleVersion(owner: PillowMatchingActor, versionId: string) {
      return withTenant(database.db, owner.context, tx => tx.select().from(productSpecificationVersions)
        .innerJoin(productSpecifications, and(eq(productSpecifications.id, productSpecificationVersions.specificationId), eq(productSpecifications.tenantId, productSpecificationVersions.tenantId)))
        .where(eq(productSpecificationVersions.id, versionId)));
    }

    return { database, catalog, work, editor, actor, createSpu, specification, registerCustomerArtwork, seedOrder, saveDraft, appendSource, officialSource,
      revisions, setPermissions, unreviewedTemplate, productionState, setInternalDue, rawRole, visibleVersion, external, scan,
      close: () => database.client.end() };
  } catch (error) { await database.client.end(); throw error; }
}
