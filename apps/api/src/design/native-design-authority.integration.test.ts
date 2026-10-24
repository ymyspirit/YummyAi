import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { assetFiles, canvasPrintSpecVersions, connectDatabase, creativeDesignBatchItems, creativeDesignBatches, creativeDesignCandidates, creativeDesignSkuBindings, creativeDesignVersionAssets, creativeDesignVersions, designTasks, designVersions, loadCurrentMembershipContext, migrateDatabase, roles, skus, withTenant } from "@yummyai/database";
import { createStorageFromEnvironment } from "@yummyai/storage";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DrizzleCatalogRepository, ProductService } from "../catalog/product.service.js";
import { DesignService, DrizzleDesignRepository, ResearchAssetPromotionError } from "./design.service.js";
import { AuditService } from "../audit/audit.service.js";
import { PodBatchWorkflowService } from "./pod-batch-workflow.service.js";
import { approvedDesignProductionSource } from "./production-design-source.js";

if (process.env.E2E_ISOLATED_DAILY !== "1" || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname) || !/^order-daily-e2e-[a-f0-9]{32}$/.test(process.env.S3_PRIVATE_BUCKET ?? ""))
  throw new Error("Run native design authority through the disposable order-daily acceptance runner");

describe("native design authority in real tenant transactions", () => {
  const database = connectDatabase(), storage = createStorageFromEnvironment();
  const repository = new DrizzleDesignRepository(database, storage), service = new DesignService(repository);
  const catalog = new ProductService(new DrizzleCatalogRepository(database));
  const pod = new PodBatchWorkflowService(database, { async enqueueCreativeCandidate() {}, async enqueueCreativeAdaptation() {}, async enqueueTemplateCompile() {}, async enqueueMockupRender() {} }, new AuditService(database), service);
  const tenantId = createEntityId(), userId = createEntityId(), otherUser = createEntityId();
  const membershipId = createEntityId(), roleId = createEntityId(), wideRoleId = createEntityId();
  const all = Object.values(Permission);
  const base: TenantContext = { tenantId, userId, permissions: all, dataScope: "tenant" };
  const other: TenantContext = { ...base, userId: otherUser };
  let ownSku: string, otherSku: string, ownTask: string, otherTask: string, ownAsset: string, otherAsset: string;
  let png: Buffer;
  async function grant(permissions: readonly string[] = all, dataScope: "tenant" | "team" | "self" = "tenant") {
    await withTenant(database.db, base, tx => tx.update(roles).set({ permissions, dataScope }).where(eq(roles.id, roleId)));
  }
  async function wide(permissions: readonly string[] = [Permission.WorkflowRead], dataScope: "tenant" | "team" | "self" = "tenant") {
    await withTenant(database.db, base, tx => tx.update(roles).set({ permissions, dataScope }).where(eq(roles.id, wideRoleId)));
  }
  const current = () => withTenant(database.db, base, tx => loadCurrentMembershipContext(tx, base));
  const versions = (taskId: string) => withTenant(database.db, base, tx => tx.select().from(designVersions).where(eq(designVersions.taskId, taskId)));
  async function newTask(context = base) {
    return service.createTask(context, { skuId: context.userId === userId ? ownSku : otherSku, title: `Synthetic ${createEntityId()}`, brief: "Synthetic artwork with no customer data" });
  }
  async function newVersion(context = base) {
    const task = await newTask(context);
    const version = await service.uploadVersion(context, task.id, { files: [{ assetId: context.userId === userId ? ownAsset : otherAsset, role: "production" }] });
    return { task, version };
  }
  async function asset(context = base, domain: "authorized" | "research" | "order" = "authorized") {
    const id = createEntityId(), stored = await storage.putPrivate(context, { body: png, domain, fileName: `${id}.png`, mediaType: "image/png" });
    await withTenant(database.db, context, tx => tx.insert(assetFiles).values({
      id, tenantId, ownerUserId: context.userId, objectKey: stored.objectKey,
      assetDomain: domain, fileName: `${id}.png`, mediaType: "image/png", byteSize: png.length,
      checksumSha256: stored.checksumSha256, rightsStatus: "approved",
      rightsMetadata: { source: { kind: domain === "order" ? "customer_provided" : domain === "research" ? "competitor" : "owned", reference: domain === "order" ? createEntityId() : "Synthetic evidence" }, approvedAt: new Date().toISOString() },
    }));
    return id;
  }
  async function sku(context: TenantContext) {
    const id = createEntityId(), plan = await catalog.createPlan(context, { name: `Synthetic ${id}`, sourceReportIds: [createEntityId()], customization: { version: 1, fields: [] } });
    await catalog.transition(context, plan.id, "pending_approval"); await catalog.transition(context, plan.id, "approved");
    const spu = await catalog.createSpu(context, plan.id, { code: `SPU-${id}`, name: "Synthetic source" });
    return (await catalog.createSku(context, { spuId: spu.id, code: `SKU-${id}`, attributes: {} })).id;
  }
  async function creative(context = base) {
    const master = await asset(context), variant = await asset(context), specId = createEntityId(), batchId = createEntityId(), itemId = createEntityId(), candidateId = createEntityId(), versionId = createEntityId();
    const stored = (await repository.getAsset(context, master))!;
    await withTenant(database.db, context, async tx => {
      await tx.update(assetFiles).set({ rightsStatus: "unverified", rightsMetadata: { source: { kind: "owned" }, attestedBy: context.userId } }).where(eq(assetFiles.id, master));
      await tx.update(assetFiles).set({ rightsStatus: "unverified", rightsMetadata: { source: { kind: "owned" }, attestedBy: context.userId } }).where(eq(assetFiles.id, variant));
      await tx.insert(canvasPrintSpecVersions).values({ id: specId, tenantId, specId: createEntityId(), versionNumber: 1, name: "Synthetic 4:3", aspectWidth: 4, aspectHeight: 3, targetDpi: 300, bleedMm: "1", safeZoneMm: "1", wrapMode: "none", physicalSizes: [{ key: "40x30", label: "Synthetic", widthMm: 40, heightMm: 30 }], status: "approved", createdBy: context.userId, reviewedBy: context.userId, reviewedAt: new Date() });
      await tx.insert(creativeDesignBatches).values({ id: batchId, tenantId, name: `Synthetic ${batchId}`, itemCount: 1, generatedCount: 1, status: "awaiting_review", requestChecksum: batchId.replaceAll("-", "").repeat(2), createdBy: context.userId });
      await tx.insert(creativeDesignBatchItems).values({ id: itemId, tenantId, batchId, ordinal: 0, rowKey: "synthetic", name: "Synthetic creative", prompt: "Synthetic geometry", candidateCount: 1, printSpecVersionIds: [specId], focalPoint: { xPermille: 500, yPermille: 500 }, status: "completed" });
      await tx.insert(creativeDesignCandidates).values({ id: candidateId, tenantId, itemId, ordinal: 0, status: "selected", assetId: master, assetVersion: stored.version, checksumSha256: stored.sha256, promptTemplateVersion: "synthetic", parameterSnapshot: {}, inputChecksum: candidateId.replaceAll("-", "").repeat(2), completedAt: new Date() });
      await tx.insert(creativeDesignVersions).values({ id: versionId, tenantId, familyId: createEntityId(), versionNumber: 1, sourceCandidateId: candidateId, name: `Creative ${versionId}`, status: "pending_review", createdBy: context.userId });
      await tx.insert(creativeDesignVersionAssets).values([
        { id: createEntityId(), tenantId, creativeDesignVersionId: versionId, assetId: master, assetVersion: 1, role: "master", adaptationMode: "original", generatedRegions: [] },
        { id: createEntityId(), tenantId, creativeDesignVersionId: versionId, assetId: variant, assetVersion: 1, role: "aspect_variant", printSpecVersionId: specId, adaptationMode: "crop", generatedRegions: [] },
      ]);
    });
    return { versionId, specId, master, variant };
  }
  beforeAll(async () => {
    await migrateDatabase(database); await storage.ensureBucket();
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Native design authority',$2)", [tenantId, `native-design-${tenantId}`]);
    for (const id of [userId, otherUser]) await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic designer')", [id, `design-${id}`, `${id}@example.test`]);
    await database.client.unsafe("insert into memberships(id,tenant_id,user_id,status) values($1,$2,$3,'active')", [membershipId, tenantId, userId]);
    for (const [id, name, permissions] of [[roleId, "Design operator", all], [wideRoleId, "Unrelated wide grant", [Permission.WorkflowRead]]] as const) {
      await database.client.unsafe("insert into roles(id,tenant_id,name,permissions,data_scope) values($1,$2,$3,$4::jsonb,'tenant')", [id, tenantId, name, JSON.stringify(permissions)]);
      await database.client.unsafe("insert into membership_roles(tenant_id,membership_id,role_id) values($1,$2,$3)", [tenantId, membershipId, id]);
    }
    png = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#2563eb" } }).png().toBuffer();
    ownSku = await sku(base); otherSku = await sku(other);
    ownAsset = await asset(); otherAsset = await asset(other);
    ownTask = (await newTask()).id; otherTask = (await newTask(other)).id;
  });
  beforeEach(async () => { vi.restoreAllMocks(); await grant(); await wide(); });
  afterAll(async () => { vi.restoreAllMocks(); await database.client.end(); });

  it("denies direct repository reads without design permission", async () => {
    await expect(repository.listTasks({ ...base, permissions: [] })).rejects.toMatchObject({ status: 403 });
  });

  it.each(["self", "team"] as const)("filters task lists by the design permission's %s scope", async scope => {
    await grant([Permission.DesignRead], scope);
    const context = await current(); expect(context.dataScope).toBe("tenant");
    const tasks = await repository.listTasks(context);
    expect(tasks.some(t => t.id === ownTask)).toBe(true);
    expect(tasks.some(t => t.id === otherTask)).toBe(false);
  });

  it("rechecks current membership before returning stored design tasks", async () => {
    const context = await current(); await grant([]);
    await expect(repository.getTask(context, ownTask)).rejects.toMatchObject({ status: 403 });
  });

  it("does not create tasks without design-write authority", async () => {
    const input = { skuId: ownSku, title: "Forbidden task", brief: "Must not be created" };
    await expect(repository.createTask({ ...base, permissions: [Permission.ProductRead, Permission.DesignRead] }, input)).rejects.toMatchObject({ status: 403 });
    const rows = await withTenant(database.db, base, tx => tx.select().from(designTasks).where(eq(designTasks.title, input.title)));
    expect(rows).toHaveLength(0);
  });

  it("checks access to the actual SKU before creating a new design task", async () => {
    await grant([Permission.ProductRead], "self"); await wide([Permission.DesignWrite, Permission.DesignRead]);
    await expect(repository.createTask(await current(), { skuId: otherSku, title: "Forbidden source", brief: "A known ID is not source access" })).rejects.toMatchObject({ status: 404 });
  });

  it("does not borrow tenant read scope for a self-scoped version write", async () => {
    await grant([Permission.DesignWrite], "self"); await wide([Permission.DesignRead, Permission.AssetRead]);
    const before = (await versions(otherTask)).length;
    await expect(repository.createVersion(await current(), otherTask, { files: [{ assetId: ownAsset, role: "production" }] })).rejects.toMatchObject({ status: 403 });
    expect(await versions(otherTask)).toHaveLength(before);
  });

  it("checks each attached asset's own read scope", async () => {
    await grant([Permission.AssetRead], "self"); await wide([Permission.DesignWrite, Permission.DesignRead]);
    const before = (await versions(ownTask)).length;
    await expect(repository.createVersion(await current(), ownTask, { files: [{ assetId: otherAsset, role: "production" }] })).rejects.toMatchObject({ status: 403 });
    expect(await versions(ownTask)).toHaveLength(before);
  });

  it("rechecks rights in the version transaction after the service's earlier read", async () => {
    const id = await asset(), original = repository.createVersion.bind(repository), before = (await versions(ownTask)).length;
    vi.spyOn(repository, "createVersion").mockImplementationOnce(async (...args) => {
      await withTenant(database.db, base, tx => tx.update(assetFiles).set({ rightsStatus: "rejected" }).where(eq(assetFiles.id, id)));
      return original(...args);
    });
    await expect(service.uploadVersion(base, ownTask, { files: [{ assetId: id, role: "production" }] })).rejects.toThrow();
    expect(await versions(ownTask)).toHaveLength(before);
  });

  it("checks review scope in the actual mutation transaction", async () => {
    const { version } = await newVersion(other);
    await grant([Permission.DesignReview], "self"); await wide([Permission.DesignRead, Permission.AssetRead]);
    await expect(repository.reviewVersion(await current(), version.id, { decision: "approve" })).rejects.toMatchObject({ status: 403 });
    expect((await repository.getVersion(other, version.id))?.status).toBe("pending_review");
  });

  it("does not approve rights withdrawn after the service preflight", async () => {
    const id = await asset(), task = await newTask(), original = repository.reviewVersion.bind(repository);
    const version = await service.uploadVersion(base, task.id, { files: [{ assetId: id, role: "production" }] });
    vi.spyOn(repository, "reviewVersion").mockImplementationOnce(async (...args) => {
      await withTenant(database.db, base, tx => tx.update(assetFiles).set({ rightsStatus: "rejected" }).where(eq(assetFiles.id, id)));
      return original(...args);
    });
    await expect(service.reviewVersion(base, version.id, { decision: "approve" })).rejects.toThrow();
    expect((await repository.getVersion(base, version.id))?.status).toBe("pending_review");
  });

  it("rejects a second direct review instead of returning an unchanged approved version as success", async () => {
    const { version } = await newVersion(); await service.reviewVersion(base, version.id, { decision: "approve" });
    await expect(repository.reviewVersion(base, version.id, { decision: "reject", rejectionReason: "A stale review" })).rejects.toMatchObject({ status: 409 });
    expect((await repository.getVersion(base, version.id))?.status).toBe("approved");
  });

  it("does not attach another task's approved version as primary", async () => {
    const { version } = await newVersion(); await service.reviewVersion(base, version.id, { decision: "approve" });
    const target = await newTask();
    await expect(repository.setPrimaryVersion(base, target.id, version.id)).rejects.toMatchObject({ status: 409 });
    expect((await repository.getTask(base, target.id))?.primaryVersionId).toBeUndefined();
  });

  it("does not select a pending version as primary through the repository", async () => {
    const { task, version } = await newVersion();
    await expect(repository.setPrimaryVersion(base, task.id, version.id)).rejects.toMatchObject({ status: 409 });
    expect((await repository.getTask(base, task.id))?.primaryVersionId).toBeUndefined();
  });

  it("keeps native Canvas production tied to its reviewed design, SKU, print specification and current permission", async () => {
    const source = await creative(), target = await sku(base);
    await pod.reviewCreativeVersion(base, source.versionId, { decision: "approve" });
    await withTenant(database.db, base, tx => tx.update(skus).set({ attributes: { canvas_print_spec_version_id: source.specId } }).where(eq(skus.id, target)));
    const [binding] = await service.promoteApprovedCreativeBindings(base, source.versionId, { bindings: [{ skuId: target, printSpecVersionId: source.specId }] });
    const [product] = await withTenant(database.db, base, tx => tx.select().from(skus).where(eq(skus.id, target)));
    const input = { designVersionId: binding!.designVersionId, skuId: target, spuId: product!.spuId, assetIds: [source.variant], canvasPrintSpecVersionId: source.specId };
    expect(await withTenant(database.db, base, tx => approvedDesignProductionSource(tx, base, input)))
      .toMatchObject({ designVersionId: binding!.designVersionId, skuId: target, assetIds: [source.variant] });
    await expect(withTenant(database.db, base, tx => approvedDesignProductionSource(tx, base, { ...input, canvasPrintSpecVersionId: null }))).rejects.toThrow("实际审核绑定");
    await expect(withTenant(database.db, base, tx => approvedDesignProductionSource(tx, base, { ...input, assetIds: [source.master] }))).rejects.toThrow("原审核设计");
    const personal = await current(); await grant(all.filter(permission => permission !== Permission.DesignRead));
    await expect(withTenant(database.db, personal, tx => approvedDesignProductionSource(tx, personal, input))).rejects.toMatchObject({ status: 403 });
  });

  it("checks the asset-promote permission's own scope", async () => {
    await grant([Permission.AssetPromote], "self"); await wide([Permission.AssetRead]);
    await expect(repository.approveAssetRights(await current(), otherAsset, { kind: "owned", reference: "Unrelated approval" })).rejects.toMatchObject({ status: 403 });
  });

  it("uses stored provenance instead of caller-supplied promotion metadata", async () => {
    const id = await asset(base, "research"), record = (await repository.getAsset(base, id))!;
    const copier = vi.spyOn(storage, "promoteToAuthorized");
    await expect(repository.promoteAsset(base, { ...record, rightsSource: { kind: "owned", reference: "Forged ownership" } })).rejects.toBeInstanceOf(ResearchAssetPromotionError);
    expect(copier).not.toHaveBeenCalled();
  });

  it("does not sign a caller-substituted object under an existing asset ID", async () => {
    const own = (await repository.getAsset(base, ownAsset))!, another = (await repository.getAsset(base, otherAsset))!;
    const signer = vi.spyOn(storage, "signRead");
    await expect(repository.signAsset(base, { ...own, objectKey: another.objectKey })).rejects.toMatchObject({ status: 409 });
    expect(signer).not.toHaveBeenCalled();
  });

  it("does not return a version URL after its task read permission is revoked during signing", async () => {
    const { version } = await newVersion(), context = await current(), original = storage.signRead.bind(storage);
    vi.spyOn(storage, "signRead").mockImplementationOnce(async (...args) => { const url = await original(...args); await grant(all.filter(p => p !== Permission.DesignRead)); return url; });
    await expect(service.signVersionFile(context, version.id, version.files[0]!.id)).rejects.toMatchObject({ status: 403 });
  });

  it("does not return a URL after rights are withdrawn during signing", async () => {
    const id = await asset(), task = await newTask(), original = storage.signRead.bind(storage);
    const version = await service.uploadVersion(base, task.id, { files: [{ assetId: id, role: "production" }] });
    vi.spyOn(storage, "signRead").mockImplementationOnce(async (...args) => { const url = await original(...args); await withTenant(database.db, base, tx => tx.update(assetFiles).set({ rightsStatus: "rejected" }).where(eq(assetFiles.id, id))); return url; });
    await expect(service.signVersionFile(base, version.id, version.files[0]!.id)).rejects.toThrow();
  });

  it("serializes concurrent version numbers while retaining immutable prior versions", async () => {
    const task = await newTask(), input = { files: [{ assetId: ownAsset, role: "production" as const }] };
    const result = await Promise.all([repository.createVersion(base, task.id, input), repository.createVersion(base, task.id, input)]);
    expect(result.map(v => v.versionNumber).sort()).toEqual([1, 2]);
    expect(result[0]!.id).not.toBe(result[1]!.id);
  });

  it("keeps the original self-write ceiling after the current role is widened", async () => {
    await grant([Permission.DesignWrite], "self"); await wide([Permission.DesignRead, Permission.AssetRead]);
    const context = await current(); await grant();
    const before = (await versions(otherTask)).length;
    await expect(repository.createVersion(context, otherTask, { files: [{ assetId: ownAsset, role: "production" }] })).rejects.toMatchObject({ status: 403 });
    expect(await versions(otherTask)).toHaveLength(before);
  });

  it("hides an order-private parent task when one PII permission has insufficient scope", async () => {
    const task = await newTask(), id = await asset(base, "order");
    const version = await repository.createVersion(base, task.id, { files: [{ assetId: id, role: "effect" }] });
    expect((await repository.getVersion(base, version.id))?.files[0]!.asset.id).toBe(id);
    await grant([Permission.DesignRead, Permission.AssetRead, Permission.OrderRead]); await wide([Permission.OrderPiiRead], "self");
    const context = await current();
    expect((await repository.listTasks(context)).some(t => t.id === task.id)).toBe(false);
    await expect(repository.getTask(context, task.id)).rejects.toMatchObject({ status: 403 });
    await expect(repository.getVersion(context, version.id)).rejects.toMatchObject({ status: 403 });
  });

  it("retains a minimum self-scoped reviewer without granting design-write authority", async () => {
    const { task, version } = await newVersion();
    await grant([Permission.DesignRead, Permission.DesignReview, Permission.AssetRead], "self");
    const context = await current(); expect(context.permissions).not.toContain(Permission.DesignWrite);
    await expect(service.reviewVersion(context, version.id, { decision: "approve" })).resolves.toMatchObject({ status: "approved" });
    await expect(service.setPrimaryVersion(context, task.id, version.id)).resolves.toMatchObject({ primaryVersionId: version.id });
  });

  it("preserves soft-deleted file provenance without issuing a new private URL", async () => {
    const task = await newTask(), id = await asset();
    const version = await service.uploadVersion(base, task.id, { files: [{ assetId: id, role: "production" }] });
    await withTenant(database.db, base, tx => tx.update(assetFiles).set({ deletedAt: new Date() }).where(eq(assetFiles.id, id)));
    const history = await repository.getVersion(base, version.id);
    expect(history?.files[0]!.asset).toMatchObject({ id, sha256: version.files[0]!.asset.sha256, rightsApprovedAt: undefined });
    const signer = vi.spyOn(storage, "signRead");
    await expect(service.signVersionFile(base, version.id, version.files[0]!.id)).rejects.toThrow();
    expect(signer).not.toHaveBeenCalled();
  });

  it("cannot relabel competitor provenance or promote customer-private originals", async () => {
    const research = await asset(base, "research"), order = await asset(base, "order");
    await expect(repository.approveAssetRights(base, research, { kind: "owned", reference: "A changed claim" })).rejects.toMatchObject({ status: 409 });
    expect((await repository.getAsset(base, research))?.rightsSource?.kind).toBe("competitor");
    const copier = vi.spyOn(storage, "promoteToAuthorized");
    await expect(repository.promoteAsset(base, (await repository.getAsset(base, order))!)).rejects.toThrow();
    expect(copier).not.toHaveBeenCalled();
  });

  it("uses the database clock to reject expired rights even if the process clock is behind", async () => {
    const id = await asset(), task = await newTask();
    const [clock] = await database.client.unsafe("select clock_timestamp() as now");
    const expiredAt = new Date(new Date(clock!.now).getTime() - 60_000).toISOString();
    await withTenant(database.db, base, tx => tx.update(assetFiles).set({ rightsMetadata: {
      source: { kind: "licensed", reference: "Synthetic expired license", licenseExpiresAt: expiredAt }, approvedAt: new Date().toISOString(),
    } }).where(eq(assetFiles.id, id)));
    vi.spyOn(Date, "now").mockReturnValue(new Date(expiredAt).getTime() - 86_400_000);
    await expect(repository.createVersion(base, task.id, { files: [{ assetId: id, role: "production" }] })).rejects.toThrow();
    expect(await versions(task.id)).toHaveLength(0);
  });

  it("records a real creative approval before native SKU promotion and signed delivery", async () => {
    const source = await creative(), target = await sku(base);
    await withTenant(database.db, base, tx => tx.update(skus).set({ attributes: { canvas_print_spec_version_id: source.specId } }).where(eq(skus.id, target)));
    expect((await repository.getAsset(base, source.variant))?.rightsApprovedAt).toBeUndefined();
    const approved = await pod.reviewCreativeVersion(base, source.versionId, { decision: "approve" });
    const file = (await repository.getAsset(base, source.variant))!;
    expect(file.rightsApprovedAt?.toISOString()).toBe(approved.reviewedAt?.toISOString());
    expect(file.rightsSource?.reference).toBe(`creative-review:${source.versionId}`);
    const [binding] = await service.promoteApprovedCreativeBindings(base, source.versionId, { bindings: [{ skuId: target, printSpecVersionId: source.specId }] });
    const version = (await repository.getVersion(base, binding!.designVersionId))!;
    expect(version.status).toBe("approved");
    const download = await service.signVersionFile(base, version.id, version.files[0]!.id);
    expect(Buffer.from(await (await fetch(download.url)).arrayBuffer())).toEqual(png);
  });

  it("checks current creative-read scope against the actual version creator", async () => {
    const source = await creative(other);
    await grant([Permission.DesignRead], "self"); await wide([Permission.AssetRead]);
    await expect(pod.getCreativeVersion(await current(), source.versionId)).rejects.toMatchObject({ status: 403 });
  });

  it("does not borrow wide creative-read scope for a self-scoped review", async () => {
    const source = await creative(other);
    await grant([Permission.DesignReview], "self"); await wide([Permission.DesignRead, Permission.AssetRead]);
    await expect(pod.reviewCreativeVersion(await current(), source.versionId, { decision: "approve" })).rejects.toMatchObject({ status: 403 });
    expect((await pod.getCreativeVersion(other, source.versionId)).status).toBe("pending_review");
  });

  it("checks each creative file's read scope before approving any file", async () => {
    const source = await creative(other);
    await grant([Permission.AssetRead], "self"); await wide([Permission.DesignRead, Permission.DesignReview]);
    await expect(pod.reviewCreativeVersion(await current(), source.versionId, { decision: "approve" })).rejects.toMatchObject({ status: 403 });
    expect((await pod.getCreativeVersion(other, source.versionId)).status).toBe("pending_review");
    expect((await repository.getAsset(other, source.variant))?.rightsApprovedAt).toBeUndefined();
  });

  it("rechecks revoked membership for an existing creative version", async () => {
    const source = await creative(), context = await current(); await grant([]);
    await expect(pod.getCreativeVersion(context, source.versionId)).rejects.toMatchObject({ status: 403 });
  });

  it("does not turn an expired creative license into current approval", async () => {
    const source = await creative();
    await withTenant(database.db, base, tx => tx.update(assetFiles).set({ rightsMetadata: { source: { kind: "licensed", reference: "Synthetic expired permission", licenseExpiresAt: "2000-01-01T00:00:00.000Z" } } }).where(eq(assetFiles.id, source.variant)));
    await expect(pod.reviewCreativeVersion(base, source.versionId, { decision: "approve" })).rejects.toMatchObject({ status: 409 });
    expect((await pod.getCreativeVersion(base, source.versionId)).status).toBe("pending_review");
    expect((await repository.getAsset(base, source.master))?.rightsApprovedAt).toBeUndefined();
  });

  it("checks the source creator's write scope before native SKU binding", async () => {
    const source = await creative(other), target = await sku(base);
    await pod.reviewCreativeVersion(other, source.versionId, { decision: "approve" });
    await withTenant(database.db, base, tx => tx.update(skus).set({ attributes: { canvas_print_spec_version_id: source.specId } }).where(eq(skus.id, target)));
    await grant([Permission.DesignWrite], "self"); await wide([Permission.DesignRead, Permission.DesignReview, Permission.AssetRead, Permission.ProductRead]);
    await expect(repository.promoteApprovedCreativeBindings(await current(), source.versionId, { bindings: [{ skuId: target, printSpecVersionId: source.specId }] })).rejects.toMatchObject({ status: 403 });
    const bindings = await withTenant(database.db, base, tx => tx.select().from(creativeDesignSkuBindings).where(eq(creativeDesignSkuBindings.creativeDesignVersionId, source.versionId)));
    expect(bindings).toHaveLength(0);
  });

  it("does not replay a prior SKU binding after its current source permission is revoked", async () => {
    const source = await creative(), target = await sku(base);
    await pod.reviewCreativeVersion(base, source.versionId, { decision: "approve" });
    await withTenant(database.db, base, tx => tx.update(skus).set({ attributes: { canvas_print_spec_version_id: source.specId } }).where(eq(skus.id, target)));
    const input = { bindings: [{ skuId: target, printSpecVersionId: source.specId }] };
    const original = await service.promoteApprovedCreativeBindings(base, source.versionId, input), context = await current();
    await grant(all.filter(p => p !== Permission.ProductRead));
    await expect(repository.promoteApprovedCreativeBindings(context, source.versionId, input)).rejects.toMatchObject({ status: 403 });
    const rows = await withTenant(database.db, base, tx => tx.select().from(creativeDesignSkuBindings).where(eq(creativeDesignSkuBindings.creativeDesignVersionId, source.versionId)));
    expect(rows.map(row => row.id)).toEqual(original.map(row => row.id));
  });
});
