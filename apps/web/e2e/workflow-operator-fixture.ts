import { Permission } from "../../../packages/authz/src/index";
import { CatalogPackageService } from "../../../packages/catalog-core/src/index";
import { PodArtworkOwner } from "../../../packages/pod-core/src/index";
import { WorkflowNodeRuntime, WorkflowAttentionDispatcher } from "../../../packages/workflow-core/src/index";
import {
  createEntityId,
  type CaptureDraft,
  type TenantContext,
  type WorkflowGraph,
  type WorkflowRunDetail,
} from "@yummyai/contracts";
import {
  assetFiles,
  connectDatabase,
  recordAuditInTransaction,
  recordNotificationInTransaction,
  roles,
  spus,
  workflowNodeAttempts,
  withTenant,
} from "@yummyai/database";
import { createStorageFromEnvironment } from "@yummyai/storage";
import { createTraceId, QueueName } from "../../../packages/jobs/src/index";
import { eq, sql } from "drizzle-orm";
import { createWorker } from "../../worker/src/main";
import {
  WorkflowNodeProcessor,
  WorkflowNodeScheduler,
} from "../../worker/src/processors/workflow-node.processor";
import { PodArtworkProcessor } from "../../worker/src/processors/pod-artwork.processor";
import { DrizzlePodArtworkExecutionRepository } from "../../worker/src/processors/pod-artwork.repository";
import { apiFetch, getApiHeaders } from "../src/server-api";

export async function workflowApi<T>(path: string, input?: unknown): Promise<T> {
  const response = await apiFetch(
    `${process.env.API_BASE_URL}/v1/${path}`,
    input === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
  );
  if (!response.ok)
    throw new Error(`Synthetic workflow API ${path.split("/")[0]} returned ${response.status}`);
  return response.json() as Promise<T>;
}

