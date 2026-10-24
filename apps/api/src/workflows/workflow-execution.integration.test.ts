import { Permission } from "@yummyai/authz";
import { CatalogPackageService, catalogFingerprint } from "@yummyai/catalog-core";
import { PodArtworkOwner, RedisPodArtworkDispatcher } from "@yummyai/pod-core";
import { WorkflowNodeRuntime } from "@yummyai/workflow-core";
import {
  createEntityId,
  type CaptureDraft,
  type TenantContext,
  type WorkflowGraph,
} from "@yummyai/contracts";
import {
  assetFiles,
  catalogOperationReceipts,
  podArtworkInvocations,
  podArtworkExecutions,
  connectDatabase,
  migrateDatabase,
  recordAuditInTransaction,
  roles,
  researchItems,
  productPlans,
  spus,
  workflowNodeAttempts,
  workflowNodeRuns,
  workflowRunEvents,
  withTenant,
} from "@yummyai/database";
import { createQueue, createTraceId, QueueName, type JobEnvelope, type QueueNameValue } from "@yummyai/jobs";
import {
  checksumSha256,
  createStorageFromEnvironment,
  inspectCustomProductPackage,
} from "@yummyai/storage";
import { and, desc, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createWorker } from "../../../worker/src/main.js";
import {
  WorkflowNodeProcessor,
  WorkflowNodeScheduler,
} from "../../../worker/src/processors/workflow-node.processor.js";
import {
  PodArtworkProcessor,
  type PodArtworkExecutionResult,
} from "../../../worker/src/processors/pod-artwork.processor.js";
import { DrizzlePodArtworkExecutionRepository } from "../../../worker/src/processors/pod-artwork.repository.js";
import { HttpPodArtworkGateway } from "../../../worker/src/processors/pod-artwork.http-gateway.js";
import { AuditService } from "../audit/audit.service.js";
import { CaptureService } from "../capture/capture.service.js";
import { ResearchClassificationService } from "../research/research-classification.service.js";
import { DrizzleCatalogRepository, ProductService } from "../catalog/product.service.js";
import { PodWorkbenchService } from "../design/pod-workbench.service.js";
import { WorkflowCapabilityRegistry } from "./workflow-capability.registry.js";
import { WorkflowDefinitionService } from "./workflow-definition.service.js";
import {
  ExternalWorkflowExecutor,
  HumanExecutor,
  InternalCapabilityExecutor,
  WorkflowExecutorRouter,
  type WorkflowNodeEnqueuer,
} from "./workflow-node.executor.js";
import { WorkflowRunService } from "./workflow-run.service.js";
import { WorkflowOperatorService } from "./workflow-operator.service.js";
import { WorkflowExecutionSnapshotSchema, type WorkflowExecutionSnapshot } from "@yummyai/contracts/workflow/execution";

if (
  process.env.E2E_ISOLATED_DAILY !== "1" ||
  !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname)
)
  throw new Error("Use the disposable --suite=workflow-execution-integration runner");

