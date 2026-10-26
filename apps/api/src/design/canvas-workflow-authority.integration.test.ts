import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { CreateCreativeDesignBatchInputSchema, createEntityId, type TenantContext } from "@yummyai/contracts";
import { CANVAS_BRIDGE } from "@yummyai/contracts/pod/canvas-bridge";
import { StudioGenerateRequestSchema, StudioGenerateSchema } from "@yummyai/contracts/pod/creative-studio";
import { StudioPaidImageInputSchema } from "@yummyai/contracts/pod/studio-paid-image";
import type { StudioModel } from "@yummyai/contracts/pod/studio-personal";
import { assetFiles, canvasPrintSpecVersions, connectDatabase, creativeDesignBatches, creativeDesignBatchItems, creativeDesignCandidates, creativeStudioEntries, creativeStudioGenerations, loadCurrentMembershipContext, migrateDatabase, roles, withTenant } from "@yummyai/database";
import { createStorageFromEnvironment } from "@yummyai/storage";
import { eq, inArray, sql } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditService } from "../audit/audit.service.js";
import { ModelConfigurationService } from "../ai/model-configuration.service.js";
import { CanvasBridgeService } from "./canvas-bridge.service.js";
import { CreativeStudioService } from "./creative-studio.service.js";
import { DesignService, DrizzleDesignRepository } from "./design.service.js";
import { PodBatchWorkflowService } from "./pod-batch-workflow.service.js";
import { StudioGenerationService } from "./studio-generation.service.js";
import { StudioPaidImageService } from "./studio-paid-image.service.js";

if (process.env.E2E_ISOLATED_DAILY !== "1" || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname) || !/^order-daily-e2e-[a-f0-9]{32}$/.test(process.env.S3_PRIVATE_BUCKET ?? ""))
  throw new Error("Run canvas workflow authority through the disposable acceptance runner");

