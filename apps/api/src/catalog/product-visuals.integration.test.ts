import { syntheticSpecificationFacts } from "../../../../tools/testing/specification-fixtures.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { SecretVault } from "@yummyai/ai-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { SalesPlanFieldsSchema, type SalesPlanView } from "@yummyai/contracts/catalog/sales-plan";
import type {
  ProductVisualProject,
  VisualSlotKey,
} from "@yummyai/contracts/catalog/product-visuals";
import { StudioGenerateRequestSchema, StudioGenerateSchema } from "@yummyai/contracts/pod/creative-studio";
import { admitCreativeExecution, stageCreativeExecution } from "@yummyai/pod-core";
import {
  assetFiles,
  aiBudgetLedger,
  aiBudgetPolicies,
  connectDatabase,
  creativeDesignBatches,
  creativeExecutions,
  creativeStudioGenerations,
  memberships,
  membershipRoles,
  modelProviderConfigs,
  modelRoutes,
  roles,
  withTenant,
} from "@yummyai/database";
import { createStorageFromEnvironment } from "@yummyai/storage";
import type { JobEnvelope } from "@yummyai/jobs";
import { createDefaultProductionDocument } from "@yummyai/production-editor/products";
import { eq, inArray, sql } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuditService } from "../audit/audit.service.js";
import { CanvasBridgeService } from "../design/canvas-bridge.service.js";
import { CanvasWorkflowService } from "../design/canvas-workflow.service.js";
import { CreativeStudioService } from "../design/creative-studio.service.js";
import { DesignService, DrizzleDesignRepository } from "../design/design.service.js";
import { PodBatchWorkflowService } from "../design/pod-batch-workflow.service.js";
import { ProductionEditorService } from "../design/production-editor.service.js";
import { StudioGenerationService } from "../design/studio-generation.service.js";
import { ListingService, DrizzleListingRepository } from "../listings/listing.service.js";
import type { AmazonOrderReportService } from "../orders/amazon-order-report.service.js";
import { OrderWorkspaceService } from "../orders/order-workspace.service.js";
import { StudioGenerationProcessor } from "../../../worker/src/processors/studio-generation.processor.js";
import { ProductDevelopmentService } from "./product-development.service.js";
import { ProductVisualsService } from "./product-visuals.service.js";
import { SalesPlanService } from "./sales-plan.service.js";