describe("workflow actual owner execution", () => {
  const database = connectDatabase(),
    storage = createStorageFromEnvironment(),
    audit = new AuditService(database);
  const tenantId = createEntityId(),
    userId = createEntityId(),
    otherTenantId = createEntityId(),
    otherUserId = createEntityId(),
    roleId = createEntityId();
  const permissions = Object.values(Permission),
    context: TenantContext = { tenantId, userId, permissions, dataScope: "tenant" };
  const products = new ProductService(new DrizzleCatalogRepository(database));
  const captureService = new CaptureService(
    database,
    { enqueue: async () => {} },
    audit,
    new ResearchClassificationService(database, audit),
    storage,
  );
  const catalog = new CatalogPackageService(database, storage),
    podDispatcher = new RedisPodArtworkDispatcher();
  const activation = { isToolEnabled: (key: string) => key === "pattern_crop" };
  const pod = new PodArtworkOwner(database, podDispatcher, activation, {
    recordInTransaction: recordAuditInTransaction,
  });
  const runtime = new WorkflowNodeRuntime(database, catalog, pod);
  const actualProcessor = new WorkflowNodeProcessor(runtime);
  const processor = {
    async process(envelope: JobEnvelope) {
      const ref = envelope.payload as { attemptId?: string };
      const before = envelope.tenantId === tenantId && envelope.requestedBy === userId && ref.attemptId
        ? await withTenant(database.db, context, tx => tx.select({
          status: workflowNodeAttempts.status,
          nextAttemptAt: sql<string>`${workflowNodeAttempts.nextAttemptAt}::text`,
          databaseNow: sql<string>`clock_timestamp()::text`,
          due: sql<boolean>`${workflowNodeAttempts.nextAttemptAt} <= clock_timestamp()`,
        }).from(workflowNodeAttempts).where(eq(workflowNodeAttempts.id, ref.attemptId!))) : [];
      const result = await actualProcessor.process(envelope);
      if (result.state === "skipped" && before.length) {
        process.stdout.write(JSON.stringify({ diagnostic: "synthetic_workflow_skip", attemptId: ref.attemptId, before: before[0] }) + "\n");
      }
      return result;
    },
  };
  const definitions = new WorkflowDefinitionService(
    database,
    new WorkflowCapabilityRegistry(
      new PodWorkbenchService({ enabledTools: () => new Set(["pattern_crop"] as const) }),
    ),
  );
  const queued: Array<Parameters<WorkflowNodeEnqueuer["enqueue"]>[0]> = [];
  const jobs: WorkflowNodeEnqueuer = {
    enqueue: async (input) => {
      queued.push(input);
    },
  };
  const runs = service(jobs);
  const operator = new WorkflowOperatorService(database, runs, catalog, pod);
  let image: Buffer;

  function service(enqueuer: WorkflowNodeEnqueuer) {
    return new WorkflowRunService(
      database,
      definitions,
      new WorkflowExecutorRouter(
        new HumanExecutor(),
        new InternalCapabilityExecutor(enqueuer),
        new ExternalWorkflowExecutor(),
      ),
      runtime,
    );
  }
  beforeAll(async () => {
    await migrateDatabase(database);
    await storage.ensureBucket();
    await database.client.unsafe(
      "insert into organizations(id,name,slug) values($1,'Workflow execution fixture',$2),($3,'Other workflow fixture',$4)",
      [tenantId, `execution-${tenantId}`, otherTenantId, `execution-${otherTenantId}`],
    );
    await database.client.unsafe(
      "insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Execution operator'),($4,$5,$6,'Other operator')",
      [
        userId,
        `execution-${userId}`,
        `${userId}@example.test`,
        otherUserId,
        `execution-${otherUserId}`,
        `${otherUserId}@example.test`,
      ],
    );
    const member = createEntityId();
    await database.client.unsafe(
      "insert into memberships(id,tenant_id,user_id,status) values($1,$2,$3,'active')",
      [member, tenantId, userId],
    );
    await database.client.unsafe(
      "insert into roles(id,tenant_id,name,permissions,data_scope) values($1,$2,'Execution operator',$3::jsonb,'tenant')",
      [roleId, tenantId, JSON.stringify(permissions)],
    );
    await database.client.unsafe(
      "insert into membership_roles(tenant_id,membership_id,role_id) values($1,$2,$3)",
      [tenantId, member, roleId],
    );
    image = await sharp({ create: { width: 40, height: 30, channels: 3, background: "blue" } })
      .png()
      .toBuffer();
  });
  afterAll(async () => {
    await podDispatcher.close();
    await database.client.end();
  });

  async function grant(values: readonly string[] = permissions, scope = "tenant") {
    await withTenant(database.db, context, (tx) =>
      tx.update(roles).set({ permissions: values, dataScope: scope }).where(eq(roles.id, roleId)),
    );
  }
  async function source(
    externalId = "ORIGINAL",
    sourceUrl = `https://www.amazon.com/dp/${createEntityId()}`,
  ) {
    const draft: CaptureDraft = {
      platform: "amazon",
      marketplace: "www.amazon.com",
      sourceUrl,
      externalId,
      title: "Custom Mug",
      parserVersion: "execution-fixture-v1",
      extensionVersion: "0.0.0",
      domain: "research",
      price: null,
      rating: null,
      reviewCount: null,
      listingPublishedAt: null,
      favoriteCount: null,
      shipping: null,
      shop: null,
      reviewSummary: null,
      reviews: [],
      reviewCollection: {
        collectedCount: 0,
        reportedTotal: null,
        pageCount: 0,
        status: "visible",
        updatedAt: new Date().toISOString(),
      },
      taxonomy: [],
      bullets: [],
      media: [],
      variants: [],
      productInformation: [],
      contentBlocks: [],
      missingFields: [],
      diagnostics: [],
      captureStatus: "complete",
      capturedAt: new Date().toISOString(),
    };
    return { ...(await captureService.createSnapshot(context, draft)), sourceUrl };
  }
  async function plan() {
    return products.createPlan(context, {
      name: "Synthetic workflow product",
      sourceReportIds: [],
      customization: { version: 1, fields: [] },
    });
  }
  async function start(
    capability: string,
    parameters: Record<string, unknown>,
    planId?: string,
    runner = runs,
    prepareDue = true,
  ) {
    const productPlanId = planId ?? (await plan()).id;
    const graph: WorkflowGraph = {
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: "start",
          kind: "start",
          title: "Start",
          description: "",
          ownerRole: "operator",
          inputPorts: [],
          outputPorts: [],
          config: { parameters: {} },
          position: { x: 0, y: 0 },
        },
        {
          id: "execute",
          kind: "internal_action",
          title: "Execute owner capability",
          description: "",
          ownerRole: "operator",
          inputPorts: [],
          outputPorts: [],
          requiredPermission: capability.startsWith("pod.")
            ? Permission.DesignWrite
            : Permission.ProductWrite,
          config: { capabilityKey: capability, parameters },
          position: { x: 0, y: 100 },
        },
        {
          id: "review",
          kind: "approval_gate",
          title: "Human review",
          description: "",
          ownerRole: "reviewer",
          inputPorts: [],
          outputPorts: [],
          requiredPermission: Permission.ProductWrite,
          config: { parameters: {}, approvalMode: "any" },
          reworkTargetNodeId: "execute",
          position: { x: 0, y: 200 },
        },
        {
          id: "end",
          kind: "end",
          title: "End",
          description: "",
          ownerRole: "operator",
          inputPorts: [],
          outputPorts: [],
          config: { parameters: {} },
          position: { x: 0, y: 300 },
        },
      ],
      edges: [
        { id: "a", source: "start", target: "execute", kind: "success" },
        { id: "b", source: "execute", target: "review", kind: "success" },
        { id: "c", source: "review", target: "end", kind: "success" },
        { id: "d", source: "review", target: "execute", kind: "rework" },
      ],
    };
    const definition = await definitions.create(context, {
      name: "Execution fixture",
      description: "Synthetic acceptance",
      category: "Acceptance",
      scope: "team",
      graph,
    });
    await definitions.publish(context, definition.id, definition.revision);
    const run = await runner.start(context, { definitionId: definition.id, productPlanId });
    // These immediate-execution fixtures deliberately own a due task. Tests of
    // future scheduling and leases overwrite this afterwards and retain their gates.
    if (prepareDue) {
      const intent = await attempt(run.id);
      await withTenant(database.db, context, tx => tx.update(workflowNodeAttempts)
        .set({ nextAttemptAt: sql`clock_timestamp()-interval '1 second'` }).where(eq(workflowNodeAttempts.id, intent.id)));
    }
    return run;
  }
  async function attempt(runId: string) {
    const [row] = await withTenant(database.db, context, (tx) =>
      tx
        .select({ attempt: workflowNodeAttempts, nodeRunId: workflowNodeRuns.id })
        .from(workflowNodeAttempts)
        .innerJoin(workflowNodeRuns, eq(workflowNodeRuns.id, workflowNodeAttempts.nodeRunId))
        .where(and(eq(workflowNodeRuns.runId, runId), eq(workflowNodeRuns.nodeId, "execute")))
        .orderBy(desc(workflowNodeAttempts.attemptNumber))
        .limit(1),
    );
    if (!row) throw new Error("Workflow attempt fixture missing");
    return { ...row.attempt, runId, nodeRunId: row.nodeRunId };
  }
  function job(input: { runId: string; nodeRunId: string; id: string }): JobEnvelope {
    return {
      jobId: createEntityId(),
      tenantId,
      requestedBy: userId,
      traceId: createTraceId(),
      correlationId: input.runId,
      idempotencyKey: input.id,
      requestedAt: new Date().toISOString(),
      attempt: 0,
      maxAttempts: 3,
      payload: { runId: input.runId, nodeRunId: input.nodeRunId, attemptId: input.id },
    };
  }
  async function historicalContract(runId: string, mutate: (snapshot: WorkflowExecutionSnapshot) => void) {
    const initial = await attempt(runId), snapshot = WorkflowExecutionSnapshotSchema.parse(initial.inputSnapshot);
    mutate(snapshot);
    await withTenant(database.db, context, async tx => {
      await tx.update(workflowNodeAttempts).set({ status: "cancelled", finishedAt: sql`clock_timestamp()` }).where(eq(workflowNodeAttempts.id, initial.id));
      await tx.insert(workflowNodeAttempts).values({ id: createEntityId(), tenantId, nodeRunId: initial.nodeRunId, attemptNumber: initial.attemptNumber + 1, status: "queued", requestedBy: userId,
        inputSnapshot: snapshot, inputChecksum: catalogFingerprint(snapshot), outputSnapshot: initial.outputSnapshot });
      await tx.update(workflowNodeRuns).set({ attemptCount: initial.attemptNumber + 1 }).where(eq(workflowNodeRuns.id, initial.nodeRunId));
    });
    const historical = await attempt(runId);
    // A direct processor call owns no scheduler retry. Wait for the persisted
    // synthetic attempt's real eligibility without changing its due timestamp.
    await vi.waitFor(async () => {
      const [eligibility] = await withTenant(database.db, context, tx => tx.select({
        status: workflowNodeAttempts.status,
        due: sql<boolean>`${workflowNodeAttempts.nextAttemptAt} <= clock_timestamp() - interval '25 milliseconds'`,
      }).from(workflowNodeAttempts).where(eq(workflowNodeAttempts.id, historical.id)));
      expect(eligibility).toMatchObject({ status: "queued", due: true });
    }, { timeout: 5_000, interval: 10 });
    return historical;
  }
  async function receipts(planId: string) {
    return withTenant(database.db, context, (tx) =>
      tx
        .select()
        .from(catalogOperationReceipts)
        .where(eq(catalogOperationReceipts.productPlanId, planId)),
    );
  }

  it("scopes maintenance dispatch to explicit tenant selections without consuming another tenant's intent", async () => {
    const evidence = await source();
    const run = await start("yummyai.custom_product.generate_provisional_facts", {
      researchSnapshotId: evidence.snapshotId,
    });
    const initial = await attempt(run.id);
    await withTenant(database.db, context, tx => tx.update(workflowNodeAttempts)
      .set({ nextAttemptAt: sql`clock_timestamp() - interval '1 second'`, lastDispatchedAt: null })
      .where(eq(workflowNodeAttempts.id, initial.id)));
    const excludedQueue = createQueue(`${QueueName.WorkflowNode}-${createEntityId()}` as QueueNameValue);
    const emptyQueue = createQueue(`${QueueName.WorkflowNode}-${createEntityId()}` as QueueNameValue);
    const includedQueue = createQueue(`${QueueName.WorkflowNode}-${createEntityId()}` as QueueNameValue);
    const excluded = new WorkflowNodeScheduler(database, runtime, excludedQueue, [otherTenantId]);
    const empty = new WorkflowNodeScheduler(database, runtime, emptyQueue, []);
    const included = new WorkflowNodeScheduler(database, runtime, includedQueue, [tenantId]);
    try {
      expect(await excluded.dispatch()).toEqual({ queued: 0, failed: 0, legacy: 0 });
      expect(await empty.dispatch()).toEqual({ queued: 0, failed: 0, legacy: 0 });
      expect(await attempt(run.id)).toMatchObject({
        status: "queued", dispatchCount: initial.dispatchCount, lastDispatchedAt: null,
      });
      expect(await excludedQueue.getJobCounts("waiting", "delayed")).toMatchObject({ waiting: 0, delayed: 0 });
      expect(await emptyQueue.getJobCounts("waiting", "delayed")).toMatchObject({ waiting: 0, delayed: 0 });
      expect(await included.dispatch()).toEqual({ queued: 1, failed: 0, legacy: 0 });
      const messages = await includedQueue.getJobs(["waiting", "delayed"]);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.data).toMatchObject({
        tenantId, requestedBy: userId,
        payload: { runId: run.id, nodeRunId: initial.nodeRunId, attemptId: initial.id },
      });
      await processor.process(messages[0]!.data as JobEnvelope);
      expect((await runs.get(context, run.id)).currentNodeId).toBe("review");
      expect(await receipts(run.productPlanId)).toHaveLength(1);
    } finally {
      await Promise.all([excluded.close(), empty.close(), included.close()]);
    }
  });

  it("executes the catalog owner once, pins the original research snapshot and stops at human approval", async () => {
    const original = await source(),
      run = await start("yummyai.custom_product.generate_provisional_facts", {
        researchSnapshotId: original.snapshotId,
      });
    const intent = await attempt(run.id);
    expect(intent.inputSnapshot).toMatchObject({
      input: { value: { sources: [{ snapshotId: original.snapshotId }] } },
    });
    await source("RECAPTURED", original.sourceUrl);
    await expect(processor.process(job(intent))).resolves.toMatchObject({ state: "completed" });
    await expect(processor.process(job(intent))).resolves.toMatchObject({ state: "skipped" });
    const result = await runs.get(context, run.id),
      saved = await receipts(run.productPlanId);
    expect(result).toMatchObject({ status: "active", currentNodeId: "review" });
    expect(saved).toHaveLength(1);
    expect(saved[0]?.result.profile).toMatchObject({
      sku: { value: "DRAFT-ORIGINAL" },
      approvedClaims: [],
    });
    expect(result.artifacts[0]).toMatchObject({
      artifactType: "product_facts",
      artifactId: saved[0]!.id,
      validationStatus: "pending",
    });
    expect(result.events.filter((event) => event.type === "node_approved")).toHaveLength(0);
    await expect(
      runs.command(context, run.id, "review", {
        type: "complete",
        expectedRevision: result.revision,
        parameters: {},
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("does not overwrite product facts edited while a queued task waits", async () => {
    const evidence = await source(),
      run = await start("yummyai.custom_product.generate_provisional_facts", {
        researchSnapshotId: evidence.snapshotId,
      }),
      intent = await attempt(run.id);
    const profile = {
      schemaVersion: "1.0" as const,
      materials: [],
      colors: [],
      sizeOptions: [],
      packageContents: [],
      targetAudiences: [],
      sellingPoints: [],
      surfaces: [],
      approvedClaims: ["Manually verified fact"],
      prohibitedClaims: [],
      prohibitedElements: [],
      researchItemIds: [],
      assetAssignments: [],
      updatedAt: new Date().toISOString(),
    };
    await catalog.saveProfile(context, run.productPlanId, { profile });
    await expect(processor.process(job(intent))).resolves.toMatchObject({ state: "failed" });
    const [current] = await withTenant(database.db, context, (tx) =>
      tx.select().from(productPlans).where(eq(productPlans.id, run.productPlanId)),
    );
    expect(current?.customProductProfile?.approvedClaims).toEqual(["Manually verified fact"]);
    expect(await receipts(run.productPlanId)).toHaveLength(1);
  });

  it("rejects revoked permissions and smaller data scopes before owner writes", async () => {
    const evidence = await source(),
      first = await start("yummyai.custom_product.generate_provisional_facts", {
        researchSnapshotId: evidence.snapshotId,
      });
    try {
      await grant(permissions.filter((permission) => permission !== Permission.ProductWrite));
      await processor.process(job(await attempt(first.id)));
      expect((await runs.get(context, first.id)).status).toBe("failed");
      expect(await receipts(first.productPlanId)).toHaveLength(0);
    } finally {
      await grant();
    }
    const second = await start("yummyai.custom_product.generate_provisional_facts", {
      researchSnapshotId: evidence.snapshotId,
    });
    try {
      await grant(permissions, "self");
      await processor.process(job(await attempt(second.id)));
      expect((await attempt(second.id)).errorCode).toBe("WORKFLOW_ACCESS_REVOKED");
      expect(await receipts(second.productPlanId)).toHaveLength(0);
    } finally {
      await grant();
    }
  });

  it("ignores forged actors and cross-tenant queue messages without consuming the legitimate intent", async () => {
    const evidence = await source(),
      run = await start("yummyai.custom_product.generate_provisional_facts", {
        researchSnapshotId: evidence.snapshotId,
      }),
      intent = await attempt(run.id);
    await expect(
      processor.process({ ...job(intent), requestedBy: otherUserId }),
    ).resolves.toMatchObject({ state: "skipped" });
    await expect(
      processor.process({ ...job(intent), tenantId: otherTenantId }),
    ).resolves.toMatchObject({ state: "skipped" });
    expect((await attempt(run.id)).status).toBe("queued");
    await processor.process(job(intent));
    expect(await receipts(run.productPlanId)).toHaveLength(1);
  });

  it("retains the activation intent after queue failure and recovers through a real Worker", async () => {
    const evidence = await source(),
      runner = service({
        enqueue: async () => {
          throw new Error("must-not-persist queue secret");
        },
      });
    const run = await start(
      "yummyai.custom_product.generate_provisional_facts",
      { researchSnapshotId: evidence.snapshotId },
      undefined,
      runner,
    );
    expect(await attempt(run.id)).toMatchObject({
      status: "queued",
      errorCode: "QUEUE_UNAVAILABLE",
    });
    const queueName = `${QueueName.WorkflowNode}-${createEntityId()}` as QueueNameValue;
    const queue = createQueue(queueName),
      scheduler = new WorkflowNodeScheduler(database, runtime, queue, [tenantId]),
      messages: JobEnvelope[] = [];
    const worker = createWorker(queueName, (envelope) => {
      messages.push(envelope);
      return processor.process(envelope);
    });
    try {
      await worker.waitUntilReady();
      const dispatched=await scheduler.dispatch();
      expect(dispatched.failed).toBe(0);
      await vi.waitFor(
        async () => expect((await runs.get(context, run.id)).currentNodeId).toBe("review"),
        { timeout: 20_000 },
      );
      const ownMessages=messages.filter(message=>typeof message.payload==="object"&&message.payload!==null&&"runId" in message.payload&&message.payload.runId===run.id);
      expect(ownMessages).toHaveLength(1);
      expect(dispatched.queued).toBeGreaterThanOrEqual(ownMessages.length);
      expect(ownMessages[0]?.payload).toEqual({
        runId: run.id,
        nodeRunId: (await attempt(run.id)).nodeRunId,
        attemptId: (await attempt(run.id)).id,
      });
      expect(JSON.stringify(messages)).not.toMatch(/sourceUrl|parameterSnapshot|profile|prompt/);
    } finally {
      await scheduler.close();
      await worker.close();
    }
  });

  it("reuses an owner receipt after a crash between the business commit and workflow completion", async () => {
    const evidence = await source(),
      run = await start("yummyai.custom_product.generate_provisional_facts", {
        researchSnapshotId: evidence.snapshotId,
      }),
      intent = await attempt(run.id);
    const original = catalog.executePreparedProfile.bind(catalog);
    const failure = vi
      .spyOn(catalog, "executePreparedProfile")
      .mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error("synthetic process loss after owner commit");
      });
    try {
      await expect(processor.process(job(intent))).resolves.toMatchObject({ state: "queued" });
    } finally {
      failure.mockRestore();
    }
    expect(await receipts(run.productPlanId)).toHaveLength(1);
    await withTenant(database.db, context, (tx) =>
      tx
        .update(workflowNodeAttempts)
        .set({ nextAttemptAt: sql`clock_timestamp()-interval '1 second'` })
        .where(eq(workflowNodeAttempts.id, intent.id)),
    );
    await expect(processor.process(job(intent))).resolves.toMatchObject({ state: "completed" });
    expect(await receipts(run.productPlanId)).toHaveLength(1);
  });

  it("fences a cancelled execution before it can persist a business result", async () => {
    const evidence = await source(),
      run = await start("yummyai.custom_product.generate_provisional_facts", {
        researchSnapshotId: evidence.snapshotId,
      }),
      intent = await attempt(run.id);
    const original = catalog.executePreparedProfile.bind(catalog),
      entered = signal(),
      resume = signal();
    const pause = vi
      .spyOn(catalog, "executePreparedProfile")
      .mockImplementationOnce(async (...args) => {
        entered.resolve();
        await resume.promise;
        return original(...args);
      });
    const pending = processor.process(job(intent));
    try {
      await entered.promise;
      const current = await runs.get(context, run.id);
      await runs.command(context, run.id, "execute", {
        type: "cancel",
        expectedRevision: current.revision,
      });
    } finally {
      resume.resolve();
      pause.mockRestore();
    }
    await expect(pending).resolves.toMatchObject({ state: "fenced" });
    expect(await receipts(run.productPlanId)).toHaveLength(0);
  });

  it("stores and serves an inspectable private draft export without turning it into production approval", async () => {
    const evidence = await source(),
      base = await start("yummyai.custom_product.generate_provisional_facts", {
        researchSnapshotId: evidence.snapshotId,
      });
    await processor.process(job(await attempt(base.id)));
    const run = await start(
        "yummyai.custom_product.export_package",
        { mode: "draft" },
        base.productPlanId,
      ),
      intent = await attempt(run.id);
    await expect(processor.process(job(intent))).resolves.toMatchObject({ state: "completed" });
    const exported = (await receipts(run.productPlanId)).find(
      (receipt) => receipt.operation === "package",
    )!;
    const view = await catalog.getOperationReceipt(context, run.productPlanId, exported.id);
    expect(view.result).not.toHaveProperty("objectKey");
    const signed = await catalog.readOperationPackage(context, run.productPlanId, exported.id),
      response = await fetch(signed.url);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(response.status).toBe(200);
    expect(checksumSha256(bytes)).toBe(exported.outputChecksum);
    await expect(inspectCustomProductPackage(bytes)).resolves.toMatchObject({
      manifest: { mode: "draft" },
    });
    expect((await runs.get(context, run.id)).currentNodeId).toBe("review");
    await expect(
      catalog.readOperationPackage(
        { ...context, permissions: [Permission.ProductRead] },
        run.productPlanId,
        exported.id,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      catalog.readOperationPackage(
        { ...context, permissions: [Permission.ProductRead, Permission.AssetRead] },
        run.productPlanId,
        exported.id,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("blocks release export when facts and authorized product assets are incomplete", async () => {
    const evidence = await source(),
      base = await start("yummyai.custom_product.generate_provisional_facts", {
        researchSnapshotId: evidence.snapshotId,
      });
    await processor.process(job(await attempt(base.id)));
    const run = await start(
      "yummyai.custom_product.export_package",
      { mode: "release" },
      base.productPlanId,
    );
    await expect(processor.process(job(await attempt(run.id)))).resolves.toMatchObject({
      state: "failed",
    });
    expect(
      (await receipts(run.productPlanId)).filter((receipt) => receipt.operation === "package"),
    ).toHaveLength(0);
  });

  it("requires an execution receipt and immutable attempt input instead of allowing manual internal completion", async () => {
    const evidence = await source(),
      run = await start("yummyai.custom_product.generate_provisional_facts", {
        researchSnapshotId: evidence.snapshotId,
      }),
      intent = await attempt(run.id);
    await expect(
      runs.command(context, run.id, "execute", {
        type: "complete",
        expectedRevision: run.revision,
        parameters: {},
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      withTenant(database.db, context, (tx) =>
        tx
          .update(workflowNodeAttempts)
          .set({ inputChecksum: "a".repeat(64) })
          .where(eq(workflowNodeAttempts.id, intent.id)),
      ),
    ).rejects.toThrow();
    await processor.process(job(intent));
  });

  it.each(["missing", "wrong_method", "unsupported_tool"] as const)("stops a historical %s execution contract without calling its business owner", async kind => {
    const evidence = await source(), run = await start("yummyai.custom_product.generate_provisional_facts", { researchSnapshotId: evidence.snapshotId });
    const legacy = await historicalContract(run.id, input => {
      if (kind === "missing") delete input.executionContract;
      else if (kind === "wrong_method") input.executionContract!.skill.key = "workflow.pod.pattern_crop";
      else input.executionContract!.tools[0]!.version = "unsupported-v99";
    });
    const before = JSON.stringify(legacy.inputSnapshot);
    await processor.process(job(legacy));
    const final = await attempt(run.id);
    expect(final).toMatchObject({ status: "failed", errorCode: kind === "missing" ? "WORKFLOW_CONTRACT_MISSING" : "WORKFLOW_CONTRACT_CHANGED" });
    expect(JSON.stringify(final.inputSnapshot)).toBe(before);
    expect(await receipts(run.productPlanId)).toHaveLength(0);
    expect((await operator.inspect(context, run.id, "execute")).attempts[0]?.message).toMatch(/工具|执行方法/);
  });

  it("retains an actual owner receipt and stops advancement when its returned artifact violates the tool contract", async () => {
    const evidence = await source(), run = await start("yummyai.custom_product.generate_provisional_facts", { researchSnapshotId: evidence.snapshotId }), intent = await attempt(run.id);
    const original = catalog.executePreparedProfile.bind(catalog);
    const fault = vi.spyOn(catalog, "executePreparedProfile").mockImplementationOnce(async (...args) => ({ ...await original(...args), receiptId: "invalid-receipt-id" }));
    try {
      await processor.process(job(intent));
      expect((await attempt(run.id)).errorCode).toBe("WORKFLOW_OUTPUT_INVALID");
      expect(await receipts(run.productPlanId)).toHaveLength(1);
      expect((await runs.get(context, run.id)).status).toBe("failed");
      await processor.process(job(intent));
      expect(fault).toHaveBeenCalledTimes(1);
      expect(await receipts(run.productPlanId)).toHaveLength(1);
    } finally { fault.mockRestore(); }
  });

  it("accepts only one concurrent claim and keeps a single owner receipt", async () => {
    const evidence = await source(),
      run = await start("yummyai.custom_product.generate_provisional_facts", {
        researchSnapshotId: evidence.snapshotId,
      }),
      intent = await attempt(run.id);
    const outcomes = await Promise.all([
      processor.process(job(intent)),
      processor.process(job(intent)),
    ]);
    expect(outcomes.filter((result) => result.state === "completed")).toHaveLength(1);
    expect(outcomes.filter((result) => result.state === "skipped")).toHaveLength(1);
    expect(await receipts(run.productPlanId)).toHaveLength(1);
  });

  it("fences an expired lease when a replacement worker completes the same owner operation", async () => {
    const evidence = await source(),
      run = await start("yummyai.custom_product.generate_provisional_facts", {
        researchSnapshotId: evidence.snapshotId,
      }),
      intent = await attempt(run.id);
    const original = catalog.executePreparedProfile.bind(catalog),
      entered = signal(),
      resume = signal();
    const pause = vi
      .spyOn(catalog, "executePreparedProfile")
      .mockImplementationOnce(async (...args) => {
        entered.resolve();
        await resume.promise;
        return original(...args);
      });
    const pending = processor.process(job(intent));
    try {
      await entered.promise;
      await withTenant(database.db, context, (tx) =>
        tx
          .update(workflowNodeAttempts)
          .set({ leaseExpiresAt: sql`clock_timestamp()-interval '1 second'` })
          .where(eq(workflowNodeAttempts.id, intent.id)),
      );
      await expect(processor.process(job(intent))).resolves.toMatchObject({ state: "completed" });
    } finally {
      resume.resolve();
      pause.mockRestore();
    }
    await expect(pending).resolves.toMatchObject({ state: "fenced" });
    expect((await attempt(run.id)).recoveryCount).toBe(1);
    expect(await receipts(run.productPlanId)).toHaveLength(1);
  });

  it("resumes a blocked node with its original input instead of taking a new capture", async () => {
    const evidence = await source(),
      run = await start("yummyai.custom_product.generate_provisional_facts", {
        researchSnapshotId: evidence.snapshotId,
      }),
      intent = await attempt(run.id);
    const blocked = await runs.command(context, run.id, "execute", {
      type: "block",
      reason: "Synthetic pause",
      expectedRevision: run.revision,
    });
    await source("LATER", evidence.sourceUrl);
    await expect(processor.process(job(intent))).resolves.toMatchObject({ state: "skipped" });
    await runs.command(context, run.id, "execute", {
      type: "unblock",
      expectedRevision: blocked.revision,
    });
    expect((await attempt(run.id)).inputChecksum).toBe(intent.inputChecksum);
    await processor.process(job(intent));
    expect((await receipts(run.productPlanId))[0]?.result.profile).toMatchObject({
      sku: { value: "DRAFT-ORIGINAL" },
    });
  });

  it("creates a new fixed attempt when an operator explicitly repairs missing inputs", async () => {
    const run = await start("yummyai.custom_product.generate_provisional_facts", {}),
      failed = await attempt(run.id),
      evidence = await source();
    expect(run.status).toBe("failed");
    expect(failed.inputSnapshot).toBeNull();
    const repaired = await runs.command(context, run.id, "execute", {
      type: "retry",
      expectedRevision: run.revision,
      parameters: { researchSnapshotId: evidence.snapshotId },
    });
    const current = await attempt(run.id);
    expect(current.id).not.toBe(failed.id);
    expect(current.inputSnapshot).not.toBeNull();
    await expect(processor.process(job(failed))).resolves.toMatchObject({ state: "skipped" });
    await expect(processor.process(job(current))).resolves.toMatchObject({ state: "completed" });
    expect((await runs.get(context, repaired.id)).currentNodeId).toBe("review");
  });

  it("hides runs from a different self-scoped operator", async () => {
    const evidence = await source(),
      run = await start("yummyai.custom_product.generate_provisional_facts", {
        researchSnapshotId: evidence.snapshotId,
      });
    const other = { ...context, userId: otherUserId, dataScope: "self" as const };
    await expect(runs.get(other, run.id)).rejects.toMatchObject({ status: 404 });
    expect((await runs.list(other)).items).toHaveLength(0);
    await expect(
      runs.command(other, run.id, "execute", {
        type: "update_note",
        note: "forbidden",
        expectedRevision: run.revision,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await processor.process(job(await attempt(run.id)));
  });

  it("bounds expired execution recovery without invoking the owner again", async () => {
    const evidence = await source(),
      run = await start("yummyai.custom_product.generate_provisional_facts", {
        researchSnapshotId: evidence.snapshotId,
      }),
      intent = await attempt(run.id);
    await withTenant(database.db, context, (tx) =>
      tx
        .update(workflowNodeAttempts)
        .set({
          status: "running",
          leaseToken: createEntityId(),
          leaseExpiresAt: sql`clock_timestamp()-interval '1 second'`,
          recoveryCount: 3,
        })
        .where(eq(workflowNodeAttempts.id, intent.id)),
    );
    await processor.process(job(intent));
    expect((await attempt(run.id)).errorCode).toBe("WORKFLOW_RECOVERY_EXHAUSTED");
    expect(await receipts(run.productPlanId)).toHaveLength(0);
  });

  it("settles a legacy running attempt without inventing an actor or backfilling current inputs", async () => {
    const evidence = await source(),
      run = await start("yummyai.custom_product.generate_provisional_facts", {
        researchSnapshotId: evidence.snapshotId,
      }),
      initial = await attempt(run.id);
    const legacyId = createEntityId();
    await withTenant(database.db, context, async (tx) => {
      await tx
        .update(workflowNodeAttempts)
        .set({ status: "cancelled", finishedAt: sql`clock_timestamp()` })
        .where(eq(workflowNodeAttempts.id, initial.id));
      await tx.insert(workflowNodeAttempts).values({
        id: legacyId,
        tenantId,
        nodeRunId: initial.nodeRunId,
        attemptNumber: 2,
        status: "running",
      });
      await tx
        .update(workflowNodeRuns)
        .set({ attemptCount: 2 })
        .where(eq(workflowNodeRuns.id, initial.nodeRunId));
    });
    const queue = createQueue(`${QueueName.WorkflowNode}-${createEntityId()}` as QueueNameValue);
    const scheduler = new WorkflowNodeScheduler(database, runtime, queue, [tenantId]);
    try {
      expect((await scheduler.dispatch()).legacy).toBe(1);
    } finally {
      await scheduler.close();
    }
    const settled = await attempt(run.id),
      final = await runs.get(context, run.id);
    expect(settled).toMatchObject({
      id: legacyId,
      status: "failed",
      errorCode: "WORKFLOW_LEGACY_INPUT_MISSING",
      requestedBy: null,
      inputSnapshot: null,
    });
    expect(final.status).toBe("failed");
    const events = await withTenant(database.db, context, (tx) =>
      tx
        .select({ actorUserId: workflowRunEvents.actorUserId })
        .from(workflowRunEvents)
        .where(and(eq(workflowRunEvents.runId, run.id), eq(workflowRunEvents.type, "node_failed"))),
    );
    expect(events).toEqual([{ actorUserId: null }]);
    expect(await receipts(run.productPlanId)).toHaveLength(0);
  });

  async function podFixture() {
    // This fixture represents an existing developing SKU, without manufacturing
    // a product-plan approval or changing the ProductService approval gate.
    const product = await plan(),
      spuId = createEntityId();
    await withTenant(database.db, context, (tx) =>
      tx.insert(spus).values({
        id: spuId,
        tenantId,
        productPlanId: product.id,
        code: `S-${spuId}`,
        name: "Synthetic POD product",
        status: "developing",
        customization: { version: 1, fields: [] },
      }),
    );
    const sku = await products.createSku(context, {
      spuId,
      code: `K-${createEntityId()}`,
      attributes: {},
    });
    const assetId = createEntityId(),
      fileName = `${assetId}.png`;
    const stored = await storage.putPrivate(context, {
      body: image,
      domain: "authorized",
      fileName,
      mediaType: "image/png",
    });
    await withTenant(database.db, context, (tx) =>
      tx.insert(assetFiles).values({
        id: assetId,
        tenantId,
        ownerUserId: userId,
        objectKey: stored.objectKey,
        assetDomain: "authorized",
        fileName,
        mediaType: "image/png",
        byteSize: image.length,
        checksumSha256: stored.checksumSha256,
        rightsStatus: "approved",
        rightsMetadata: { source: { kind: "owned", reference: "synthetic fixture" } },
      }),
    );
    const run = await start(
        "pod.pattern_crop",
        {
          skuId: sku.id,
          inputAssetIds: [assetId],
          parameterSnapshot: {
            mode: "general",
            multiCrop: false,
            maximumCropsPerInput: 1,
            outputFormat: "png",
            background: "preserved",
            perspectiveCorrection: true,
            cropPaddingPercent: 2,
          },
        },
        product.id,
      ),
      intent = await attempt(run.id);
    return { run, intent, assetId };
  }

  it("delegates POD once, waits for the actual POD processor result and preserves the review boundary", async () => {
    const { run, intent } = await podFixture();
    await expect(processor.process(job(intent))).resolves.toMatchObject({ state: "waiting" });
    const childId = String((await attempt(run.id)).outputSnapshot?.delegatedTaskId);
    expect((await pod.get(context, childId)).status).toBe("queued");
    const gateway = {
      execute: vi.fn(async (): Promise<PodArtworkExecutionResult> => ({
        outputs: [
          {
            bytes: image,
            mediaType: "image/png",
            role: "effect",
            fileName: "crop.png",
            metadata: {
              width: 40,
              height: 30,
              unit: "px",
              colorMode: "rgb",
              transparent: false,
              aiInference: "none",
            },
          },
        ],
        modelKey: "pod.pattern-crop.v1",
        modelVersion: "fixture-v1",
        costUsd:0.023,
        qualityCheckSnapshot: {
          passed: true,
          mode: "general",
          inputCoverageComplete: true,
          cropBoundsValid: true,
          blankOutputsDetected: false,
          duplicateOutputsDetected: false,
          outputChecks: [
            {
              fileName: "crop.png",
              inputOrdinal: 0,
              cropIndex: 0,
              sourceBounds: { x: 0, y: 0, width: 1, height: 1 },
              outputWidth: 40,
              outputHeight: 30,
              transparent: false,
              perspectiveCorrectionValidated: true,
              cropComplete: true,
              resultLabel: "synthetic",
            },
          ],
        },
        partial: false,
      })),
    };
    await new PodArtworkProcessor(
      new DrizzlePodArtworkExecutionRepository(database, storage),
      gateway,
    ).process({ ...job(intent), payload: { taskId: childId } });
    await withTenant(database.db, context, (tx) =>
      tx
        .update(workflowNodeAttempts)
        .set({ nextAttemptAt: sql`clock_timestamp()-interval '1 second'` })
        .where(eq(workflowNodeAttempts.id, intent.id)),
    );
    await expect(processor.process(job(intent))).resolves.toMatchObject({ state: "completed" });
    const final = await runs.get(context, run.id);
    expect(final.currentNodeId).toBe("review");
    expect(final.artifacts[0]?.artifactType).toBe("design_version");
    expect(gateway.execute).toHaveBeenCalledTimes(1);
    expect((await pod.get(context, childId)).status).toBe("awaiting_review");
    expect((await pod.get(context,childId)).invocations?.[0]).toMatchObject({state:"completed",boundary:"received",artifact:{kind:"design_version"},billing:{basis:"processor_reported",amountUsd:"0.02300000",needsProviderEvidence:true}});
  });

  it("retains only the original claimed receipt when permission changes in flight",async()=>{
    const {run,intent}=await podFixture();await processor.process(job(intent));
    const childId=String((await attempt(run.id)).outputSnapshot?.delegatedTaskId),repository=new DrizzlePodArtworkExecutionRepository(database,storage);
    const claim=await repository.claim(context,childId,0);expect(claim?.token).toBeTruthy();await repository.markSubmitted(context,childId,0,claim);
    await grant(permissions.filter(p=>p!==Permission.DesignWrite));
    try {
      await repository.recordResponse(context,childId,0,{version:"pod-response-v1",responseChecksum:"b".repeat(64),providerRequestId:"synthetic-inflight",modelKey:"synthetic-crop",modelVersion:"v1",costUsd:"0.01300000",metadataValid:true,receivedAt:new Date().toISOString()},undefined,claim);
      await expect(repository.load(context,childId)).rejects.toThrow(/permission/);
      await expect(repository.recordResponse({...context,userId:otherUserId},childId,0,{version:"pod-response-v1",responseChecksum:"c".repeat(64),providerRequestId:null,modelKey:null,modelVersion:null,costUsd:null,metadataValid:false,receivedAt:new Date().toISOString()})).rejects.toThrow(/POD_(INVOCATION|EXECUTION)_CLAIM_LOST/);
      await repository.fail(context,childId,{attempt:0,terminal:true,code:"POD_RESULT_UNCERTAIN",message:"Synthetic receipt reconciliation"},claim);
      expect((await pod.get(context,childId)).invocations?.[0]).toMatchObject({state:"uncertain",responseChecksum:"b".repeat(64),billing:{amountUsd:"0.01300000"}});
    } finally {await grant();}
  });

  it("keeps a processor fee before artwork rejection, exposes owner-linked evidence and never resubmits",async()=>{
    const {run,intent}=await podFixture();await processor.process(job(intent));
    const childId=String((await attempt(run.id)).outputSnapshot?.delegatedTaskId);
    const request=vi.fn(async()=>new Response(JSON.stringify({modelKey:"synthetic-paid-crop",modelVersion:"v1",costUsd:0.027,outputs:[]}),{headers:{"x-request-id":"synthetic-original-paid-request"}}));
    const gateway=new HttpPodArtworkGateway("https://fixture.invalid/process","synthetic-only",request);
    const childProcessor=new PodArtworkProcessor(new DrizzlePodArtworkExecutionRepository(database,storage),gateway);
    const delivery={...job(intent),payload:{taskId:childId}};
    await expect(childProcessor.process(delivery)).rejects.toThrow("POD_RESPONSE_INVALID");
    const view=await pod.get(context,childId);
    expect(view).toMatchObject({status:"failed",resultVersionId:undefined,invocations:[{state:"failed",boundary:"received",providerRequestId:"synthetic-original-paid-request",billing:{basis:"processor_reported",amountUsd:"0.02700000",needsProviderEvidence:true}}]});
    const inspected=await operator.inspect(context,run.id,"execute");
    expect(inspected.attempts[0]?.invocations).toEqual(expect.arrayContaining([expect.objectContaining({owner:"workflow",boundary:"delegated_task",billing:expect.objectContaining({basis:"not_applicable",amountUsd:null})}),expect.objectContaining({owner:"pod",parentId:intent.id,billing:expect.objectContaining({amountUsd:"0.02700000"})})]));
    const restricted=await operator.inspect({...context,permissions:permissions.filter(p=>p!==Permission.DesignRead)},run.id,"execute");
    expect(restricted.attempts[0]?.invocations).toHaveLength(1);expect(JSON.stringify(restricted)).not.toContain("synthetic-original-paid-request");
    expect(await withTenant(database.db,{...context,tenantId:otherTenantId,userId:otherUserId},tx=>tx.select().from(podArtworkInvocations).where(eq(podArtworkInvocations.taskId,childId)))).toEqual([]);
    await expect(withTenant(database.db,context,tx=>tx.insert(podArtworkInvocations).values({id:createEntityId(),tenantId,taskId:childId,attemptNumber:2,phase:"received",submittedAt:new Date(),receivedAt:new Date(),metadataValid:true,responseChecksum:null}))).rejects.toMatchObject({cause:{code:"23514"}});
    await expect(withTenant(database.db,{...context,tenantId:otherTenantId,userId:otherUserId},tx=>tx.insert(podArtworkInvocations).values({id:createEntityId(),tenantId:otherTenantId,taskId:childId,attemptNumber:2,phase:"pending"}))).rejects.toMatchObject({cause:{code:"23503"}});
    await expect(withTenant(database.db,context,tx=>tx.update(podArtworkInvocations).set({reportedCostUsd:"0.00000000"}).where(eq(podArtworkInvocations.taskId,childId)))).rejects.toMatchObject({cause:{code:"55000"}});
    expect((await pod.get(context,childId)).invocations?.[0]?.billing.amountUsd).toBe("0.02700000");
    await expect(childProcessor.process(delivery)).resolves.toMatchObject({disposition:"already_claimed"});expect(request).toHaveBeenCalledOnce();
  });

  it("keeps a paused POD task queued and redelivers the same task after resume", async () => {
    const { run, intent } = await podFixture();
    await processor.process(job(intent));
    const childId = String((await attempt(run.id)).outputSnapshot?.delegatedTaskId);
    const current = await runs.get(context, run.id);
    const blocked = await runs.command(context, run.id, "execute", {
      type: "block",
      reason: "Synthetic pause",
      expectedRevision: current.revision,
    });
    const gateway = {
      execute: vi.fn(async () => {
        throw new Error("synthetic resumed request timeout");
      }),
    };
    const childProcessor = new PodArtworkProcessor(
      new DrizzlePodArtworkExecutionRepository(database, storage),
      gateway,
    );
    await expect(
      childProcessor.process({ ...job(intent), payload: { taskId: childId } }),
    ).resolves.toMatchObject({ disposition: "deferred" });
    expect(gateway.execute).not.toHaveBeenCalled();
    expect((await pod.get(context, childId)).status).toBe("queued");
    await runs.command(context, run.id, "execute", {
      type: "unblock",
      expectedRevision: blocked.revision,
    });
    await withTenant(database.db, context, (tx) =>
      tx
        .update(workflowNodeAttempts)
        .set({ nextAttemptAt: sql`clock_timestamp()-interval '1 second'` })
        .where(eq(workflowNodeAttempts.id, intent.id)),
    );
    await expect(processor.process(job(intent))).resolves.toMatchObject({ state: "waiting" });
    expect((await attempt(run.id)).outputSnapshot?.delegatedTaskId).toBe(childId);
    const queue = createQueue(QueueName.PodArtwork);
    try {
      const deliveries = (await queue.getJobs(["wait"], 0, 1000)).filter(
        (queued) => queued.data.payload.taskId === childId,
      );
      expect(deliveries).toHaveLength(2);
      expect(new Set(deliveries.map((queued) => queued.id)).size).toBe(2);
      expect(deliveries.every((queued) => queued.data.correlationId === childId)).toBe(true);
    } finally {
      await queue.close();
    }
    await expect(
      childProcessor.process({ ...job(intent), payload: { taskId: childId } }),
    ).rejects.toThrow("POD_RESULT_UNCERTAIN");
    await expect(
      childProcessor.process({ ...job(intent), payload: { taskId: childId } }),
    ).resolves.toMatchObject({ disposition: "already_claimed" });
    expect(gateway.execute).toHaveBeenCalledTimes(1);
    await withTenant(database.db, context, (tx) =>
      tx
        .update(workflowNodeAttempts)
        .set({ nextAttemptAt: sql`clock_timestamp()-interval '1 second'` })
        .where(eq(workflowNodeAttempts.id, intent.id)),
    );
    await processor.process(job(intent));
  });

  it("stops an existing queued POD child when its historical parent lacks the tool contract", async () => {
    const { run, intent } = await podFixture();
    await processor.process(job(intent));
    const childId = String((await attempt(run.id)).outputSnapshot?.delegatedTaskId);
    const legacy = await historicalContract(run.id, input => { delete input.executionContract; });
    await processor.process(job(legacy));
    expect((await attempt(run.id)).errorCode).toBe("WORKFLOW_CONTRACT_MISSING");
    const gateway = { execute: vi.fn() }, podProcessor = new PodArtworkProcessor(new DrizzlePodArtworkExecutionRepository(database, storage), gateway);
    const before = await pod.get(context, childId);
    expect(before.status).toBe("queued");
    const childEvidence = () => withTenant(database.db, context, async tx => ({
      executions: await tx.select().from(podArtworkExecutions).where(eq(podArtworkExecutions.taskId, childId)),
      invocations: await tx.select().from(podArtworkInvocations).where(eq(podArtworkInvocations.taskId, childId)),
    }));
    const originalEvidence = await childEvidence();
    expect(originalEvidence.executions).toHaveLength(1);
    expect(originalEvidence.executions[0]!.attemptCount).toBe(0);
    expect(originalEvidence.invocations).toEqual([]);
    // Let the original database-owned schedule become due. Calling before it
    // is due legitimately performs no claim and must not masquerade as a test
    // of the historical-parent admission check. Never rewrite its timestamp.
    await vi.waitFor(async () => {
      const [execution] = await withTenant(database.db, context, tx => tx.select({ due: sql<boolean>`${podArtworkExecutions.nextAttemptAt}<=clock_timestamp()` })
        .from(podArtworkExecutions).where(eq(podArtworkExecutions.taskId, childId)));
      expect(execution?.due).toBe(true);
    }, { timeout: 10_000, interval: 25 });
    await expect(podProcessor.process({ ...job(intent), payload: { taskId: childId } })).rejects.toThrow("originating workflow");
    const blocked = await pod.get(context, childId); expect(blocked.status).toBe("blocked");
    const blockedEvidence = await childEvidence();
    expect(blockedEvidence.executions[0]!.phase).toBe("failed");
    expect(blockedEvidence.executions[0]!.attemptCount).toBe(0);
    expect(blockedEvidence.invocations).toEqual([]);
    // Once blocked, redelivery must not create a new claim or reach a paid gateway.
    for (let delivery = 0; delivery < 2; delivery++) {
      await expect(podProcessor.process({ ...job(intent), payload: { taskId: childId } })).resolves.toEqual({ taskId: childId, disposition: "already_claimed" });
    }
    expect(gateway.execute).not.toHaveBeenCalled();
    expect(await pod.get(context, childId)).toEqual(blocked);
    expect(await childEvidence()).toEqual(blockedEvidence);
    expect((await attempt(run.id)).errorCode).toBe("WORKFLOW_CONTRACT_MISSING");
  });

  it("does not invoke a queued POD gateway after its workflow is cancelled", async () => {
    const { run, intent } = await podFixture();
    await processor.process(job(intent));
    const childId = String((await attempt(run.id)).outputSnapshot?.delegatedTaskId),
      current = await runs.get(context, run.id);
    await runs.command(context, run.id, "execute", {
      type: "cancel",
      expectedRevision: current.revision,
    });
    const gateway = { execute: vi.fn() },
      podProcessor = new PodArtworkProcessor(
        new DrizzlePodArtworkExecutionRepository(database, storage),
        gateway,
      );
    const [originalExecution] = await withTenant(database.db, context, tx => tx.select({
      phase: podArtworkExecutions.phase, attemptCount: podArtworkExecutions.attemptCount, leaseToken: podArtworkExecutions.leaseToken,
    }).from(podArtworkExecutions).where(eq(podArtworkExecutions.taskId, childId)));
    expect(originalExecution).toMatchObject({ phase: "pending", attemptCount: 0, leaseToken: null });
    // A queue may redeliver before the database retry time. Prove both sides
    // of that admission boundary without changing the cancellation gate.
    await withTenant(database.db, context, tx => tx.update(podArtworkExecutions)
      .set({ nextAttemptAt: sql`clock_timestamp() + interval '1 minute'` }).where(eq(podArtworkExecutions.taskId, childId)));
    await expect(podProcessor.process({ ...job(intent), payload: { taskId: childId } }))
      .resolves.toMatchObject({ taskId: childId, disposition: "already_claimed" });
    expect(gateway.execute).not.toHaveBeenCalled();
    await withTenant(database.db, context, tx => tx.update(podArtworkExecutions)
      .set({ nextAttemptAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(podArtworkExecutions.taskId, childId)));
    await expect(
      podProcessor.process({ ...job(intent), payload: { taskId: childId } }),
    ).rejects.toThrow("originating workflow");
    expect(gateway.execute).not.toHaveBeenCalled();
    expect((await pod.get(context, childId)).status).toBe("blocked");
  });

  it("rechecks design permission before a queued POD task can call its gateway", async () => {
    const { run, intent } = await podFixture();
    await processor.process(job(intent));
    const childId = String((await attempt(run.id)).outputSnapshot?.delegatedTaskId),
      gateway = { execute: vi.fn() };
    const podProcessor = new PodArtworkProcessor(
      new DrizzlePodArtworkExecutionRepository(database, storage),
      gateway,
    );
    try {
      await grant(permissions.filter((permission) => permission !== Permission.DesignWrite));
      await expect(
        podProcessor.process({ ...job(intent), payload: { taskId: childId } }),
      ).rejects.toThrow("permission");
      expect(gateway.execute).not.toHaveBeenCalled();
    } finally {
      await grant();
    }
    expect((await pod.get(context, childId)).status).toBe("blocked");
  });

  it("does not repeat a possibly charged POD request when BullMQ redelivers it", async () => {
    const { run, intent } = await podFixture();
    await processor.process(job(intent));
    const childId = String((await attempt(run.id)).outputSnapshot?.delegatedTaskId),
      gateway = {
        execute: vi.fn(async () => {
          throw new Error("synthetic timeout after external submission");
        }),
      };
    const podProcessor = new PodArtworkProcessor(
      new DrizzlePodArtworkExecutionRepository(database, storage),
      gateway,
    );
    await expect(
      podProcessor.process({ ...job(intent), payload: { taskId: childId } }),
    ).rejects.toThrow("POD_RESULT_UNCERTAIN");
    await expect(
      podProcessor.process({ ...job(intent), attempt: 1, payload: { taskId: childId } }),
    ).resolves.toMatchObject({ disposition: "already_claimed" });
    expect(gateway.execute).toHaveBeenCalledTimes(1);
    expect((await pod.get(context, childId)).errorCode).toBe("POD_RESULT_UNCERTAIN");
    try {
      await grant(permissions.filter((permission) => permission !== Permission.DesignWrite));
      await expect(
        podProcessor.process({ ...job(intent), attempt: 2, payload: { taskId: childId } }),
      ).resolves.toMatchObject({disposition:"already_claimed"});
    } finally {
      await grant();
    }
    expect((await pod.get(context, childId)).errorCode).toBe("POD_RESULT_UNCERTAIN");
    await withTenant(database.db, context, (tx) =>
      tx
        .update(workflowNodeAttempts)
        .set({ nextAttemptAt: sql`clock_timestamp()-interval '1 second'` })
        .where(eq(workflowNodeAttempts.id, intent.id)),
    );
    await expect(processor.process(job(intent))).resolves.toMatchObject({ state: "failed" });
  });
  it("returns a safe operator projection and gates read-only commands without exposing legacy diagnostics", async () => {
    const run = await start("yummyai.custom_product.generate_provisional_facts", {});
    const intent = await attempt(run.id);
    await withTenant(database.db, context, (tx) =>
      tx
        .update(workflowNodeAttempts)
        .set({
          errorCode: "PRIVATE_LEGACY_DIAGNOSTIC",
          errorMessage: "secret-prompt-and-private-path",
        })
        .where(eq(workflowNodeAttempts.id, intent.id)),
    );
    const view = await operator.inspect(context, run.id, "execute");
    expect(view.access).toMatchObject({ canCommand: true, canRepair: true, canRetry: false });
    expect(view.attempts[0]).toMatchObject({
      inputAvailable: false,
      errorCode: "WORKFLOW_EXECUTION_FAILED",
    });
    expect(JSON.stringify(view)).not.toMatch(
      /PRIVATE_LEGACY|secret-prompt|inputSnapshot|objectKey/,
    );
    const readOnly = { ...context, permissions: [Permission.WorkflowRead, Permission.ProductRead] };
    expect((await operator.inspect(readOnly, run.id, "execute")).access).toEqual({
      canCommand: false,
      canApprove: false,
      canRepair: false,
      canRetry: false,
    });
    await expect(operator.repairOptions(readOnly, run.id, "execute")).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      runs.get({ ...context, permissions: [Permission.WorkflowRead] }, run.id),
    ).rejects.toThrow();
    await expect(
      runs.command(readOnly, run.id, "execute", { type: "retry", expectedRevision: run.revision }),
    ).rejects.toThrow();
  });

  it("searches actual authorized repair sources and rejects arbitrary retry fields atomically", async () => {
    const run = await start("yummyai.custom_product.generate_provisional_facts", {}),
      evidence = await source("OPERATOR-SOURCE");
    const self = { ...context, dataScope: "self" as const };
    await expect(runs.command(context, run.id, "execute", { type: "retry", expectedRevision: run.revision, parameters: { researchSnapshotId: evidence.snapshotId, targetMarketplace: "a".repeat(121) } })).rejects.toMatchObject({ status: 400 });
    expect(await operator.repairOptions(self, run.id, "execute", "Custom Mug")).toMatchObject({
      kind: "profile",
      sources: expect.arrayContaining([
        expect.objectContaining({ snapshotId: evidence.snapshotId }),
      ]),
    });
    await expect(
      runs.command(context, run.id, "execute", {
        type: "retry",
        expectedRevision: run.revision,
        parameters: { researchSnapshotId: evidence.snapshotId, toolKey: "forged-tool" },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await runs.get(context, run.id)).revision).toBe(run.revision);
    expect((await attempt(run.id)).attemptNumber).toBe(1);
    await withTenant(database.db, context, (tx) =>
      tx
        .update(researchItems)
        .set({ ownerUserId: otherUserId })
        .where(eq(researchItems.id, evidence.researchItemId)),
    );
    const hidden = await operator.repairOptions(self, run.id, "execute", "Custom Mug");
    expect(
      hidden.kind === "profile" &&
        hidden.sources.some((source) => source.snapshotId === evidence.snapshotId),
    ).toBe(false);
    await expect(
      operator.inspect({ ...context, dataScope: "self", userId: otherUserId }, run.id, "execute"),
    ).rejects.toThrow();
    await expect(
      operator.inspect(
        { ...context, tenantId: otherTenantId, userId: otherUserId },
        run.id,
        "execute",
      ),
    ).rejects.toThrow();
  });

  it.each([300_000, -300_000])("uses the database scheduling clock when the API wall clock differs by %i ms", async offset => {
    const evidence = await source();
    let runId: string;
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + offset);
    try {
      const run = await start("yummyai.custom_product.generate_provisional_facts", { researchSnapshotId: evidence.snapshotId }, undefined, runs, false);
      runId = run.id;
      const paused = await runs.command(context, run.id, "execute", { type: "block", reason: "Synthetic scheduling check", expectedRevision: run.revision });
      await runs.command(context, run.id, "execute", { type: "unblock", expectedRevision: paused.revision });
      const intent = await attempt(run.id);
      const [clock] = await withTenant(database.db, context, tx => tx.execute<{ queued_delta: string; run_delta: string }>(sql`
        select extract(epoch from (${intent.nextAttemptAt.toISOString()}::timestamptz-clock_timestamp()))::text as queued_delta,
          extract(epoch from (started_at-clock_timestamp()))::text as run_delta from workflow_runs where id=${run.id}::uuid`));
      expect(Math.abs(Number(clock!.queued_delta))).toBeLessThan(5);
      expect(Math.abs(Number(clock!.run_delta))).toBeLessThan(5);
    } finally { vi.useRealTimers(); }
    const intent = await attempt(runId!);
    await withTenant(database.db, context, tx => tx.update(workflowNodeAttempts)
      .set({ nextAttemptAt: sql`clock_timestamp()-interval '1 second'` }).where(eq(workflowNodeAttempts.id, intent.id)));
    await expect(processor.process(job(await attempt(runId!)))).resolves.toMatchObject({ state: "completed" });
    expect(await receipts((await runs.get(context, runId!)).productPlanId)).toHaveLength(1);
  });

  it("reads an owned profile receipt without substituting later product edits or another run's artifacts", async () => {
    const evidence = await source("PINNED-OPERATOR"),
      run = await start("yummyai.custom_product.generate_provisional_facts", {
        researchSnapshotId: evidence.snapshotId,
      });
    await processor.process(job(await attempt(run.id)));
    const current = await runs.get(context, run.id),
      link = current.artifacts[0]!;
    expect(await operator.artifact(context, run.id, link.id)).toMatchObject({
      kind: "profile",
      profile: { sku: { value: "DRAFT-PINNED-OPERATOR" } },
    });
    const other = await start("yummyai.custom_product.generate_provisional_facts", {});
    await expect(operator.artifact(context, other.id, link.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      operator.artifact(
        {
          ...context,
          permissions: permissions.filter((permission) => permission !== Permission.ResearchRead),
        },
        run.id,
        link.id,
      ),
    ).rejects.toThrow();
    await withTenant(database.db, context, (tx) =>
      tx
        .update(researchItems)
        .set({ ownerUserId: otherUserId })
        .where(eq(researchItems.id, evidence.researchItemId)),
    );
    await expect(
      operator.artifact({ ...context, dataScope: "self" }, run.id, link.id),
    ).rejects.toThrow();
  });

  it("downloads actual owned ZIP bytes and rechecks access when the storage read completes", async () => {
    const evidence = await source(),
      base = await start("yummyai.custom_product.generate_provisional_facts", {
        researchSnapshotId: evidence.snapshotId,
      });
    await processor.process(job(await attempt(base.id)));
    const run = await start(
      "yummyai.custom_product.export_package",
      { mode: "draft" },
      base.productPlanId,
    );
    await processor.process(job(await attempt(run.id)));
    const current = await runs.get(context, run.id),
      link = current.artifacts[0]!;
    expect(await operator.artifact(context, run.id, link.id)).toMatchObject({
      kind: "package",
      mode: "draft",
      canDownload: true,
    });
    const result = await operator.download(context, run.id, link.id);
    await expect(inspectCustomProductPackage(result.bytes)).resolves.toMatchObject({
      manifest: { mode: "draft" },
    });
    expect(checksumSha256(result.bytes)).toBe(result.sha256);
    await expect(
      operator.download(
        {
          ...context,
          permissions: permissions.filter((permission) => permission !== Permission.AssetRead),
        },
        run.id,
        link.id,
      ),
    ).rejects.toThrow();
    const read = storage.readPrivate.bind(storage);
    const spy = vi.spyOn(storage, "readPrivate").mockImplementationOnce(async (...args) => {
      const bytes = await read(...args);
      await withTenant(database.db, context, (tx) =>
        tx
          .update(productPlans)
          .set({ status: "archived" })
          .where(eq(productPlans.id, run.productPlanId)),
      );
      return bytes;
    });
    try {
      await expect(operator.download(context, run.id, link.id)).rejects.toMatchObject({
        status: 409,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses a corrupted package rather than streaming bytes with a valid-looking manifest checksum", async () => {
    const evidence = await source(),
      base = await start("yummyai.custom_product.generate_provisional_facts", {
        researchSnapshotId: evidence.snapshotId,
      });
    await processor.process(job(await attempt(base.id)));
    const run = await start(
      "yummyai.custom_product.export_package",
      { mode: "draft" },
      base.productPlanId,
    );
    await processor.process(job(await attempt(run.id)));
    const link = (await runs.get(context, run.id)).artifacts[0]!;
    const spy = vi
      .spyOn(storage, "readPrivate")
      .mockResolvedValueOnce(Buffer.from("corrupt synthetic ZIP"));
    try {
      await expect(operator.download(context, run.id, link.id)).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it("offers only the workflow product's POD SKUs and refuses a replacement for an uncertain child", async () => {
    const { run, intent, assetId } = await podFixture();
    const options = await operator.repairOptions(context, run.id, "execute");
    expect(options.kind).toBe("pod");
    if (options.kind !== "pod") throw new Error("POD repair options missing");
    expect(options.options.skus).toHaveLength(1);
    expect(options.inputAssetIds).toEqual([assetId]);
    expect(options.parameterSnapshot).toMatchObject({
      cropPaddingPercent: 2,
      perspectiveCorrection: true,
    });
    await processor.process(job(intent));
    const childId = String((await attempt(run.id)).outputSnapshot?.delegatedTaskId);
    const podProcessor = new PodArtworkProcessor(
      new DrizzlePodArtworkExecutionRepository(database, storage),
      {
        execute: async () => {
          throw new Error("synthetic uncertain transport");
        },
      },
    );
    await expect(
      podProcessor.process({ ...job(intent), payload: { taskId: childId } }),
    ).rejects.toThrow("POD_RESULT_UNCERTAIN");
    await withTenant(database.db, context, (tx) =>
      tx
        .update(workflowNodeAttempts)
        .set({ nextAttemptAt: sql`clock_timestamp()-interval '1 second'` })
        .where(eq(workflowNodeAttempts.id, intent.id)),
    );
    await processor.process(job(intent));
    const failed = await runs.get(context, run.id),
      view = await operator.inspect(context, run.id, "execute");
    expect(view.access).toMatchObject({ canRepair: false, canRetry: false });
    expect(view.attempts[0]?.child).toMatchObject({
      id: childId,
      needsReconciliation: true,
      module: "print_extraction",
    });
    await expect(operator.repairOptions(context, run.id, "execute")).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      runs.command(context, run.id, "execute", {
        type: "retry",
        expectedRevision: failed.revision,
        parameters: {
          skuId: options.skuId,
          title: "Do not create twice",
          inputAssetIds: [assetId],
          parameterSnapshot: options.parameterSnapshot,
        },
      }),
    ).rejects.toThrow();
    expect((await runs.get(context, run.id)).revision).toBe(failed.revision);
    expect((await attempt(run.id)).id).toBe(intent.id);
    expect((await pod.get(context, childId)).errorCode).toBe("POD_RESULT_UNCERTAIN");
  });
});

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