describe("canvas workflow authority with real tenant storage", () => {
  const database = connectDatabase(), storage = createStorageFromEnvironment(), audit = new AuditService(database);
  const tenantId = createEntityId(), userId = createEntityId(), otherUser = createEntityId();
  const roleId = createEntityId(), wideRoleId = createEntityId(), membershipId = createEntityId();
  const all = Object.values(Permission), base: TenantContext = { tenantId, userId, permissions: all, dataScope: "tenant" }, other = { ...base, userId: otherUser };
  const enqueue = { enqueueCreativeCandidate: vi.fn(async () => {}), enqueueCreativeAdaptation: vi.fn(async () => {}), enqueueTemplateCompile: vi.fn(async () => {}), enqueueMockupRender: vi.fn(async () => {}) };
  const pod = new PodBatchWorkflowService(database, enqueue, audit, new DesignService(new DrizzleDesignRepository(database, storage)));
  const scanner = { scan: vi.fn(async () => ({ result: "clean" as const, engine: "synthetic", signatureVersion: "fixture", scannedAt: new Date().toISOString() })) };
  const bridge = new CanvasBridgeService(database, storage, audit, pod, scanner);
  const generations = { models: vi.fn(async () => []), create: vi.fn(async () => { throw new Error("No model calls in authority acceptance"); }) };
  const studio = new CreativeStudioService(database, storage, scanner, bridge, audit, generations as unknown as StudioGenerationService);
  const generationQueue = { enqueue: vi.fn(async () => {}) };
  const realGenerations = new StudioGenerationService(database, storage, generationQueue, bridge);
  const configuration = new ModelConfigurationService(database, new SecretVault(randomBytes(32)));
  let imageModel: StudioModel;
  let png: Buffer, ownAsset: string, otherAsset: string, ownSpec: string, otherSpec: string, ownProject: string, otherProject: string;
  const current = () => withTenant(database.db, base, tx => loadCurrentMembershipContext(tx, base));
  async function grant(permissions: readonly string[] = all, dataScope: "tenant" | "team" | "self" = "tenant") {
    await withTenant(database.db, base, tx => tx.update(roles).set({ permissions, dataScope }).where(eq(roles.id, roleId)));
  }
  async function wide(permissions: readonly string[] = [Permission.WorkflowRead]) {
    await withTenant(database.db, base, tx => tx.update(roles).set({ permissions, dataScope: "tenant" }).where(eq(roles.id, wideRoleId)));
  }
  async function asset(context: TenantContext) {
    const id = createEntityId(), stored = await storage.putPrivate(context, { body: png, domain: "authorized", fileName: `${id}.png`, mediaType: "image/png" });
    await withTenant(database.db, context, tx => tx.insert(assetFiles).values({ id, tenantId, ownerUserId: context.userId, objectKey: stored.objectKey, assetDomain: "authorized", fileName: `${id}.png`, mediaType: "image/png", byteSize: png.length, checksumSha256: stored.checksumSha256, rightsStatus: "approved", rightsMetadata: { source: { kind: "owned", reference: "Synthetic original" }, approvedAt: new Date().toISOString() } }));
    return id;
  }
  const brief = (referenceAssetIds = [ownAsset]) => ({ requestId: randomUUID(), name: `Synthetic ${createEntityId()}`, prompt: "Synthetic geometry", referenceAssetIds });
  const result = () => ({ submissionId: randomUUID(), protocolVersion: 1, pluginVersion: CANVAS_BRIDGE.pluginVersion, upstreamVersion: CANVAS_BRIDGE.upstreamVersion, sourceNodeId: "synthetic-node", title: "Synthetic result", contentBase64: png.toString("base64"), rightsAttested: true, sourceKind: "owned", sourceReference: "Synthetic original" });
  const spec = () => ({ name: `Synthetic ${createEntityId()}`, aspectWidth: 4, aspectHeight: 3, targetDpi: 300, bleedMm: 1, safeZoneMm: 1, wrapMode: "none" as const, physicalSizes: [{ key: "40x30", label: "Synthetic", widthMm: 40, heightMm: 30 }] });
  const batch = (specId = ownSpec, assetId = ownAsset, name = `Synthetic ${createEntityId()}`) => CreateCreativeDesignBatchInputSchema.parse({ name, items: [{ rowKey: "one", name: "Synthetic", prompt: "Synthetic geometry", referenceAssetIds: [assetId], printSpecVersionIds: [specId], candidateCount: 1, focalPoint: { xPermille: 500, yPermille: 500 } }] });
  const invoke = (context: TenantContext, input: Record<string, unknown>) => studio.invoke(context, { scope: "unassigned", ...input });
  const generationInput = () => StudioGenerateSchema.parse({ requestId: randomUUID(), modelId: createEntityId(), prompt: "Synthetic authority input" });
  async function completedGeneration(referenceAsset = ownAsset) {
    const id = createEntityId(), [file] = await withTenant(database.db, base, tx => tx.select().from(assetFiles).where(eq(assetFiles.id, referenceAsset)));
    await withTenant(database.db, base, tx => tx.insert(creativeStudioGenerations).values({ id, tenantId, ownerId: userId, scope: "unassigned", requestId: randomUUID(), input: generationInput(), modelSnapshot: { providerConfigId: createEntityId(), model: "synthetic-no-model-call", capability: "image" }, references: [{ assetId: referenceAsset, version: file!.version, checksum: file!.checksumSha256 }], status: "completed", assetId: ownAsset }));
    return id;
  }
  async function seedLegacyBatch(prototypeId: string, requestChecksum: string, name: string) {
    return withTenant(database.db, base, async tx => {
      const [prototype] = await tx.select().from(creativeDesignBatches).where(eq(creativeDesignBatches.id, prototypeId));
      const id = createEntityId();
      await tx.insert(creativeDesignBatches).values({ ...prototype!, id, requestChecksum, name,
        canvasWorkflow: prototype!.canvasWorkflow ? { ...prototype!.canvasWorkflow, rootBatchId: id } : null });
      const items = await tx.select().from(creativeDesignBatchItems).where(eq(creativeDesignBatchItems.batchId, prototypeId));
      const candidates = await tx.select().from(creativeDesignCandidates).where(inArray(creativeDesignCandidates.itemId, items.map(item => item.id)));
      for (const item of items) {
        const itemId = createEntityId(); await tx.insert(creativeDesignBatchItems).values({ ...item, id: itemId, batchId: id });
        for (const candidate of candidates.filter(candidate => candidate.itemId === item.id))
          await tx.insert(creativeDesignCandidates).values({ ...candidate, id: createEntityId(), itemId });
      }
      return id;
    });
  }
  beforeAll(async () => {
    vi.stubEnv("POD_BATCH_WORKFLOWS_ENABLED", "true"); vi.stubEnv("POD_PROCESSOR_DEPLOYMENT_ID", "synthetic"); vi.stubEnv("POD_PROCESSOR_URL", "http://127.0.0.1:9"); vi.stubEnv("POD_PROCESSOR_API_KEY", "synthetic-not-a-secret"); vi.stubEnv("POD_ENABLED_TOOLS", "text_to_image,canvas_extend");
    await migrateDatabase(database); await storage.ensureBucket();
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Canvas workflow authority',$2)", [tenantId, `canvas-workflow-${tenantId}`]);
    for (const id of [userId, otherUser]) await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic workspace member')", [id, `workflow-${id}`, `${id}@example.test`]);
    await database.client.unsafe("insert into memberships(id,tenant_id,user_id,status) values($1,$2,$3,'active')", [membershipId, tenantId, userId]);
    for (const [id, name, permissions] of [[roleId, "Workspace operator", all], [wideRoleId, "Unrelated wide grant", [Permission.WorkflowRead]]] as const) {
      await database.client.unsafe("insert into roles(id,tenant_id,name,permissions,data_scope) values($1,$2,$3,$4::jsonb,'tenant')", [id, tenantId, name, JSON.stringify(permissions)]);
      await database.client.unsafe("insert into membership_roles(tenant_id,membership_id,role_id) values($1,$2,$3)", [tenantId, membershipId, id]);
    }
    png = await sharp({ create: { width: 64, height: 48, channels: 4, background: "#2563eb" } }).png().toBuffer();
    ownAsset = await asset(base); otherAsset = await asset(other);
    const a = await pod.createPrintSpec(base, spec()), b = await pod.createPrintSpec(other, spec());
    ownSpec = a.id; otherSpec = b.id;
    await pod.reviewPrintSpec(base, ownSpec, { decision: "approve" }); await pod.reviewPrintSpec(other, otherSpec, { decision: "approve" });
    ownProject = (await bridge.create(base, brief())).id; otherProject = (await bridge.create(other, brief([otherAsset]))).id;
    await configuration.invoke(base, { operation: "channel.save", name: "Synthetic authority channel", baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "synthetic-authority-only", models: [{ name: "synthetic-authority-image", capability: "image" }] });
    const selected = (await realGenerations.models(base)).find(model => model.capability === "image");
    if (!selected) throw new Error("Synthetic authority image model was not configured");
    imageModel = selected;
  });
  beforeEach(async () => { vi.restoreAllMocks(); vi.clearAllMocks(); await grant(); await wide(); });
  afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await database.client.end(); });

  it.each(["self", "team"] as const)("keeps %s project lists and summaries within the design scope", async scope => {
    await grant([Permission.DesignRead, Permission.AssetRead], scope);
    const context = await current(); expect(context.dataScope).toBe("tenant");
    for (const rows of [await bridge.list(context), await bridge.projectSummaries(context), await pod.listDesignBatches(context)]) {
      expect(rows.some(row => row.id === ownProject)).toBe(true); expect(rows.some(row => row.id === otherProject)).toBe(false);
    }
    await expect(bridge.get(context, otherProject)).rejects.toMatchObject({ status: 403 });
    await expect(pod.getDesignBatch(context, otherProject)).rejects.toMatchObject({ status: 403 });
  });

  it("filters print specifications by their own design-read authority", async () => {
    await grant([Permission.DesignRead], "self");
    const rows = await pod.listPrintSpecs(await current());
    expect(rows.some(row => row.id === ownSpec)).toBe(true); expect(rows.some(row => row.id === otherSpec)).toBe(false);
  });

  it("filters reference options by asset-read scope independently of design-read", async () => {
    await grant([Permission.AssetRead], "self"); await wide([Permission.DesignRead]);
    const options = await pod.designOptions(await current());
    expect(options.referenceAssets.some(row => row.id === ownAsset)).toBe(true);
    expect(options.referenceAssets.some(row => row.id === otherAsset)).toBe(false);
    expect(options.skus).toEqual([]);
  });

  it("rejects another owner's reference before creating a canvas brief", async () => {
    await grant([Permission.AssetRead], "self"); await wide([Permission.DesignRead, Permission.DesignWrite]);
    const input = brief([otherAsset]);
    await expect(bridge.create(await current(), input)).rejects.toMatchObject({ status: 403 });
    const rows = await withTenant(database.db, base, tx => tx.select().from(creativeDesignBatches).where(eq(creativeDesignBatches.name, input.name)));
    expect(rows).toHaveLength(0);
  });

  it("rechecks existing brief reference scope rather than trusting its earlier save", async () => {
    const created = await bridge.create(base, brief([otherAsset]));
    await grant([Permission.AssetRead], "self"); await wide([Permission.DesignRead]);
    await expect(bridge.get(await current(), created.id)).rejects.toMatchObject({ status: 403 });
  });

  it("rejects revoked membership for projects and the unassigned workspace", async () => {
    const context = await current(); await grant([]);
    await expect(bridge.get(context, ownProject)).rejects.toMatchObject({ status: 403 });
    await expect(invoke(context, { operation: "state.keys", namespace: "app_state" })).rejects.toMatchObject({ status: 403 });
    await expect(invoke(context, { operation: "models" })).rejects.toMatchObject({ status: 403 });
    expect(generations.models).not.toHaveBeenCalled();
  });

  it("does not borrow wide read scope for another creator's brief revision", async () => {
    await grant([Permission.DesignWrite], "self"); await wide([Permission.DesignRead, Permission.AssetRead]);
    await expect(bridge.revise(await current(), otherProject, { ...brief([otherAsset]), expectedRevision: 1, changeNote: "Forbidden revision" })).rejects.toMatchObject({ status: 403 });
    expect((await bridge.get(other, otherProject)).projectRevision).toBe(1);
  });

  it("checks the project write scope before saving a member's draft in that project", async () => {
    await grant([Permission.DesignWrite], "self"); await wide([Permission.DesignRead, Permission.AssetRead]);
    await expect(invoke(await current(), { scope: otherProject, operation: "state.set", namespace: "app_state", key: "studio:prompts", revision: 0, value: "Forbidden draft" })).rejects.toMatchObject({ status: 403 });
  });

  it("checks current write authority before scanning or storing workspace media", async () => {
    const context = await current(); await grant([Permission.DesignRead, Permission.AssetRead]);
    const writer = vi.spyOn(storage, "putPrivate");
    await expect(invoke(context, { operation: "state.set", namespace: "image_files", key: "forbidden-media", revision: 0, media: { contentBase64: png.toString("base64"), mediaType: "image/png" } })).rejects.toMatchObject({ status: 403 });
    expect(scanner.scan).not.toHaveBeenCalled(); expect(writer).not.toHaveBeenCalled();
  });

  it("does not associate workspace media after revocation during storage", async () => {
    const context = await current(), original = storage.putPrivate.bind(storage);
    const fresh = await sharp({ create: { width: 67, height: 51, channels: 4, background: "#f7f7f7" } }).png().toBuffer();
    const writer = vi.spyOn(storage, "putPrivate").mockImplementationOnce(async (...args) => { const stored = await original(...args); await grant([]); return stored; });
    await expect(invoke(context, { operation: "state.set", namespace: "image_files", key: "revoked-during-put", revision: 0, media: { contentBase64: fresh.toString("base64"), mediaType: "image/png" } })).rejects.toMatchObject({ status: 403 });
    expect(writer).toHaveBeenCalledTimes(1);
    const rows = await withTenant(database.db, base, tx => tx.select().from(creativeStudioEntries).where(eq(creativeStudioEntries.key, "revoked-during-put")));
    expect(rows).toHaveLength(0);
  });

  it("does not return canvas bytes after the actor loses access during storage read", async () => {
    const context = await current(), original = storage.readPrivate.bind(storage);
    vi.spyOn(storage, "readPrivate").mockImplementationOnce(async (...args) => { const bytes = await original(...args); await grant([]); return bytes; });
    await expect(bridge.readReference(context, ownProject, ownAsset)).rejects.toMatchObject({ status: 403 });
  });

  it("does not return workspace previews after in-flight revocation", async () => {
    await invoke(base, { operation: "reference.attach", assetId: ownAsset });
    const context = await current(), original = storage.readPrivate.bind(storage);
    vi.spyOn(storage, "readPrivate").mockImplementationOnce(async (...args) => { const bytes = await original(...args); await grant([]); return bytes; });
    await expect(invoke(context, { operation: "asset.preview", namespace: "image_files", key: `image:asset-${ownAsset}` })).rejects.toMatchObject({ status: 403 });
  });

  it("does not return workspace file content after in-flight revocation", async () => {
    await invoke(base, { operation: "reference.attach", assetId: ownAsset });
    const context = await current(), original = storage.readPrivate.bind(storage);
    vi.spyOn(storage, "readPrivate").mockImplementationOnce(async (...args) => { const bytes = await original(...args); await grant([]); return bytes; });
    await expect(invoke(context, { operation: "state.get", namespace: "image_files", key: `image:asset-${ownAsset}` })).rejects.toMatchObject({ status: 403 });
  });

  it("does not return existing canvas submission receipts after current write revocation", async () => {
    const project = await bridge.create(base, brief()), input = result();
    const receipt = await bridge.submit(base, project.id, input), context = await current();
    await grant([Permission.DesignRead, Permission.AssetRead]);
    await expect(bridge.submit(context, project.id, input)).rejects.toMatchObject({ status: 403 });
    expect((await pod.getCreativeVersion(base, receipt.versionId)).status).toBe("pending_review");
  });

  it("does not associate a canvas result after revocation during storage", async () => {
    const project = await bridge.create(base, brief()), context = await current(), original = storage.putPrivate.bind(storage);
    vi.spyOn(storage, "putPrivate").mockImplementationOnce(async (...args) => { const stored = await original(...args); await grant([]); return stored; });
    await expect(bridge.submit(context, project.id, result())).rejects.toMatchObject({ status: 403 });
    expect((await bridge.get(base, project.id)).resultCount).toBe(0);
  });

  it("does not append a print-specification version without its source write scope", async () => {
    const [source] = await withTenant(database.db, base, tx => tx.select().from(canvasPrintSpecVersions).where(eq(canvasPrintSpecVersions.id, otherSpec)));
    await grant([Permission.DesignWrite], "self"); await wide([Permission.DesignRead]);
    await expect(pod.createPrintSpec(await current(), { ...spec(), specId: source!.specId })).rejects.toMatchObject({ status: 403 });
  });

  it("does not review another creator's print specification with self-only review authority", async () => {
    const source = await pod.createPrintSpec(other, spec());
    await grant([Permission.DesignReview], "self"); await wide([Permission.DesignRead]);
    await expect(pod.reviewPrintSpec(await current(), source.id, { decision: "approve" })).rejects.toMatchObject({ status: 403 });
    const [row] = await withTenant(database.db, base, tx => tx.select().from(canvasPrintSpecVersions).where(eq(canvasPrintSpecVersions.id, source.id)));
    expect(row!.status).toBe("draft");
  });

  it("does not create or dispatch a batch with inaccessible reference files", async () => {
    await grant([Permission.AssetRead], "self"); await wide([Permission.DesignRead, Permission.DesignWrite]);
    await expect(pod.createDesignBatch(await current(), batch(ownSpec, otherAsset))).rejects.toMatchObject({ status: 403 });
    expect(enqueue.enqueueCreativeCandidate).not.toHaveBeenCalled();
  });

  it("separates otherwise identical batch requests by the real applicant", async () => {
    const input = batch();
    const a = await pod.createDesignBatch(base, input), b = await pod.createDesignBatch(other, input);
    expect(a.id).not.toBe(b.id); expect(a.createdBy).toBe(userId); expect(b.createdBy).toBe(otherUser);
    expect((await pod.createDesignBatch(base, input)).id).toBe(a.id);
  });

  it("checks batch write scope before cancellation and leaves the original status unchanged", async () => {
    const source = await pod.createDesignBatch(other, batch(otherSpec, otherAsset));
    await grant([Permission.DesignWrite], "self"); await wide([Permission.DesignRead, Permission.AssetRead]);
    await expect(pod.cancelDesignBatch(await current(), source.id)).rejects.toMatchObject({ status: 403 });
    expect((await pod.getDesignBatch(other, source.id)).status).toBe("queued");
  });

  it("retains the original specification owner across collaborative versions", async () => {
    const original = await pod.createPrintSpec(base, spec());
    const collaborative = await pod.createPrintSpec(other, { ...spec(), specId: original.specId });
    await grant([Permission.DesignRead, Permission.DesignWrite], "self");
    expect((await pod.listPrintSpecs(await current())).some(row => row.id === collaborative.id)).toBe(true);
    expect((await pod.createPrintSpec(await current(), { ...spec(), specId: original.specId })).versionNumber).toBe(3);
    await expect(pod.createPrintSpec({ ...other, permissions: [Permission.DesignRead, Permission.DesignWrite], dataScope: "self" }, { ...spec(), specId: original.specId })).rejects.toMatchObject({ status: 403 });
  });

  it("preserves licensed provenance and records the real workspace rights approval", async () => {
    const id = await asset(base), key = `image:licensed-${id}`;
    await withTenant(database.db, base, async tx => {
      await tx.update(assetFiles).set({ rightsStatus: "unverified", rightsMetadata: { source: { kind: "licensed", reference: "Synthetic licence", licenseExpiresAt: "2099-01-01T00:00:00.000Z" } } }).where(eq(assetFiles.id, id));
      await tx.insert(creativeStudioEntries).values({ id: createEntityId(), tenantId, ownerId: userId, scope: "unassigned", namespace: "image_files", key, assetId: id });
    });
    await grant([Permission.DesignRead, Permission.DesignReview, Permission.AssetRead], "self");
    await invoke(await current(), { operation: "asset.review", key, decision: "approve", sourceReference: "Confirmed synthetic licence" });
    const [file] = await withTenant(database.db, base, tx => tx.select().from(assetFiles).where(eq(assetFiles.id, id)));
    expect(file!.rightsMetadata).toMatchObject({ source: { kind: "licensed", licenseExpiresAt: "2099-01-01T00:00:00.000Z" }, approvedBy: userId });
    expect(Number.isFinite(Date.parse(String(file!.rightsMetadata.approvedAt)))).toBe(true);
  });

  it("allows a current read-only member to restore their workspace media", async () => {
    const attached = await invoke(base, { operation: "reference.attach", assetId: ownAsset }) as { key: string };
    await grant([Permission.DesignRead, Permission.AssetRead], "self");
    expect(await invoke(await current(), { operation: "state.get", namespace: "image_files", key: attached.key })).toMatchObject({ media: { contentBase64: png.toString("base64") } });
  });

  it("rechecks write authority after scanning before any workspace storage", async () => {
    const context = await current(), writer = vi.spyOn(storage, "putPrivate");
    vi.spyOn(scanner, "scan").mockImplementationOnce(async () => { await grant([]); return { result: "clean", engine: "synthetic", signatureVersion: "fixture", scannedAt: new Date().toISOString() }; });
    await expect(invoke(context, { operation: "state.set", namespace: "image_files", key: "revoked-in-scan", revision: 0, media: { contentBase64: png.toString("base64"), mediaType: "image/png" } })).rejects.toMatchObject({ status: 403 });
    expect(writer).not.toHaveBeenCalled();
  });

  it("checks direct generation services against current membership and project write scope", async () => {
    const input = StudioGenerateRequestSchema.parse({ ...generationInput(), modelId: imageModel.id,
      capability: imageModel.capability, selectionRevision: imageModel.selectionRevision });
    const paidInput = StudioPaidImageInputSchema.parse(input), paid = new StudioPaidImageService(database, generationQueue, bridge);
    const persisted = () => withTenant(database.db, base, async tx => {
      const [identity] = await tx.execute<{ role: string }>(sql`select current_user as role`);
      expect(identity?.role).toBe("yummyai_app");
      const tables = await tx.execute<{ name: string }>(sql`select c.relname as name from pg_class c
        join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid
        where n.nspname='public' and c.relkind in ('r','p') and a.attname='tenant_id' and not a.attisdropped
          and has_table_privilege(current_user,c.oid,'SELECT') order by c.relname`);
      expect(tables.map(table => table.name)).toEqual(expect.arrayContaining([
        "creative_studio_image_requests", "creative_studio_generations", "creative_executions", "ai_budget_ledger", "asset_files", "roles",
      ]));
      const rows = [];
      for (const table of tables) {
        const [value] = await tx.execute<{ count: number; sha256: string }>(sql`select count(*)::int as count,
          encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex') as sha256
          from public.${sql.identifier(table.name)} t where t.tenant_id=${tenantId}`);
        expect(value).toBeDefined();
        rows.push({ table: table.name, ...value });
      }
      return rows;
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    const writes = vi.spyOn(storage, "putPrivate"), scans = vi.spyOn(scanner, "scan");
    const context = await current(); await grant([]);
    const revoked = await persisted();
    await expect(realGenerations.models(context)).rejects.toMatchObject({ status: 403 });
    await expect(realGenerations.list(context, "unassigned")).rejects.toMatchObject({ status: 403 });
    // The supported free prepare owner still checks current membership. The
    // retired create entry is uniformly paused before any authority or I/O.
    await expect(paid.prepare(context, { scope: "unassigned", input: paidInput })).rejects.toMatchObject({ status: 403 });
    await expect(realGenerations.create(context, "unassigned", input)).rejects.toMatchObject({ status: 409,
      response: { code: "studio_paid_execution_paused" } });
    expect(await persisted()).toEqual(revoked);
    await grant([Permission.DesignWrite, Permission.AssetWrite], "self"); await wide([Permission.DesignRead, Permission.AssetRead]);
    const scoped = await current(), before = await persisted();
    await expect(paid.prepare(scoped, { scope: otherProject, input: paidInput })).rejects.toMatchObject({ status: 403 });
    await expect(realGenerations.create(scoped, otherProject, input)).rejects.toMatchObject({ status: 409,
      response: { code: "studio_paid_execution_paused" } });
    expect(await persisted()).toEqual(before);
    expect(generationQueue.enqueue).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(scans).not.toHaveBeenCalled();
  });

  it("does not return generated bytes after revocation during their read", async () => {
    const id = await completedGeneration(), context = await current(), original = storage.readPrivate.bind(storage);
    const reader = vi.spyOn(storage, "readPrivate").mockImplementationOnce(async (...args) => { const bytes = await original(...args); await grant([]); return bytes; });
    await expect(realGenerations.get(context, "unassigned", id)).rejects.toMatchObject({ status: 403 });
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it("applies reference scope to original generation history and permits minimum read roles", async () => {
    const own = await completedGeneration(), inaccessible = await completedGeneration(otherAsset);
    await grant([Permission.AssetRead], "self"); await wide([Permission.DesignRead]);
    const context = await current();
    await expect(realGenerations.get(context, "unassigned", inaccessible)).rejects.toMatchObject({ status: 403 });
    expect((await realGenerations.list(context, "unassigned")).some(row => row.id === inaccessible)).toBe(false);
    expect(await realGenerations.get(context, "unassigned", own)).toMatchObject({ contentBase64: png.toString("base64") });
  });

  it("stops subsequent dispatches when authority is revoked after the first enqueue", async () => {
    const input = batch(); input.items[0]!.candidateCount = 2;
    const context = await current(); enqueue.enqueueCreativeCandidate.mockImplementationOnce(async () => { await grant([]); });
    await expect(pod.createDesignBatch(context, input)).rejects.toMatchObject({ status: 403 });
    expect(enqueue.enqueueCreativeCandidate).toHaveBeenCalledTimes(1);
  });

  it("does not retry uncertain processing failures and preserves their evidence", async () => {
    const source = await pod.createDesignBatch(base, batch()), item = source.items[0]!, candidate = item.candidates[0]!;
    await withTenant(database.db, base, async tx => {
      await tx.update(creativeDesignCandidates).set({ status: "failed", errorCode: "PROCESSING_FAILED", errorMessage: "Synthetic unknown submission", completedAt: new Date() }).where(eq(creativeDesignCandidates.id, candidate.id));
      await tx.update(creativeDesignBatchItems).set({ status: "failed", errorCode: "PROCESSING_FAILED", errorMessage: "Synthetic unknown submission", completedAt: new Date() }).where(eq(creativeDesignBatchItems.id, item.id));
    });
    enqueue.enqueueCreativeCandidate.mockClear();
    await expect(pod.retryDesignItem(base, source.id, item.id)).rejects.toMatchObject({ status: 409 });
    expect(enqueue.enqueueCreativeCandidate).not.toHaveBeenCalled();
    expect((await pod.getDesignBatch(base, source.id)).items[0]!.candidates[0]).toMatchObject({ status: "failed", errorCode: "PROCESSING_FAILED" });
  });

  it("replays a legacy brief for its original applicant while isolating another member", async () => {
    const input = brief(), prototype = await bridge.create(base, { ...input, requestId: randomUUID() });
    const legacy = createHash("sha256").update(JSON.stringify({ source: "infinite-canvas-brief-v1", requestId: input.requestId })).digest("hex");
    const id = await seedLegacyBatch(prototype.id, legacy, input.name);
    expect((await bridge.create(base, input)).id).toBe(id);
    expect((await bridge.create(other, input)).id).not.toBe(id);
    const [preserved] = await withTenant(database.db, base, tx => tx.select().from(creativeDesignBatches).where(eq(creativeDesignBatches.id, id)));
    expect(preserved!.requestChecksum).toBe(legacy);
  });

  it("replays an original legacy batch without transferring its applicant or rewriting history", async () => {
    const input = batch(), prototype = await pod.createDesignBatch(base, { ...input, name: `${input.name} prototype` });
    // Seed the historical v1 wire identity, which deliberately had no applicant/name.
    const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object"
      ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}` : JSON.stringify(value) ?? "null";
    const legacy = createHash("sha256").update(canonical({ policyVersion: "creative-design-batch-v1", recipeVersionId: null,
      items: input.items.map(item => ({ ...item, referenceAssets: [{ id: ownAsset, version: 1, checksumSha256: createHash("sha256").update(png).digest("hex") }], printSpecs: [{ id: ownSpec, versionNumber: 1 }] })),
    })).digest("hex");
    const id = await seedLegacyBatch(prototype.id, legacy, input.name);
    expect((await pod.createDesignBatch(base, input)).id).toBe(id);
    expect((await pod.createDesignBatch(other, input)).id).not.toBe(id);
    expect((await pod.getDesignBatch(base, id)).requestChecksum).toBe(legacy);
  });
});