export async function workflowOperatorFixture() {
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
  if (
    process.env.E2E_ISOLATED_DAILY !== "1" ||
    !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(url.pathname)
  )
    throw new Error("Disposable workflow runner required");
  const database = connectDatabase(url.href),
    storage = createStorageFromEnvironment();
  const headers = await getApiHeaders(),
    claims = JSON.parse(
      Buffer.from(headers.authorization!.split(".")[1]!, "base64url").toString(),
    ) as { sub: string };
  const [identity] = await database.client.unsafe<{ tenant_id: string; user_id: string }[]>(
    "select m.tenant_id,m.user_id from memberships m join app_users u on u.id=m.user_id where u.oidc_subject=$1 and m.status='active'",
    [claims.sub],
  );
  if (!identity) {
    await database.client.end();
    throw new Error("Synthetic membership unavailable");
  }
  const context: TenantContext = {
    tenantId: identity.tenant_id,
    userId: identity.user_id,
    permissions: Object.values(Permission),
    dataScope: "tenant",
  };
  const owner = new PodArtworkOwner(
    database,
    { enqueue: async () => {} },
    { isToolEnabled: (key) => key === "pattern_crop" },
    { recordInTransaction: recordAuditInTransaction },
  );
  const runtime = new WorkflowNodeRuntime(
    database,
    new CatalogPackageService(database, storage),
    owner,
  );
  const processor = new WorkflowNodeProcessor(runtime),
    scheduler = new WorkflowNodeScheduler(database, runtime);
  let worker: ReturnType<typeof createWorker> | undefined;
  let syntheticPodCalls = 0;
  async function permissions(values: readonly string[] = Object.values(Permission)) {
    await withTenant(database.db, context, (tx) =>
      tx.update(roles).set({ permissions: values }).where(eq(roles.name, "Fixture operator")),
    );
  }
  return {
    context,
    attention: () => new WorkflowAttentionDispatcher(database).dispatch(),
    async notices(count: number) {
      for (let index = 0; index < count; index++) await withTenant(database.db, context, (tx) => recordNotificationInTransaction(tx, context, { kind: "system", title: `Synthetic 分页通知 ${index}`, body: "隔离验收资料" }));
    },
    async startWorker() {
      worker ??= createWorker(QueueName.WorkflowNode, (envelope) => processor.process(envelope));
      await worker.waitUntilReady();
    },
    async source() {
      const draft: CaptureDraft = {
        platform: "amazon",
        marketplace: "www.amazon.com",
        sourceUrl: `https://www.amazon.com/dp/B0SYNTH001?fixture=${createEntityId()}`,
        externalId: "B0SYNTH001",
        title: "Synthetic 定制商品资料 长标题用于核对换行与检索范围 ".repeat(8).trim(),
        parserVersion: "workflow-browser-fixture-v1",
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
      return workflowApi<{ researchItemId: string; snapshotId: string }>("captures", draft);
    },
    async run(
      capability = "yummyai.custom_product.generate_provisional_facts",
      parameters: Record<string, unknown> = {},
      productPlanId?: string,
      includeExport = true,
      options: { title?: string; nodeTitle?: string; human?: boolean } = {},
    ) {
      const product = productPlanId
        ? { id: productPlanId }
        : await workflowApi<{ id: string }>("products/plans", {
            name: options.title ?? "Synthetic 工作流商品与执行记录",
            sourceReportIds: [],
            customization: { version: 1, fields: [] },
          });
      const nodes: WorkflowGraph["nodes"] = [
        {
          id: "start",
          kind: "start",
          title: "开始",
          description: "",
          ownerRole: "运营",
          inputPorts: [],
          outputPorts: [],
          config: { parameters: {} },
          position: { x: 0, y: 0 },
        },
        {
          id: "execute",
          kind: options.human ? "human_task" : "internal_action",
          title: options.nodeTitle ?? (capability.startsWith("pod.") ? "处理图案" : "整理商品事实"),
          description: "使用明确选定的来源生成待核实事实",
          ownerRole: "运营",
          inputPorts: [],
          outputPorts: [],
          requiredPermission: capability.startsWith("pod.")
            ? Permission.DesignWrite
            : Permission.ProductWrite,
          config: options.human ? { parameters: {} } : { capabilityKey: capability, parameters },
          position: { x: 0, y: 140 },
        },
        {
          id: "review",
          kind: "approval_gate",
          title: "审核商品资料",
          description: "核对本次产物后继续",
          ownerRole: "审核员",
          inputPorts: [],
          outputPorts: [],
          requiredPermission: Permission.ProductWrite,
          reworkTargetNodeId: "execute",
          config: { parameters: {}, approvalMode: "any" },
          position: { x: 0, y: 280 },
        },
      ];
      if (includeExport)
        nodes.push({
          id: "export",
          kind: "internal_action",
          title: "导出产品包",
          description: "保留待核实项并生成草稿交付包",
          ownerRole: "运营",
          inputPorts: [],
          outputPorts: [],
          requiredPermission: Permission.ProductWrite,
          config: {
            capabilityKey: "yummyai.custom_product.export_package",
            parameters: { mode: "draft" },
          },
          position: { x: 0, y: 420 },
        });
      nodes.push({
        id: "end",
        kind: "end",
        title: "结束",
        description: "",
        ownerRole: "运营",
        inputPorts: [],
        outputPorts: [],
        config: { parameters: {} },
        position: { x: 0, y: 560 },
      });
      const graph: WorkflowGraph = {
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes,
        edges: nodes
          .slice(1)
          .map((node, index) => ({
            id: `success-${index}`,
            source: nodes[index]!.id,
            target: node.id,
            kind: "success",
          })),
      };
      graph.edges.push({ id: "rework", source: "review", target: "execute", kind: "rework" });
      const definition = await workflowApi<{ id: string; revision: number }>(
        "workflows/definitions",
        {
          name: "Synthetic 操作验收流程",
          description: "Disposable browser acceptance",
          category: "Acceptance",
          scope: "team",
          graph,
        },
      );
      await workflowApi(`workflows/definitions/${definition.id}/publish`, {
        expectedRevision: definition.revision,
      });
      return workflowApi<WorkflowRunDetail>("workflow-runs", {
        definitionId: definition.id,
        productPlanId: product.id,
      });
    },
    async podProduct() {
      const product = await workflowApi<{ id: string }>("products/plans", {
          name: "Synthetic POD workflow",
          sourceReportIds: [],
          customization: { version: 1, fields: [] },
        }),
        spuId = createEntityId();
      await withTenant(database.db, context, (tx) =>
        tx
          .insert(spus)
          .values({
            id: spuId,
            tenantId: context.tenantId,
            productPlanId: product.id,
            code: `S-${spuId}`,
            name: "Synthetic developing SKU",
            status: "developing",
            customization: { version: 1, fields: [] },
          }),
      );
      const sku = await workflowApi<{ id: string }>("products/skus", {
        spuId,
        code: `K-${createEntityId()}`,
        attributes: {},
      });
      const assetId = createEntityId(),
        body = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZk0AAAAASUVORK5CYII=",
          "base64",
        ),
        fileName = `${assetId}.png`;
      const stored = await storage.putPrivate(context, {
        body,
        domain: "authorized",
        fileName,
        mediaType: "image/png",
      });
      await withTenant(database.db, context, (tx) =>
        tx
          .insert(assetFiles)
          .values({
            id: assetId,
            tenantId: context.tenantId,
            ownerUserId: context.userId,
            objectKey: stored.objectKey,
            assetDomain: "authorized",
            fileName,
            mediaType: "image/png",
            byteSize: body.length,
            checksumSha256: stored.checksumSha256,
            rightsStatus: "approved",
            rightsMetadata: { source: { kind: "owned", reference: "synthetic browser fixture" } },
          }),
      );
      return { productPlanId: product.id, skuId: sku.id, assetId };
    },
    permissions,
    async completePod(taskId: string) {
      const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZk0AAAAASUVORK5CYII=", "base64");
      const child = new PodArtworkProcessor(new DrizzlePodArtworkExecutionRepository(database,storage), { execute: async () => {
        syntheticPodCalls++;
        return { outputs: [{ bytes: Uint8Array.from(bytes), mediaType: "image/png", role: "effect", fileName: "synthetic-crop.png", metadata: { width:1,height:1,unit:"px",colorMode:"rgb",transparent:false,aiInference:"none" } }], modelKey:"synthetic-browser",modelVersion:"v1",costUsd:0.023,partial:false,
          qualityCheckSnapshot:{passed:true,mode:"general",inputCoverageComplete:true,cropBoundsValid:true,blankOutputsDetected:false,duplicateOutputsDetected:false,outputChecks:[{fileName:"synthetic-crop.png",inputOrdinal:0,cropIndex:0,sourceBounds:{x:0,y:0,width:1,height:1},outputWidth:1,outputHeight:1,transparent:false,perspectiveCorrectionValidated:true,cropComplete:true,resultLabel:"synthetic"}]} };
      } });
      return child.process({ jobId:createEntityId(),tenantId:context.tenantId,requestedBy:context.userId,traceId:createTraceId(),correlationId:taskId,idempotencyKey:taskId,requestedAt:new Date().toISOString(),attempt:0,maxAttempts:3,payload:{taskId} });
    },
    async uncertain(taskId: string, attemptId: string) {
      const child = new PodArtworkProcessor(
        new DrizzlePodArtworkExecutionRepository(database, storage),
        {
          execute: async () => {
            syntheticPodCalls++;
            throw new Error("Synthetic ambiguous external response");
          },
        },
      );
      try {
        await child.process({
          jobId: createEntityId(),
          tenantId: context.tenantId,
          requestedBy: context.userId,
          traceId: createTraceId(),
          correlationId: taskId,
          idempotencyKey: taskId,
          requestedAt: new Date().toISOString(),
          attempt: 0,
          maxAttempts: 3,
          payload: { taskId },
        });
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("POD_RESULT_UNCERTAIN"))
          throw error;
      }
      await withTenant(database.db, context, (tx) =>
        tx
          .update(workflowNodeAttempts)
          .set({
            nextAttemptAt: sql`clock_timestamp()-interval '1 second'`,
            lastDispatchedAt: null,
          })
          .where(eq(workflowNodeAttempts.id, attemptId)),
      );
      await scheduler.dispatch();
    },
    proof: () => ({
      syntheticPodCalls,
      externalPodTransport: "synthetic-result-or-throwing-gateway",
      workerQueues: worker ? [QueueName.WorkflowNode] : [],
    }),
    async close() {
      try {
        await permissions();
      } finally {
        try {
          await worker?.close();
        } finally {
          try {
            await scheduler.close();
          } finally {
            await database.client.end();
          }
        }
      }
    },
  };
}
