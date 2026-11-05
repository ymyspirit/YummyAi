import { createHash, randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import type { FactoryDocumentProfile } from "@yummyai/contracts/logistics/documents";
import { connectDatabase, withTenant, marketplaceAccounts, fulfillmentSuppliers, orderWorkItems, orderWorkRevisions,
  logisticsDocumentExports, logisticsDocumentLabels, orderProtectedDetails, roles } from "@yummyai/database";
import { sealWork, OrderDocumentSourceReader } from "@yummyai/order-core";
import { normalizeAmazonOrder } from "@yummyai/marketplace-connectors";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { syntheticFactoryProfile, syntheticSupplierProfile } from "../../../../tools/testing/factory-fixtures.js";
import { manufacturingBasis } from "../catalog/manufacturing.test-fixture.js";
import { AuditService } from "../audit/audit.service.js";
import { FactoryDirectoryService } from "../suppliers/factory-directory.service.js";
import { OrderService } from "../orders/order.service.js";
import type { OrderProductionDeliveryService } from "../orders/order-production-delivery.service.js";
import { LogisticsDocumentsService } from "./logistics-documents.service.js";
import { LogisticsDocumentLabelsService } from "./logistics-document-labels.service.js";

requireDisposableIntegrationEnvironment();
if (process.env.E2E_ISOLATED_DAILY !== "1" || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname)) throw new Error("Use disposable logistics acceptance");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
describe.sequential("native daily order documents", () => {
  const database = connectDatabase(), context: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), dataScope: "tenant", permissions: Object.values(Permission) };
  const other = { ...context, tenantId: createEntityId() }, accountId = createEntityId(), supplierId = createEntityId(), roleId = createEntityId();
  const vault = new SecretVault(Buffer.alloc(32, 47)), audit = new AuditService(database), orderService = new OrderService(database, vault, audit), factoryService = new FactoryDirectoryService(database, audit);
  const production = { documentItemsInTransaction: async () => { throw new Error("Synthetic fixture has no approved production files"); }, verifyDocumentFiles: async () => { throw new Error("Must never bypass production owner"); } } as unknown as OrderProductionDeliveryService;
  const service = new LogisticsDocumentsService(database, vault, audit, production);
  const labelService = new LogisticsDocumentLabelsService(database, vault, service, production, audit);
  let product: Awaited<ReturnType<typeof manufacturingBasis>>;
  beforeAll(async () => {
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic document tenant',$2),($3,'Synthetic other tenant',$4)", [context.tenantId, `documents-${context.tenantId}`, other.tenantId, `documents-${other.tenantId}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic operator')", [context.userId, `documents-${context.userId}`, `${context.userId}@example.invalid`]);
    const membership = createEntityId();
    await database.client.unsafe("insert into memberships(id,tenant_id,user_id,status) values($1,$2,$3,'active')", [membership, context.tenantId, context.userId]);
    await database.client.unsafe("insert into roles(id,tenant_id,name,permissions,data_scope) values($1,$2,'Synthetic operator',$3::jsonb,'tenant')", [roleId, context.tenantId, JSON.stringify(context.permissions)]);
    await database.client.unsafe("insert into membership_roles(tenant_id,membership_id,role_id) values($1,$2,$3)", [context.tenantId, membership, roleId]);
    await withTenant(database.db, context, async tx => {
      await tx.insert(marketplaceAccounts).values({ id: accountId, tenantId: context.tenantId, platform: "amazon", displayName: "Synthetic account", region: "NA", authorizationMode: "amazon_private", createdBy: context.userId });
      await tx.insert(fulfillmentSuppliers).values({ id: supplierId, tenantId: context.tenantId, name: "Synthetic supplier", kind: "manual", status: "active", regionCode: "US", settlementCurrency: "USD", profile: syntheticSupplierProfile, createdBy: context.userId });
    });
    product = await manufacturingBasis(database, context, "shaped_pillow");
  });
  // The disposable runner drops this exact database, bucket and Redis prefix in its finally block.
  afterAll(async () => { await database.client.end(); });

  async function setup(country: "US" | "CA" = "US", recipient = "Synthetic Buyer") {
    const origin = country === "US" ? "US" : "CN", fp = syntheticFactoryProfile(`Synthetic ${origin} documents`);
    fp.productionAddress = { ...fp.productionAddress!, countryCode: origin };
    const factory = await factoryService.create(context, { supplierId, code: `DOC-${randomUUID()}`, profile: fp, idempotencyKey: randomUUID() });
    const profile: FactoryDocumentProfile = { name: "Synthetic verified packing", route: origin === "US" ? "printeque" : "yunexpress",
      productionAdapter: origin === "US" ? "printeque_factory" : "yicai_folder", originCountryCode: origin, destinationCountries: [country],
      originCompany: "Synthetic", factoryCode: "TEST", carrierProvider: "TEST", carrierService: "", useAccountSender: true, evidence: "Synthetic measured packing fixture",
      specifications: [{ specificationVersionId: product.specificationVersionId, productKind: "shaped_pillow", sizeIn: 12, supplierSku: "CP-12", weight: .31, weightUnit: "lb",
        length: 10, width: 5, height: 5, dimensionUnit: "in", declaredUnitValueMinor: 800, nameEn: "Pillow", nameCn: "抱枕", hsCode: "" }] };
    const saved = await service.saveProfile(context, { factoryId: factory.id, expectedVersion: 0, profile, idempotencyKey: randomUUID() });
    const externalId = `SYNTHETIC-DOC-${randomUUID()}`;
    const input = { accountId, platform: "amazon" as const, externalEventId: randomUUID(), externalOrderId: externalId, providerStatus: "paid", placedAt: new Date().toISOString(), orderTotal: null,
      lines: [{ externalLineId: "line-a", externalListingId: null, skuCode: "changed-new-sku", title: "Synthetic pillow", quantity: 2, unitPrice: null, customizationCount: 0 },
        { externalLineId: "line-b", externalListingId: null, skuCode: "another-sku", title: "Synthetic pillow", quantity: 1, unitPrice: null, customizationCount: 0 }],
      redactedSource: { synthetic: true }, protectedDetails: { buyer: { name: recipient, email: "test@example.invalid", phone: "0001234567" }, shippingAddress: { recipient, lines: ["1 Synthetic Street"], city: "Test City", region: country === "US" ? "California" : "Ontario", postalCode: "00123", countryCode: country }, customizations: [] } };
    const order = await orderService.ingestNormalized(context, input);
    await withTenant(database.db, context, async tx => {
      for (const line of order.lines) {
        const key = Buffer.alloc(32, 29), draft = { printProfileVersionId: null, specificationVersionId: product.specificationVersionId, fields: [], images: [], instructions: "", customerApprovalRequired: false, dueAt: null };
        await tx.insert(orderWorkItems).values({ id: line.id, tenantId: context.tenantId, revision: 1, encryptedDataKey: vault.encrypt(key.toString("base64")), expiresAt: new Date(Date.now() + 86400000) });
        await tx.insert(orderWorkRevisions).values({ id: createEntityId(), tenantId: context.tenantId, workItemId: line.id, revision: 1, encryptedDraft: sealWork(key, draft), checksum: sha(JSON.stringify(draft)), createdBy: context.userId });
      }
    });
    const selection = { profileVersionId: saved.id, adapter: country === "US" ? "printeque_shipping" as const : "yunexpress" as const, orderIds: [order.id], overrides: [], deliveryPackageIds: [] };
    return { order, input, profile, factory, saved, selection };
  }
  async function workbook(id: string) {
    const file = await service.download(context, id), book = new ExcelJS.Workbook();
    try { await book.xlsx.load(Uint8Array.from(file.body).buffer); return book; } finally { file.body.fill(0); }
  }
  it("carries official API private fields through encrypted ingestion into shipping documents", async () => {
    const f = await setup("CA"), at = new Date().toISOString();
    const normalized = normalizeAmazonOrder(accountId, randomUUID(), {
      orderId: f.input.externalOrderId, createdTime: f.input.placedAt, lastUpdatedTime: at,
      salesChannel: { marketplaceId: "A2EUQ1WTGCTBG2" }, fulfillment: { fulfillmentStatus: "UNSHIPPED" },
      proceeds: { grandTotal: { amount: "24.00", currencyCode: "USD" } },
      buyer: { buyerName: "Synthetic Buyer", buyerEmail: "buyer@example.invalid", phone: "1111111111" },
      recipient: { deliveryAddress: { name: "Synthetic Recipient", addressLine1: "2 Private Street", city: "Toronto",
        stateOrRegion: "Ontario", postalCode: "M1B 1B1", countryCode: "CA", phone: "0222222222" } },
      orderItems: f.input.lines.map(line => ({ orderItemId: line.externalLineId, quantityOrdered: line.quantity,
        product: { title: line.title, sellerSku: line.skuCode, price: { unitPrice: { amount: "8.00", currencyCode: "USD" } },
          customization: { customizedUrl: "https://custom.example.invalid/private.zip?signature=synthetic" } } })),
    }).order;
    const receipt = await orderService.materializeNormalized(context, normalized);
    expect(receipt.order.id).toBe(f.order.id);
    expect((await orderService.materializeNormalized(context, normalized)).replayed).toBe(true);
    const [stored] = await withTenant(database.db, context, tx => tx.select().from(orderProtectedDetails).where(eq(orderProtectedDetails.orderId, f.order.id)));
    expect(JSON.stringify(stored)).not.toMatch(/Private Street|0222222222|private.zip|buyer@example/);
    expect(vault.withSecret(stored!.encryptedEnvelope!, secret => JSON.parse(secret))).toMatchObject({
      shippingAddress: { phone: "0222222222", countryCode: "CA" }, customizations: [{ externalLineId: "line-a" }, { externalLineId: "line-b" }],
    });
    const source = await withTenant(database.db, context, tx => new OrderDocumentSourceReader(vault).read(tx, context, f.order.id));
    expect(source.source.address).toMatchObject({ recipient: "Synthetic Recipient", phone: "0222222222", address1: "2 Private Street", countryCode: "CA" });
    expect((await service.preview(context, f.selection)).ready).toBe(true);
    expect(JSON.stringify(await orderService.get(context, f.order.id))).not.toMatch(/Private Street|0222222222|private.zip|buyer@example/);
    await expect(withTenant(database.db, other, tx => new OrderDocumentSourceReader(vault).read(tx, other, f.order.id))).rejects.toThrow();
    await orderService.ingestNormalized(context, { ...normalized, externalEventId: randomUUID(), protectedDetails: {
      ...normalized.protectedDetails!, shippingAddress: { ...normalized.protectedDetails!.shippingAddress, phone: null } } });
    expect((await withTenant(database.db, context, tx => new OrderDocumentSourceReader(vault).read(tx, context, f.order.id))).source.address.phone).toBe("");
  });
  it("uses native specification pins despite new seller SKUs, groups the entire order and preserves text/numeric cells", async () => {
    const f = await setup(), preview = await service.preview(context, f.selection);
    expect(preview).toMatchObject({ ready: true, rowCount: 1 });
    expect(preview.orders[0]!.parcel).toMatchObject({ quantity: 3, weightLb: .93, lengthIn: 10, widthIn: 10, heightIn: 10 });
    const result = await service.generate(context, { ...f.selection, expectedFingerprint: preview.fingerprint, idempotencyKey: randomUUID() });
    const book = await workbook(result.id), sheet = book.getWorksheet("Sheet1")!;
    const headers = new Map<string, number>(); sheet.getRow(2).eachCell((cell, index) => headers.set(String(cell.value), index));
    expect(sheet.rowCount).toBe(3); expect(sheet.getCell(3, headers.get("州/省")!).value).toBe("CA");
    expect(sheet.getCell(3, headers.get("收件人邮编")!).value).toBe("00123"); expect(sheet.getCell(3, headers.get("长")!).numFmt ?? "General").toBe("General");
    expect((await orderService.get(context, f.order.id)).workflowState).toBe(f.order.workflowState);
  });
  it("reuses bytes for repeated generation and unchanged re-imports without duplicating receipts", async () => {
    const f = await setup(), preview = await service.preview(context, f.selection), key = randomUUID();
    const first = await service.generate(context, { ...f.selection, expectedFingerprint: preview.fingerprint, idempotencyKey: key });
    await orderService.ingestNormalized(context, { ...f.input, externalEventId: randomUUID() });
    const again = await service.preview(context, f.selection); expect(again.fingerprint).toBe(preview.fingerprint);
    const repeated = await service.generate(context, { ...f.selection, expectedFingerprint: again.fingerprint, idempotencyKey: randomUUID() });
    expect(repeated).toEqual({ id: first.id, reused: true });
    expect((await service.history(context, { orderId: f.order.id })).exports).toHaveLength(1);
  });
  it("rejects stale previews and downloads after original order address changes", async () => {
    const f = await setup(), preview = await service.preview(context, f.selection);
    const file = await service.generate(context, { ...f.selection, expectedFingerprint: preview.fingerprint, idempotencyKey: randomUUID() });
    await orderService.ingestNormalized(context, { ...f.input, externalEventId: randomUUID(), protectedDetails: { ...f.input.protectedDetails, shippingAddress: { ...f.input.protectedDetails.shippingAddress, lines: ["2 Changed Street"] } } });
    await expect(service.generate(context, { ...f.selection, expectedFingerprint: preview.fingerprint, idempotencyKey: randomUUID() })).rejects.toThrow(/变化/);
    await expect(service.download(context, file.id)).rejects.toThrow(/变化/);
    expect((await service.history(context, { orderId: f.order.id })).exports[0]).toMatchObject({ available: false });
  });
  it("enforces tenant isolation, tenant-scoped private permission and current membership revocation", async () => {
    const f = await setup(), preview = await service.preview(context, f.selection), file = await service.generate(context, { ...f.selection, expectedFingerprint: preview.fingerprint, idempotencyKey: randomUUID() });
    await expect(service.download(other, file.id)).rejects.toThrow();
    await expect(service.preview({ ...context, permissions: [Permission.OrderRead] }, f.selection)).rejects.toThrow();
    await withTenant(database.db, context, tx => tx.update(roles).set({ permissions: [Permission.OrderRead] }).where(eq(roles.id, roleId)));
    try { await expect(service.download({ ...context, permissionScopes: Object.fromEntries(context.permissions.map(permission => [permission, "tenant"])) }, file.id)).rejects.toThrow(); }
    finally { await withTenant(database.db, context, tx => tx.update(roles).set({ permissions: context.permissions }).where(eq(roles.id, roleId))); }
  });
  it("supports Yun channel overrides, kg and only the first declaration while blocking incomplete names", async () => {
    const f = await setup("CA"), selection = { ...f.selection, overrides: [{ orderId: f.order.id, channelCode: "ZBZXRPH", reason: "Synthetic operator channel decision" }] };
    const preview = await service.preview(context, selection); expect(preview).toMatchObject({ ready: true });
    expect(preview.orders[0]!.rows[0]).toMatchObject({ "产品代码": "ZBZXRPH", "包裹总重量": .423, "申报数量1": 3, "申报FOB价1": 8 });
    const file = await service.generate(context, { ...selection, expectedFingerprint: preview.fingerprint, idempotencyKey: randomUUID() });
    const book = await workbook(file.id), sheet = book.getWorksheet("标准模板")!;
    sheet.getRow(1).eachCell((cell, index) => { if (["配货信息1", "规格1", "申报品名2", "申报数量2", "申报FOB价2", "申报单重2", "配货信息2", "规格2", "SKU1"].includes(String(cell.value))) expect(sheet.getCell(2, index).value).toBeNull(); });
    const incomplete = await setup("CA", "Fady"), invalid = await service.preview(context, incomplete.selection);
    expect(invalid.ready).toBe(false); await expect(service.generate(context, { ...incomplete.selection, expectedFingerprint: invalid.fingerprint, idempotencyKey: randomUUID() })).rejects.toThrow();
  });
  it("keeps immutable receipts and erases private XLSX when an original source expires", async () => {
    const f = await setup(), preview = await service.preview(context, f.selection), file = await service.generate(context, { ...f.selection, expectedFingerprint: preview.fingerprint, idempotencyKey: randomUUID() });
    await expect(withTenant(database.db, context, tx => tx.update(logisticsDocumentExports).set({ encryptedSnapshot: "tampered" }).where(eq(logisticsDocumentExports.id, file.id)))).rejects.toThrow();
    await withTenant(database.db, context, tx => tx.update(orderProtectedDetails).set({ retentionExpiresAt: new Date(0) }).where(eq(orderProtectedDetails.orderId, f.order.id)));
    await expect(service.download(context, file.id)).rejects.toThrow();
    const [receipt] = await withTenant(database.db, context, tx => tx.select().from(logisticsDocumentExports).where(eq(logisticsDocumentExports.id, file.id)));
    expect(receipt!.encryptedSnapshot).toBeNull(); expect(receipt!.fileChecksum).toHaveLength(64);
  });
  it("rejects factory configuration races and ERP generation without real approved packages", async () => {
    const f = await setup();
    await expect(service.saveProfile(context, { factoryId: f.factory.id, expectedVersion: 0, profile: f.profile, idempotencyKey: randomUUID() })).rejects.toThrow(/已更新/);
    await expect(service.preview(context, { ...f.selection, adapter: "printeque_factory" })).rejects.toThrow(/正式交付包/);
    await expect(service.preview(context, { ...f.selection, adapter: "printeque_factory", deliveryPackageIds: [createEntityId()] })).rejects.toThrow(/approved production/);
  });
  it("scans and registers official-label evidence without declaring shipment, deduplicates and blocks replaced or expired labels", async () => {
    const f = await setup("CA"), preview = await service.preview(context, f.selection);
    const exported = await service.generate(context, { ...f.selection, expectedFingerprint: preview.fingerprint, idempotencyKey: randomUUID() });
    const basis = await labelService.basis(context, exported.id, f.order.id);
    const pdf = Buffer.from("%PDF-1.4\n% Synthetic isolated label evidence, not a real shipping label\n%%EOF\n");
    const input = { exportId: exported.id, orderId: f.order.id, expectedFingerprint: basis.fingerprint, trackingNumber: "SYNTHETIC123", fileName: "synthetic-label.pdf", base64: pdf.toString("base64"), verifiedByOperator: true, idempotencyKey: randomUUID() };
    const first = await labelService.register(context, input);
    expect(await labelService.register(context, { ...input, idempotencyKey: randomUUID() })).toEqual({ id: first.id, reused: true });
    expect((await labelService.download(context, first.id)).body.equals(pdf)).toBe(true);
    await expect(labelService.download(other, first.id)).rejects.toThrow();
    await expect(labelService.register(context, { ...input, verifiedByOperator: false })).rejects.toThrow();
    await expect(labelService.register(context, { ...input, base64: Buffer.from("not a PDF").toString("base64") })).rejects.toThrow(/完整 PDF/);
    const second = await labelService.register(context, { ...input, trackingNumber: "SYNTHETIC456", idempotencyKey: randomUUID() });
    await expect(labelService.download(context, first.id)).rejects.toThrow(/更新/);
    expect((await orderService.get(context, f.order.id)).workflowState).toBe(f.order.workflowState);
    await withTenant(database.db, context, tx => tx.update(orderProtectedDetails).set({ retentionExpiresAt: new Date(0) }).where(eq(orderProtectedDetails.orderId, f.order.id)));
    await expect(labelService.download(context, second.id)).rejects.toThrow();
    const records = await withTenant(database.db, context, tx => tx.select().from(logisticsDocumentLabels).where(eq(logisticsDocumentLabels.orderId, f.order.id)));
    expect(records.every(record => record.encryptedSnapshot === null)).toBe(true);
  });
});
