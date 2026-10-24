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
import { StudioGenerateSchema } from "@yummyai/contracts/pod/creative-studio";
import {
  assetFiles,
  aiBudgetLedger,
  aiBudgetPolicies,
  connectDatabase,
  creativeDesignBatches,
  creativeExecutions,
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
import { eq, sql } from "drizzle-orm";
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
  "controlled pillow visuals through canonical services and the real processor",
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
      fault = false,
      output: Buffer | undefined;
    const generate = vi.fn(async (request: { input: { background: string } }) => {
      if (fault) {
        fault = false;
        throw new Error("synthetic-secret-provider-error");
      }
      return {
        bytes: output ?? (request.input.background === "transparent" ? transparent : opaque),
        mediaType: "image/png",
      };
    });
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
    async function stoppedBeforeSubmission(id: string) {
      const [execution] = await withTenant(db.db, a, tx => tx.select().from(creativeExecutions).where(eq(creativeExecutions.studioGenerationId, id)));
      expect(execution).toMatchObject({ phase: "failed", errorCode: "CREATIVE_AUTHORITY_OR_INPUT_CHANGED", submittedAt: null, receipt: null });
      const [ledger] = await withTenant(db.db, a, tx => tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.requestId, id)));
      expect(ledger?.state).toBe("released");
    }
    async function candidate(
      p: SalesPlanView,
      group: string,
      slot: VisualSlotKey,
      art?: string,
      approve = true,
    ) {
      const result = await service.generate(a, p.id, group, command(slot, art));
      ids.generations.push(result.id);
      // A ready positive fixture must not depend on sub-second wall-clock drift.
      // Future/retry admission tests set their own later schedule explicitly.
      await withTenant(db.db, a, tx => tx.update(creativeExecutions)
        .set({ nextAttemptAt: sql`clock_timestamp()-interval '1 second'` }).where(eq(creativeExecutions.studioGenerationId, result.id)));
      await processor.process(envelope(result.id));
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
            transport: "injected controlled PNG output; no model endpoint requests",
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
    it("runs exact approved artwork into three reviewed slots and adopts one new plan version once", async () => {
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
    it("keeps uncertain failures reserved, replays without a new call and serializes budget admission", async () => {
      const p = await plan(),
        { group } = await prepared(p, 0.2),
        input = command("artwork"),
        job = await service.generate(a, p.id, group, input);
      ids.generations.push(job.id);
      expect((await service.generate(a, p.id, group, input)).id).toBe(job.id);
      fault = true;
      await expect(processor.process(envelope(job.id))).rejects.toThrow("studio_generation_failed");
      const calls = generate.mock.calls.length;
      await processor.process(envelope(job.id));
      expect(generate).toHaveBeenCalledTimes(calls);
      const next = await service.generate(a, p.id, group, command("artwork"));
      ids.generations.push(next.id);
      await processor.process(envelope(next.id));
      await expect(service.generate(a, p.id, group, command("artwork"))).rejects.toThrow(
        "剩余预算不足",
      );
      expect((await snapshot(p, group)).budget).toMatchObject({
        occupiedUsd: 0.2,
        remainingUsd: 0,
        actualUsd: null,
      });
      const q = await plan(),
        fresh = await prepared(q, 0.1);
      const concurrent = await Promise.allSettled([
        service.generate(a, q.id, fresh.group, command("artwork")),
        service.generate(a, q.id, fresh.group, command("artwork")),
      ]);
      expect(concurrent.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const accepted = concurrent.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{
        id: string;
      }>;
      await processor.process(envelope(accepted.value.id));
    });
    it("rechecks membership and source pins in the Worker before submission and releases only unsubmitted calls", async () => {
      const p = await plan(),
        { group } = await prepared(p),
        job = await service.generate(a, p.id, group, command("artwork"));
      ids.generations.push(job.id);
      await withTenant(db.db, a, (tx) =>
        tx
          .update(roles)
          .set({ permissions: [Permission.ProductRead] })
          .where(eq(roles.id, roleId)),
      );
      const calls = generate.mock.calls.length;
      try {
        await expect(processor.process(envelope(job.id))).rejects.toThrow("studio_generation_failed");
        expect(generate).toHaveBeenCalledTimes(calls);
        const [ledger] = await withTenant(db.db, a, (tx) =>
          tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.requestId, job.id)),
        );
        expect(ledger).toMatchObject({ state: "released", amountUsd: "0.100000" });
        const [execution] = await withTenant(db.db, a, tx => tx.select().from(creativeExecutions).where(eq(creativeExecutions.studioGenerationId, job.id)));
        expect(execution).toMatchObject({ phase: "failed", errorCode: "CREATIVE_AUTHORITY_OR_INPUT_CHANGED", submittedAt: null, receipt: null });
      } finally {
        await withTenant(db.db, a, (tx) =>
          tx.update(roles).set({ permissions: Object.values(Permission) }).where(eq(roles.id, roleId)),
        );
      }
      const next = await service.generate(a, p.id, group, command("artwork"));
      ids.generations.push(next.id);
      await plans.save(a, p.id, {
        fields: { ...p.fields, positioning: "Changed source" },
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      });
      await expect(processor.process(envelope(next.id))).rejects.toThrow(
        "studio_generation_failed",
      );
      await stoppedBeforeSubmission(next.id);
      expect(generate).toHaveBeenCalledTimes(calls);
      expect((await snapshot(p, group)).stale).toBe(true);
      await expect(service.generate(a, p.id, group, command("artwork"))).rejects.toThrow(
        "商品或规格已变化",
      );
    });
    it("stops before calling changed channels, archived templates or modified sample versions", async () => {
      const p = await plan(),
        { group } = await prepared(p),
        first = await service.generate(a, p.id, group, command("artwork"));
      ids.generations.push(first.id);
      const calls = generate.mock.calls.length;
      await withTenant(db.db, a, (tx) =>
        tx
          .update(modelProviderConfigs)
          .set({ endpoint: "https://changed-synthetic.invalid/v1" })
          .where(eq(modelProviderConfigs.id, providerId)),
      );
      try {
        await expect(service.generate(a, p.id, group, command("artwork"))).rejects.toThrow(
          "模型渠道配置已变化",
        );
        await expect(processor.process(envelope(first.id))).rejects.toThrow(
          "studio_generation_failed",
        );
        expect(generate).toHaveBeenCalledTimes(calls);
        const [execution] = await withTenant(db.db, a, tx => tx.select().from(creativeExecutions).where(eq(creativeExecutions.studioGenerationId, first.id)));
        expect(execution).toMatchObject({ phase: "failed", errorCode: "CREATIVE_AUTHORITY_OR_INPUT_CHANGED", submittedAt: null, receipt: null });
      } finally {
        await withTenant(db.db, a, (tx) =>
          tx
            .update(modelProviderConfigs)
            .set({ endpoint: "https://synthetic.invalid/v1" })
            .where(eq(modelProviderConfigs.id, providerId)),
        );
      }
      const second = await service.generate(a, p.id, group, command("artwork"));
      ids.generations.push(second.id);
      await editor.archive(a, templateId, {
        archived: true,
        reason: "Synthetic source invalidation",
      });
      try {
        await expect(processor.process(envelope(second.id))).rejects.toThrow(
          "studio_generation_failed",
        );
        await stoppedBeforeSubmission(second.id);
        expect(generate).toHaveBeenCalledTimes(calls);
      } finally {
        await editor.archive(a, templateId, {
          archived: false,
          reason: "Restore isolated synthetic template",
        });
      }
      const third = await service.generate(a, p.id, group, command("artwork"));
      ids.generations.push(third.id);
      await withTenant(db.db, a, (tx) =>
        tx.update(assetFiles).set({ version: 2 }).where(eq(assetFiles.id, sampleId)),
      );
      try {
        await expect(processor.process(envelope(third.id))).rejects.toThrow(
          "studio_generation_failed",
        );
        await stoppedBeforeSubmission(third.id);
        expect((await snapshot(p, group)).stale).toBe(true);
        expect(generate).toHaveBeenCalledTimes(calls);
      } finally {
        await withTenant(db.db, a, (tx) =>
          tx.update(assetFiles).set({ version: 1 }).where(eq(assetFiles.id, sampleId)),
        );
      }
      expect((await snapshot(p, group)).budget).toMatchObject({ occupiedUsd: 0, remainingUsd: 2 });
    });
    it("pins the model route, limits attempts and respects the shared organizational budget", async () => {
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
      ).rejects.toThrow();
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
      await expect(service.generate(a, p.id, group, command("artwork"))).rejects.toThrow(
        "模型渠道或路由已变化",
      );
      await withTenant(db.db, a, (tx) =>
        tx
          .update(modelRoutes)
          .set({
            targets: originalRoute!.targets,
          })
          .where(eq(modelRoutes.id, modelId)),
      );
      for (let i = 0; i < 4; i++) await candidate(p, group, "artwork");
      await expect(service.generate(a, p.id, group, command("artwork"))).rejects.toThrow(
        "最多 4 次尝试",
      );
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
      await expect(service.generate(a, q.id, next.group, command("artwork"))).rejects.toThrow(
        "组织当月 AI 预算不足",
      );
    });
  },
);