describe.sequential(
  "retained pillow visuals through canonical review and adoption with legacy generation paused",
  () => {
    const isolated = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
    if (
      process.env.E2E_ISOLATED_DAILY !== "1" ||
      !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(isolated.pathname)
    )
      throw new Error("Visual acceptance requires disposable resources");
    const db = connectDatabase(),
      storage = createStorageFromEnvironment(),
      vault = new SecretVault(Buffer.alloc(32, 79));
    const a: TenantContext = {
      tenantId: createEntityId(),
      userId: createEntityId(),
      permissions: Object.values(Permission),
      dataScope: "tenant",
    };
    const b = { ...a, tenantId: createEntityId(), userId: createEntityId() },
      other = { ...a, userId: b.userId };
    const audit = new AuditService(db),
      queue = { enqueue: vi.fn(async () => undefined) };
    const scan = vi.fn(async () => ({
      result: "clean" as const,
      engine: "synthetic",
      signatureVersion: "test-1",
      scannedAt: new Date().toISOString(),
    }));
    // Order-only reporting is deliberately unreachable in this catalog acceptance.
    const reports = {} as AmazonOrderReportService;
    const editor = new ProductionEditorService(
      db,
      vault,
      storage,
      reports,
      audit,
      { enqueue: vi.fn() },
      { scan },
    );
    const work = new OrderWorkspaceService(db, vault, storage, reports, editor, { scan });
    const creative = new PodBatchWorkflowService(
      db,
      {
        enqueueCreativeCandidate: vi.fn(),
        enqueueCreativeAdaptation: vi.fn(),
        enqueueTemplateCompile: vi.fn(),
        enqueueMockupRender: vi.fn(),
      },
      audit,
      new DesignService(new DrizzleDesignRepository(db, storage)),
    );
    const bridge = new CanvasBridgeService(db, storage, audit, creative, { scan }),
      workflow = new CanvasWorkflowService(db, storage, bridge, creative, editor, audit);
    const generation = new StudioGenerationService(db, storage, queue, bridge),
      studio = new CreativeStudioService(db, storage, { scan }, bridge, audit, generation);
    const catalog = new ProductDevelopmentService(db, storage),
      listing = new ListingService(new DrizzleListingRepository(db)),
      plans = new SalesPlanService(db, listing);
    const service = new ProductVisualsService(
      db,
      storage,
      plans,
      bridge,
      workflow,
      generation,
      studio,
      audit,
    );
    const checks = { identity: true, shape: true, facts: true, sides: true };
    const ids: Record<string, string[]> = { plans: [], groups: [], assets: [], generations: [] };
    if (!process.env.YUMMYAI_TEST_CACHE_DIR) throw new Error("Visual evidence requires the runner-owned artifact directory");
    const directory = pathToFileURL(resolve(process.env.YUMMYAI_TEST_CACHE_DIR, "product-visuals-logs") + sep);
    let modelId: string,
      providerId: string,
      sampleId: string,
      specId: string,
      spuId: string,
      templateId: string,
      roleId: string;
    let transparent: Buffer,
      opaque: Buffer,
      output: Buffer | undefined;
    const generate = vi.fn(async () => { throw new Error("synthetic-legacy-generation-must-not-dispatch"); });
    const processor = new StudioGenerationProcessor(db, storage, vault, { generate }, { scan });
    const envelope = (id: string): JobEnvelope => ({
      jobId: id,
      correlationId: id,
      idempotencyKey: id,
      traceId: "visual-test",
      tenantId: a.tenantId,
      requestedBy: a.userId,
      requestedAt: new Date().toISOString(),
      attempt: 0,
      maxAttempts: 1,
      payload: { generationId: id },
    });
    async function plan() {
      const result = await plans.create(a, {
        spuId,
        fields: SalesPlanFieldsSchema.parse({
          name: `Synthetic pillow ${randomUUID().slice(0, 8)}`,
          mode: "custom",
          fulfillment: "fbm",
          specificationIds: [specId],
          positioning: "Synthetic original geometric subject",
        }),
        idempotencyKey: randomUUID(),
      });
      ids.plans.push(result.plan.id);
      return result.plan;
    }
    const prepareInput = (p: SalesPlanView, totalBudgetUsd = 2) => ({
      requestId: randomUUID(),
      expectedRevision: p.revision,
      sampleAssetId: sampleId,
      sampleAttestation: "Synthetic owned sample, single printed front and white back",
      modelId,
      size: "1024x1024",
      direction: p.fields.positioning,
      callCeilingUsd: 0.1,
      totalBudgetUsd,
      budgetAttested: true,
    });
    async function prepared(p: SalesPlanView, total = 2) {
      const input = prepareInput(p, total),
        result = await service.prepare(a, p.id, input);
      ids.groups.push(result.groupId);
      return { input, group: result.groupId };
    }
    async function snapshot(p: SalesPlanView, group: string): Promise<ProductVisualProject> {
      return (await service.get(a, p.id)).projects.find((p) => p.id === group)!;
    }
    const command = (slotKey: VisualSlotKey, artworkVersionId?: string) => ({
      requestId: randomUUID(),
      modelId,
      slotKey,
      ...(artworkVersionId ? { artworkVersionId } : {}),
      size: "1024x1024",
    });
    const operation = (id: string) => ({ kind: "studio_generation" as const, ownerId: id, stepKey: "generate" });
    const historyRows = (id: string) => withTenant(db.db, a, async tx => ({
      generation: await tx.select().from(creativeStudioGenerations).where(eq(creativeStudioGenerations.id, id)),
      execution: await tx.select().from(creativeExecutions).where(eq(creativeExecutions.studioGenerationId, id)),
      ledger: await tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.requestId, id)),
    }));
    const originalAdmission = (id: string) => withTenant(db.db, a, tx => admitCreativeExecution(tx, a, operation(id)));
    async function dormant(id: string) {
      const before = await historyRows(id), calls = generate.mock.calls.length;
      const result = await processor.process(envelope(id));
      expect(result).toMatchObject({ id, disposition: expect.stringMatching(/^(operator_paused|legacy_not_admitted)$/) });
      expect(await historyRows(id)).toEqual(before); expect(generate).toHaveBeenCalledTimes(calls); expect(queue.enqueue).not.toHaveBeenCalled();
      return before;
    }
    async function retained(p: SalesPlanView, group: string, input: ReturnType<typeof command>, status: "queued" | "completed" = "queued") {
      const projects = await withTenant(db.db, a, tx => tx.select().from(creativeDesignBatches));
      const project = projects.find(row => row.createdBy === a.userId && row.canvasWorkflow?.visualDelivery?.groupId === group && row.canvasWorkflow.visualDelivery.slotKey === input.slotKey);
      if (!project?.canvasWorkflow?.visualDelivery) throw new Error("Synthetic retained visual project missing");
      const pin = project.canvasWorkflow.visualDelivery, selected = (await generation.models(a)).find(model => model.id === pin.modelId);
      if (!selected) throw new Error("Synthetic retained visual model missing");
      const artwork = input.artworkVersionId ? projects.find(row => row.canvasWorkflow?.visualDelivery?.groupId === group && row.canvasWorkflow.visualDelivery.slotKey === "artwork") : undefined;
      const art = artwork ? (await workflow.results(a, artwork.id)).items.find(row => row.versionId === input.artworkVersionId) : undefined;
      if (input.slotKey !== "artwork" && !art) throw new Error("Synthetic retained artwork source missing");
      const inputKeys = art ? [`image:asset-${art.assetId}`] : [];
      const projectBrief = await bridge.get(a, project.id), originalPrompt = "Synthetic retained original";
      const origin = input.slotKey !== "artwork" ? `\n\n套图固定图稿版本：${input.artworkVersionId}。首张参考图是已审核的唯一图稿来源，须保持图案、身份、姿态、比例和文字不变；真实样品参考用于核对抱枕轮廓、材质和单双面。不能用样品照片替换图稿内容。` : "";
      const prompt = projectBrief.designInstructions ? `${originalPrompt}\n\n项目固定需求：\n${projectBrief.designInstructions}${origin}` : originalPrompt;
      const storedInput = StudioGenerateRequestSchema.parse({ requestId: input.requestId, modelId: input.modelId, capability: "image", selectionRevision: selected.selectionRevision,
        visualSlotKey: input.slotKey, ...(input.artworkVersionId ? { visualArtworkVersionId: input.artworkVersionId } : {}), size: input.size,
        prompt, referenceKeys: inputKeys, quality: "high", background: input.slotKey === "artwork" ? "transparent" : "opaque", seconds: 4 });
      const id = createEntityId(), assetId = status === "completed" ? createEntityId() : undefined;
      ids.generations.push(id); if (assetId) ids.assets.push(assetId);
      const bytes = output ?? (input.slotKey === "artwork" ? transparent : opaque);
      const stored = assetId ? await storage.putPrivate(a, { domain: "authorized", fileName: `synthetic-retained-${id}.png`, mediaType: "image/png", body: bytes }) : undefined;
      await withTenant(db.db, a, async tx => {
        if (assetId && stored) await tx.insert(assetFiles).values({ id: assetId, tenantId: a.tenantId, ownerUserId: a.userId, ...stored, assetDomain: "authorized", fileName: `synthetic-retained-${id}.png`, mediaType: "image/png", byteSize: bytes.length,
          aiGenerated: true, rightsStatus: "unverified", rightsMetadata: { source: { kind: "ai_generated" }, fixture: "retained-pre-quotation-history" } });
        const references = await tx.select().from(assetFiles).where(inArray(assetFiles.id, [pin.sampleAssetId, ...(art ? [art.assetId] : [])]));
        await tx.insert(creativeStudioGenerations).values({ id, tenantId: a.tenantId, ownerId: a.userId, scope: project.id, requestId: storedInput.requestId, input: storedInput, status,
          assetId: assetId ?? null, references: references.map(file => ({ assetId: file.id, version: file.version, checksum: file.checksumSha256 })),
          modelSnapshot: { routeId: pin.modelId, providerConfigId: pin.providerConfigId, model: pin.providerModel, capability: "image", providerFingerprint: pin.providerFingerprint, visualCeilingUsd: pin.callCeilingUsd } });
        // Explicit historical fixtures keep their old occupancy without upgrading
        // them into quoted requests or sending any provider/queue operation.
        await tx.insert(aiBudgetLedger).values({ id: createEntityId(), tenantId: a.tenantId, requestId: id, taskType: "studio_image", modelKey: pin.providerModel, provider: "openai-compatible", amountUsd: pin.callCeilingUsd.toFixed(6), state: "reserved" });
        if (status === "queued") await stageCreativeExecution(tx, a, operation(id), "external_request");
      });
      expect(pin.salesPlanId).toBe(p.id); return { id, scope: project.id, input: storedInput };
    }
    async function candidate(
      p: SalesPlanView,
      group: string,
      slot: VisualSlotKey,
      art?: string,
      approve = true,
    ) {
      const result = await retained(p, group, command(slot, art), "completed");
      await dormant(result.id);
      await service.collect(a, p.id, group);
      const task = (await snapshot(p, group)).tasks.find((t) => t.id === result.id)!;
      expect(task.result).not.toBeNull();
      if (approve)
        await service.review(a, p.id, group, {
          versionId: task.result!.versionId,
          decision: "approve",
          checks,
        });
      return task.result!;
    }
    beforeAll(async () => {
      await storage.ensureBucket();
      for (const context of [a, b]) {
        await db.client.unsafe(
          "insert into organizations(id,name,slug) values($1,'Synthetic visuals',$2)",
          [context.tenantId, `visual-${context.tenantId}`],
        );
        await db.client.unsafe(
          "insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Visual fixture')",
          [context.userId, context.userId, `${context.userId}@example.test`],
        );
      }
      const member = createEntityId();
      roleId = createEntityId();
      await withTenant(db.db, a, async (tx) => {
        await tx
          .insert(memberships)
          .values({ id: member, tenantId: a.tenantId, userId: a.userId, status: "active" });
        await tx.insert(roles).values({
          id: roleId,
          tenantId: a.tenantId,
          name: "Visual fixture",
          permissions: Object.values(Permission),
          dataScope: "tenant",
        });
        await tx
          .insert(membershipRoles)
          .values({ tenantId: a.tenantId, membershipId: member, roleId });
      });
      opaque = await sharp({
        create: { width: 1024, height: 1024, channels: 4, background: "#428bc4" },
      })
        .png()
        .toBuffer();
      transparent = await sharp({
        create: {
          width: 1024,
          height: 1024,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .composite([
          {
            input: await sharp({
              create: { width: 800, height: 800, channels: 4, background: "#428bc4" },
            })
              .png()
              .toBuffer(),
            top: 112,
            left: 112,
          },
        ])
        .png()
        .toBuffer();
      sampleId = createEntityId();
      ids.assets.push(sampleId);
      const stored = await storage.putPrivate(a, {
        domain: "authorized",
        fileName: "synthetic-pillow-photo.png",
        mediaType: "image/png",
        body: opaque,
      });
      providerId = createEntityId();
      await withTenant(db.db, a, async (tx) => {
        await tx.insert(assetFiles).values({
          id: sampleId,
          tenantId: a.tenantId,
          ...stored,
          assetDomain: "authorized",
          fileName: "synthetic-pillow-photo.png",
          mediaType: "image/png",
          byteSize: opaque.length,
          rightsStatus: "approved",
          rightsMetadata: { source: { kind: "owned" }, fixture: "synthetic-public-catalog-only" },
        });
        await tx.insert(modelProviderConfigs).values({
          id: providerId,
          tenantId: a.tenantId,
          provider: "openai-compatible",
          label: "Synthetic only",
          endpoint: "https://synthetic.invalid/v1",
          encryptedApiKey: vault.encrypt("not-a-paid-key"),
          createdBy: a.userId,
        });
      });
      modelId = (
        await generation.addModel(a, {
          providerConfigId: providerId,
          model: "synthetic-visual",
          capability: "image",
          label: "Synthetic visual",
        })
      ).id;
      const document = createDefaultProductionDocument("shaped_pillow");
      document.name = "Synthetic pillow template";
      if (document.productType !== "shaped_pillow")
        throw new Error("Synthetic pillow template type");
      document.spec = {
        ...document.spec,
        widthMm: 254,
        heightMm: 254,
        declaredLongestMm: 254,
        sizeBasis: "cut_contour",
        minimumNeckBasis: "cut_contour",
        whiteBorderMm: 5,
        barcodeTab: { widthMm: 40, heightMm: 20, centerXMm: 127 },
        sideMode: "single",
      };
      document.contour = [
        { xMm: 0, yMm: 0, smooth: false },
        { xMm: 254, yMm: 0, smooth: false },
        { xMm: 254, yMm: 254, smooth: false },
        { xMm: 0, yMm: 254, smooth: false },
      ];
      for (const key of Object.keys(document.confirmations) as Array<
        keyof typeof document.confirmations
      >)
        document.confirmations[key] = true;
      let template = await editor.create(a, { name: document.name, document });
      templateId = template.project.id;
      const source = await editor.upload(
        a,
        templateId,
        "synthetic.png",
        await sharp(opaque).resize(2048, 2048).png().toBuffer(),
      );
      if (!("version" in source))
        throw new Error("Synthetic image upload returned an unexpected file kind");
      document.layers = [
        {
          id: "source",
          kind: "image",
          name: "Synthetic source",
          assetId: source.id,
          assetVersion: source.version,
          xMm: 40,
          yMm: 40,
          widthMm: 170,
          heightMm: 170,
          rotationDeg: 0,
          opacity: 1,
          visible: true,
          locked: false,
          flipX: false,
          flipY: false,
        },
      ];
      template = await editor.save(a, templateId, {
        expectedVersionId: template.version.id,
        document,
      });
      await editor.review(a, templateId, template.version.id);
      const profile = (
        await work.saveProfile(a, {
          code: `VIS-${a.tenantId.slice(-8)}`,
          name: document.name,
          projectId: templateId,
          versionId: template.version.id,
          instructions: "Synthetic template, no production release",
          expectedVersion: 0,
          idempotencyKey: randomUUID(),
        })
      )[0]!;
      const spu = await catalog.createSpu(a, {
        code: `VIS-${a.tenantId.slice(-8)}`,
        name: "Synthetic pillow",
        idempotencyKey: randomUUID(),
      });
      spuId = spu.spu.id;
      const spec = await catalog.saveSpecification(a, {
        spuId,
        code: "ONE",
        name: "Synthetic 10 inch",
        attributes: { size: "10" },
        facts: syntheticSpecificationFacts({
          material: "Synthetic fabric",
          dimensions: "10 inch synthetic pillow",
          packageContents: "One synthetic pillow",
          packageQuantity: 1,
          factsConfirmed: true,
        }),
        processProfileVersionId: profile.versionId,
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
      });
      specId = spec.specification.id;
    }, 60000);
    afterAll(async () => {
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        new URL(`integration-${a.tenantId}.json`, directory),
        JSON.stringify(
          {
            tenantId: a.tenantId,
            ids,
            templateId,
            modelCalls: generate.mock.calls.length,
            realPaidCalls: 0,
            transport: "retained private PNG fixtures and dormant legacy Worker; no model endpoint requests",
            cleanup: "all database, storage and Redis resources owned by isolated runner",
          },
          null,
          2,
        ),
      );
      await db.client.end();
    });
    it("prepares four free pinned steps idempotently, isolates tenants and refuses unsafe references", async () => {
      const p = await plan(),
        { input, group } = await prepared(p);
      expect(await service.prepare(a, p.id, input)).toMatchObject({
        groupId: group,
        replayed: true,
      });
      expect((await snapshot(p, group)).tasks).toHaveLength(0);
      expect(generate).not.toHaveBeenCalled();
      expect(queue.enqueue).not.toHaveBeenCalled();
      const projects = await withTenant(db.db, a, (tx) => tx.select().from(creativeDesignBatches));
      expect(
        projects.filter((b) => b.canvasWorkflow?.visualDelivery?.groupId === group),
      ).toHaveLength(4);
      await expect(
        service.prepare(a, p.id, { ...input, direction: "Changed" }),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(service.get(b, p.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.generate(other, p.id, group, command("artwork"))).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(
        service.prepare({ ...a, permissions: [Permission.ProductRead] }, p.id, {
          ...input,
          requestId: randomUUID(),
        }),
      ).rejects.toThrow();
      for (const kind of ["competitor", "customer_provided"]) {
        await withTenant(db.db, a, (tx) =>
          tx
            .update(assetFiles)
            .set({ rightsMetadata: { source: { kind } } })
            .where(eq(assetFiles.id, sampleId)),
        );
        await expect(
          service.prepare(a, p.id, { ...input, requestId: randomUUID() }),
        ).rejects.toThrow();
      }
      await withTenant(db.db, a, (tx) =>
        tx
          .update(assetFiles)
          .set({ rightsMetadata: { source: { kind: "owned" } } })
          .where(eq(assetFiles.id, sampleId)),
      );
    });
    it("reads exact retained artwork into three reviewed slots and adopts one new plan version once", async () => {
      const p = await plan(),
        { group } = await prepared(p),
        art = await candidate(p, group, "artwork");
      await expect(
        service.generate(a, p.id, group, command("scene", createEntityId())),
      ).rejects.toThrow();
      const images = [];
      for (const slot of ["scene", "detail", "customization"] as const)
        images.push(await candidate(p, group, slot, art.versionId));
      const before = generate.mock.calls.length;
      await service.collect(a, p.id, group);
      await service.get(a, p.id);
      expect(generate).toHaveBeenCalledTimes(before);
      const input = {
        expectedRevision: p.revision,
        idempotencyKey: randomUUID(),
        versionIds: images.map((i) => i.versionId),
        useSampleAsMain: true,
      };
      const adopted = await service.adopt(a, p.id, group, input);
      expect(adopted.plan.revision).toBe(p.revision + 1);
      expect(adopted.plan.fields.mainImageId).toBe(sampleId);
      expect(adopted.plan.fields.mediaAssetIds).toEqual([
        ...images.map((i) => i.assetId),
        sampleId,
      ]);
      expect(await service.adopt(a, p.id, group, input)).toEqual(adopted);
      expect((await snapshot(p, group)).adoptedRevision).toBe(2);
      await expect(service.generate(a, p.id, group, command("artwork"))).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(generate).toHaveBeenCalledTimes(before);
    });
    it("blocks mixed artwork origins, generic-review shortcuts and technical defects without changing originals", async () => {
      const p = await plan(),
        { group } = await prepared(p),
        art1 = await candidate(p, group, "artwork"),
        art2 = await candidate(p, group, "artwork");
      const images = [
        await candidate(p, group, "scene", art1.versionId),
        await candidate(p, group, "detail", art2.versionId),
        await candidate(p, group, "customization", art1.versionId),
      ];
      await expect(
        service.adopt(a, p.id, group, {
          expectedRevision: 1,
          idempotencyKey: randomUUID(),
          versionIds: images.map((i) => i.versionId),
        }),
      ).rejects.toThrow("同一已审核图稿");
      const q = await plan(),
        next = await prepared(q);
      output = opaque;
      const bad = await candidate(q, next.group, "artwork", undefined, false);
      output = undefined;
      await expect(
        service.review(a, q.id, next.group, {
          versionId: bad.versionId,
          decision: "approve",
          checks,
        }),
      ).rejects.toThrow("透明背景");
      await service.review(a, q.id, next.group, {
        versionId: bad.versionId,
        decision: "reject",
        checks,
        reason: "Synthetic opaque artwork",
      });
      const task = (await snapshot(q, next.group)).tasks.find(
        (t) => t.result?.versionId === bad.versionId,
      )!;
      expect(task.result?.rejectionReason).toBe("Synthetic opaque artwork");
      const good = await candidate(q, next.group, "artwork", undefined, false);
      await creative.reviewCreativeVersion(a, good.versionId, { decision: "approve" });
      await expect(
        service.generate(a, q.id, next.group, command("scene", good.versionId)),
      ).rejects.toThrow("视觉交付中完成");
      await service.review(a, q.id, next.group, {
        versionId: good.versionId,
        decision: "approve",
        checks,
      });
      expect(
        (await snapshot(q, next.group)).tasks.find((t) => t.result?.versionId === good.versionId)
          ?.controlledReview,
      ).toBe(true);
      output = await sharp(transparent)
        .resize(256, 256)
        .withMetadata({ density: 300 })
        .png()
        .toBuffer();
      const small = await candidate(q, next.group, "artwork", undefined, false);
      output = undefined;
      await expect(
        service.review(a, q.id, next.group, {
          versionId: small.versionId,
          decision: "approve",
          checks,
        }),
      ).rejects.toThrow("1024 px");
      output = await sharp({
        create: {
          width: 1024,
          height: 1024,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .png()
        .toBuffer();
      const empty = await candidate(q, next.group, "artwork", undefined, false);
      output = undefined;
      await expect(
        service.review(a, q.id, next.group, {
          versionId: empty.versionId,
          decision: "approve",
          checks,
        }),
      ).rejects.toThrow("没有可见主体");
    });
    it("keeps retained uncertain billing reserved and rejects generic retries or concurrent new unquoted calls", async () => {
      const p = await plan(),
        { group } = await prepared(p, 0.2),
        input = command("artwork"),
        job = await retained(p, group, input);
      await withTenant(db.db, a, async tx => {
        const [ledger] = await tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.requestId, job.id));
        if (!ledger) throw new Error("Synthetic retained occupancy missing");
        await tx.update(creativeStudioGenerations).set({ status: "failed", error: "studio_submission_interrupted" }).where(eq(creativeStudioGenerations.id, job.id));
        await tx.update(creativeExecutions).set({ phase: "uncertain", errorCode: "CREATIVE_RESULT_UNCERTAIN", attemptCount: 1,
          submittedAt: sql`clock_timestamp()-interval '1 hour'`, submissionToken: createEntityId(), budgetLedgerId: ledger.id, budgetLimitUsd: ledger.amountUsd }).where(eq(creativeExecutions.studioGenerationId, job.id));
      });
      const unknown = await dormant(job.id); await dormant(job.id);
      expect(unknown.execution[0]).toMatchObject({ phase: "uncertain", receipt: null, errorCode: "CREATIVE_RESULT_UNCERTAIN" });
      expect(unknown.ledger[0]).toMatchObject({ state: "reserved", amountUsd: "0.100000" });
      expect(await generation.originalInput(a, job.scope, input.requestId)).toEqual(job.input);
      await expect(service.generate(a, p.id, group, input)).rejects.toMatchObject({ status: 409, response: { code: "studio_paid_execution_paused" } });
      await candidate(p, group, "artwork", undefined, false);
      expect((await snapshot(p, group)).budget).toMatchObject({
        occupiedUsd: 0.2,
        remainingUsd: 0,
        actualUsd: null,
      });
      const q = await plan(),
        fresh = await prepared(q, 0.1);
      const before = await withTenant(db.db, a, tx => tx.select().from(creativeStudioGenerations).orderBy(creativeStudioGenerations.id));
      const concurrent = await Promise.allSettled([
        service.generate(a, q.id, fresh.group, command("artwork")),
        service.generate(a, q.id, fresh.group, command("artwork")),
      ]);
      for (const result of concurrent) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") expect(result.reason).toMatchObject({ status: 409, response: { code: "studio_paid_execution_paused" } });
      }
      expect(await withTenant(db.db, a, tx => tx.select().from(creativeStudioGenerations).orderBy(creativeStudioGenerations.id))).toEqual(before);
      expect(generate).not.toHaveBeenCalled(); expect(queue.enqueue).not.toHaveBeenCalled();
    });
    it("retains original Harness membership and source checks while a dormant Worker leaves unsubmitted history unchanged", async () => {
      const p = await plan(),
        { group } = await prepared(p),
        job = await retained(p, group, command("artwork"));
      await originalAdmission(job.id);
      await withTenant(db.db, a, (tx) =>
        tx
          .update(roles)
          .set({ permissions: [Permission.ProductRead] })
          .where(eq(roles.id, roleId)),
      );
      try {
        await expect(originalAdmission(job.id)).rejects.toThrow();
        const unchanged = await dormant(job.id);
        expect(unchanged.ledger[0]).toMatchObject({ state: "reserved", amountUsd: "0.100000" });
        expect(unchanged.execution[0]).toMatchObject({ phase: "pending", submittedAt: null, receipt: null });
      } finally {
        await withTenant(db.db, a, (tx) =>
          tx.update(roles).set({ permissions: Object.values(Permission) }).where(eq(roles.id, roleId)),
        );
      }
      const next = await retained(p, group, command("artwork")); await originalAdmission(next.id);
      await plans.save(a, p.id, {
        fields: { ...p.fields, positioning: "Changed source" },
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      });
      await expect(originalAdmission(next.id)).rejects.toThrow(); await dormant(next.id);
      expect((await snapshot(p, group)).stale).toBe(true);
      await expect(generation.create(a, next.scope, next.input)).rejects.toMatchObject({ status: 409, response: { code: "studio_paid_execution_paused" } });
    });
    it("keeps channel template and sample pin rejection in the original Harness without resuming legacy tasks", async () => {
      const p = await plan(),
        { group } = await prepared(p),
        first = await retained(p, group, command("artwork"));
      await originalAdmission(first.id);
      await withTenant(db.db, a, (tx) =>
        tx
          .update(modelProviderConfigs)
          .set({ endpoint: "https://changed-synthetic.invalid/v1" })
          .where(eq(modelProviderConfigs.id, providerId)),
      );
      try {
        await expect(originalAdmission(first.id)).rejects.toThrow(); await dormant(first.id);
        await expect(generation.create(a, first.scope, first.input)).rejects.toMatchObject({ status: 409, response: { code: "studio_paid_execution_paused" } });
      } finally {
        await withTenant(db.db, a, (tx) =>
          tx
            .update(modelProviderConfigs)
            .set({ endpoint: "https://synthetic.invalid/v1" })
            .where(eq(modelProviderConfigs.id, providerId)),
        );
      }
      const second = await retained(p, group, command("artwork")); await originalAdmission(second.id);
      await editor.archive(a, templateId, {
        archived: true,
        reason: "Synthetic source invalidation",
      });
      try {
        await expect(originalAdmission(second.id)).rejects.toThrow(); await dormant(second.id);
      } finally {
        await editor.archive(a, templateId, {
          archived: false,
          reason: "Restore isolated synthetic template",
        });
      }
      const third = await retained(p, group, command("artwork")); await originalAdmission(third.id);
      await withTenant(db.db, a, (tx) =>
        tx.update(assetFiles).set({ version: 2 }).where(eq(assetFiles.id, sampleId)),
      );
      try {
        await expect(originalAdmission(third.id)).rejects.toThrow(); await dormant(third.id);
        expect((await snapshot(p, group)).stale).toBe(true);
      } finally {
        await withTenant(db.db, a, (tx) =>
          tx.update(assetFiles).set({ version: 1 }).where(eq(assetFiles.id, sampleId)),
        );
      }
      expect((await snapshot(p, group)).budget).toMatchObject({ occupiedUsd: 0.3, remainingUsd: 1.7, actualUsd: null });
      expect(generate).not.toHaveBeenCalled();
    });
    it("retains model routes attempts and shared organizational occupancy while every unquoted create stays paused", async () => {
      const p = await plan(),
        { group } = await prepared(p);
      const [originalRoute] = await withTenant(db.db, a, (tx) =>
        tx.select().from(modelRoutes).where(eq(modelRoutes.id, modelId)),
      );
      const project = (
        await withTenant(db.db, a, (tx) => tx.select().from(creativeDesignBatches))
      ).find(
        (r) =>
          r.canvasWorkflow?.visualDelivery?.groupId === group &&
          r.canvasWorkflow.visualDelivery.slotKey === "artwork",
      )!;
      await expect(
        generation.create(
          a,
          project.id,
          StudioGenerateSchema.parse({
            requestId: randomUUID(),
            modelId,
            capability: "image",
            selectionRevision: (await generation.models(a)).find((model) => model.id === modelId)!.selectionRevision,
            prompt: "Synthetic",
            visualSlotKey: "artwork",
            size: "2048x2048",
            background: "transparent",
          }),
        ),
      ).rejects.toMatchObject({ status: 409, response: { code: "studio_paid_execution_paused" } });
      const historical = await retained(p, group, command("artwork")); await originalAdmission(historical.id);
      await withTenant(db.db, a, (tx) =>
        tx
          .update(modelRoutes)
          .set({
            targets: [
              { providerConfigId: providerId, providerModel: "changed-model", timeoutMs: 60000 },
            ],
          })
          .where(eq(modelRoutes.id, modelId)),
      );
      await expect(originalAdmission(historical.id)).rejects.toThrow(); await dormant(historical.id);
      await withTenant(db.db, a, (tx) =>
        tx
          .update(modelRoutes)
          .set({
            targets: originalRoute!.targets,
          })
          .where(eq(modelRoutes.id, modelId)),
      );
      const retainedPlan = await plan(), history = await prepared(retainedPlan);
      for (let i = 0; i < 4; i++) await candidate(retainedPlan, history.group, "artwork");
      expect((await snapshot(retainedPlan, history.group)).tasks).toHaveLength(4);
      await expect(service.generate(a, retainedPlan.id, history.group, command("artwork"))).rejects.toMatchObject({ status: 409, response: { code: "studio_paid_execution_paused" } });
      const q = await plan(),
        next = await prepared(q);
      await withTenant(db.db, a, (tx) =>
        tx.insert(aiBudgetPolicies).values({
          tenantId: a.tenantId,
          monthlyCapUsd: "0.01",
          defaultTaskCapUsd: "1",
          taskCapsUsd: { studio_image: 1 },
        }),
      );
      const before = await withTenant(db.db, a, tx => tx.select().from(aiBudgetLedger).orderBy(aiBudgetLedger.id));
      await expect(service.generate(a, q.id, next.group, command("artwork"))).rejects.toMatchObject({ status: 409, response: { code: "studio_paid_execution_paused" } });
      expect(await withTenant(db.db, a, tx => tx.select().from(aiBudgetLedger).orderBy(aiBudgetLedger.id))).toEqual(before);
      expect(generate).not.toHaveBeenCalled(); expect(queue.enqueue).not.toHaveBeenCalled();
    });
  },
);
