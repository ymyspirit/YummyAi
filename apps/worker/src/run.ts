import { assertDatabaseMigrationsCurrent, connectDatabase, recordAuditInTransaction } from "@yummyai/database";
import { CatalogPackageService } from "@yummyai/catalog-core";
import { enabledPodArtworkTools, PodArtworkOwner, RedisPodArtworkDispatcher } from "@yummyai/pod-core";
import { WorkflowNodeRuntime, AgentLoopRuntime, AgentPlanRuntime, AgentNativeRuntime, AgentNativeV2Runtime, AgentNativeV3Runtime, AgentNativeV4Runtime, SharedAgentCommandV2Gateway, agentCommandV2Capabilities, SharedAgentReadGateway } from "@yummyai/workflow-core";
import { createWorkerAgentTools } from "./agent-native-owners.js";
import { createWorkerAgentResources } from "./agent-resources-owners.js";
import { createWorkerAgentFulfillment } from "./agent-fulfillment-owners.js";
import { agentPlanRuntimeRouter } from "./agent-plan-runtime-router.js";
import { redisConnection, QueueName, RedisAgentRuntimePresence, type QueueNameValue } from "@yummyai/jobs";
import { AGENT_RUNTIME_FAMILIES, type AgentRuntimeQueue } from "@yummyai/contracts/ai/agent-runtime-readiness";
import { RedisConnection } from "bullmq";
import {
  HttpMarketplaceDraftGateway,
  AmazonShipmentWritebackConnector,
  EtsyShipmentWritebackConnector,
  createMarketplaceSecretVault,
} from "@yummyai/marketplace-connectors";
import { createStorageFromEnvironment } from "@yummyai/storage";
import { OrderDesignProcessor } from "@yummyai/order-design";
import { OrderDesignQueueProcessor, OrderDesignStudioGateway, RedisOrderDesignDispatcher } from "./processors/order-design.processor.js";
import { LocalPillowSuperResolutionGateway } from "./processors/pillow-super-resolution.js";

import { createWorker as createQueueWorker, type EnvelopeProcessor } from "./main.js";
import { WorkerLifecycle, workerDeadline, type WorkerLifecycleEvent } from "./lifecycle.js";
import { AgentRuntimeObserver } from "./agent-runtime-observer.js";
import { resolveWorkerRuntimePlan, runtimeQueues, WorkerSelectionError, type WorkerSchedulerName } from "./runtime-plan.js";
import { CaptureMediaProcessor, CaptureMediaScheduler } from "./processors/capture-media.processor.js";
import { WorkflowNodeProcessor, WorkflowNodeScheduler } from "./processors/workflow-node.processor.js";
import { WorkflowAttentionScheduler } from "./processors/workflow-attention.scheduler.js";
import { OrderLineAttentionScheduler } from "./processors/order-line-attention.scheduler.js";
import { BusinessFollowupScheduler } from "./processors/business-followup.scheduler.js";
import { MaterialCommandRetentionScheduler } from "./processors/material-command-retention.scheduler.js";
import { IncomingCommandRetentionScheduler } from "./processors/incoming-command-retention.scheduler.js";
import { ProcurementCommandRetentionScheduler } from "./processors/procurement-command-retention.scheduler.js";
import { FactoryErpSourceRetentionScheduler } from "./processors/factory-erp-source-retention.scheduler.js";
import { StudioGenerationProcessor } from "./processors/studio-generation.processor.js";
import { CreativeExecutionScheduler } from "./processors/creative-execution.scheduler.js";
import { AiAssistProcessor } from "./processors/ai-assist.processor.js";
import { AiAssistScheduler } from "./processors/ai-assist.scheduler.js";
import { AgentLoopProcessor } from "./processors/agent-loop.processor.js";
import { AgentLoopScheduler } from "./processors/agent-loop.scheduler.js";
import { AgentPlanProcessor } from "./processors/agent-plan.processor.js";
import { AgentPlanScheduler } from "./processors/agent-plan.scheduler.js";
import { KnowledgeMaintenanceProcessor, KnowledgeMaintenanceScheduler } from "./processors/knowledge-maintenance.processor.js";
import {
  DrizzleListingSyncExecutionRepository,
  MarketplaceListingSyncProcessor,
} from "./processors/marketplace-listing-sync.processor.js";
import { DrizzleChannelMutationReconciliationWriter } from "./processors/channel-inventory-reconciliation.repository.js";
import {
  DrizzlePublicationExecutionRepository,
  MarketplacePublicationProcessor,
} from "./processors/marketplace-publication.processor.js";
import {
  DrizzlePublicationBatchExecutionRepository,
  MarketplacePublicationBatchProcessor,
} from "./processors/marketplace-publication-batch.processor.js";
import {
  MarketplacePublicationReconciliationProcessor,
  RedisMarketplacePublicationReconciliationScheduler,
} from "./processors/marketplace-publication-reconciliation.processor.js";
import {
  CustomizationFileScanProcessor,
  DrizzleCustomizationFileScanRepository,
} from "./processors/customization-file-scan.processor.js";
import { ClamAvScanner } from "./scanners/clamav.scanner.js";
import { AmazonOrderReportRetentionProcessor, DrizzleAmazonOrderReportRetentionRepository } from "./processors/amazon-order-report-retention.processor.js";
import { AmazonOrderReportProcessingProcessor } from "./processors/amazon-order-report-processing.processor.js";
import { AmazonReportArchiveProcessor, HttpAmazonReportArchiveGateway, createAmazonReportBatchProcessor } from "@yummyai/order-intake";
import { ProductionEditorRenderProcessor } from "./processors/production-editor.processor.js";
import { RedisProductionRenderDispatcher } from "./processors/production-render-dispatcher.js";
import { DrizzleShipmentWritebackExecutionRepository, ShipmentWritebackProcessor } from "./processors/shipment-writeback.processor.js";
import { DrizzleFulfillmentAttentionRunner, DrizzleFulfillmentAutomationExecutionRepository, FulfillmentAutomationProcessor } from "./processors/fulfillment-automation.processor.js";
import { DrizzleWebhookDeliveryRepository, HttpWebhookGateway, WebhookDeliveryProcessor } from "./processors/webhook-delivery.processor.js";
import { createEnvironmentSecretVault } from "@yummyai/ai-core";
import { LogisticsExecutor, HttpLogisticsGateway } from "@yummyai/logistics";
import { LogisticsProcessor } from "./processors/logistics.processor.js";
import { PodArtworkProcessor } from "./processors/pod-artwork.processor.js";
import { DrizzlePodArtworkExecutionRepository } from "./processors/pod-artwork.repository.js";
import { PodArtworkScheduler } from "./processors/pod-artwork.scheduler.js";
import { HttpPodArtworkGateway } from "./processors/pod-artwork.http-gateway.js";
import { DrizzlePodExportRepository, PodExportProcessor } from "./processors/pod-export.processor.js";
import {
  DrizzleTemplateSourceInspectionRepository,
  PersonalizationTemplateSourceInspectionProcessor,
} from "./processors/personalization-template-source-inspection.processor.js";
import {
  DrizzleOrderPersonalizationBatchRepository,
  OrderPersonalizationBatchProcessor,
} from "./processors/order-personalization-batch.processor.js";
import { HttpOrderPersonalizationRenderGateway } from "./processors/order-personalization-render.http-gateway.js";
import { OrderPersonalizationRenderProcessor } from "./processors/order-personalization-render.processor.js";
import { DrizzleOrderPersonalizationRenderRepository } from "./processors/order-personalization-render.repository.js";
import {
  CreativeDesignAdaptationProcessor,
  CreativeDesignCandidateProcessor,
  MockupRenderProcessor,
  MockupTemplateCompileProcessor,
  createCreativeGatewayFromEnvironment,
} from "./processors/pod-batch-workflow.processor.js";


function report(event: WorkerLifecycleEvent) {
  process.stdout.write(JSON.stringify(event) + "\n");
  if (process.connected) {
    try { process.send?.(event, () => undefined); } catch { /* Parent supervision is optional. */ }
  }
}

async function main(): Promise<number> {
  let agentObserver: AgentRuntimeObserver | undefined;
  const lifecycle = new WorkerLifecycle({
    startupTimeoutMs: workerDeadline(process.env.WORKER_STARTUP_TIMEOUT_MS, 15_000),
    shutdownTimeoutMs: workerDeadline(process.env.WORKER_SHUTDOWN_TIMEOUT_MS, 30_000),
    report: event => { agentObserver?.lifecycle(event); report(event); },
  });
  const signal = () => { void lifecycle.shutdown("signal"); };
  const parent = (message: unknown) => {
    if (message === "shutdown" || (message && typeof message === "object" && "type" in message && message.type === "worker.shutdown")) void lifecycle.shutdown("parent_shutdown");
  };
  process.on("SIGINT", signal); process.on("SIGTERM", signal); process.on("message", parent);
  try {
    const available = runtimeQueues.filter(queue => {
      if (queue === QueueName.OrderDesign) return process.env.ORDER_DESIGN_AGENT_ENABLED !== "false";
      if (queue === QueueName.OrderPersonalizationRender) return orderPersonalizationProcessorConfigured();
      if ([QueueName.CreativeDesign, QueueName.CreativeDesignAdaptation].some(name => name === queue)) return podBatchCreativeConfigured();
      if ([QueueName.MockupTemplateCompile, QueueName.MockupRender].some(name => name === queue)) return mockupRendererConfigured();
      return true;
    });
    const plan = resolveWorkerRuntimePlan(process.env, available);
    const database = connectDatabase();
    lifecycle.resource("database", force => database.client.end({ timeout: force ? 0 : 5 }));
    const storage = createStorageFromEnvironment();
    await lifecycle.preflight(() => Promise.all([assertDatabaseMigrationsCurrent(database), storage.assertBucketReady()]));
    // A transport probe must not create metadata for an unrelated queue.
    const probe = new RedisConnection(redisConnection(), { shared: false, blocking: false });
    probe.on("error", () => undefined);
    lifecycle.resource("redis-readiness", force => probe.close(force));
    await lifecycle.preflight(() => probe.client);
    await probe.close();
    lifecycle.assertAssembling();

    if (plan.queues.has(QueueName.AgentLoop) || plan.queues.has(QueueName.AgentPlan)) {
      agentObserver = new AgentRuntimeObserver(new RedisAgentRuntimePresence());
      const observer = agentObserver;
      lifecycle.resource("agent-runtime-presence", () => observer.close());
    }

    const registered = new Set<QueueNameValue>(), registeredSchedulers = new Set<WorkerSchedulerName>();
    const selected = (queue: QueueNameValue) => plan.queues.has(queue);
    const createWorker = (queue: QueueNameValue, processor: EnvelopeProcessor) => {
      lifecycle.assertAssembling();
      if (!selected(queue) || registered.has(queue)) throw new Error("Worker consumer differs from selected plan");
      const isAgent = queue === QueueName.AgentLoop || queue === QueueName.AgentPlan;
      const worker = lifecycle.consumer(queue, createQueueWorker(queue, processor, undefined, { autorun: false,
        ...(isAgent && agentObserver ? { name: agentObserver.workerName } : {}) }));
      if (isAgent && agentObserver) agentObserver.register(queue as AgentRuntimeQueue, worker,
        queue === QueueName.AgentLoop ? [AGENT_RUNTIME_FAMILIES.loop.executorVersion] : [
          AGENT_RUNTIME_FAMILIES.plan.executorVersion, AGENT_RUNTIME_FAMILIES.native_v1.executorVersion,
          AGENT_RUNTIME_FAMILIES.native_v2.executorVersion, AGENT_RUNTIME_FAMILIES.native_v3.executorVersion,
          AGENT_RUNTIME_FAMILIES.native_v4.executorVersion,
        ]);
      registered.add(queue);
      worker.on("completed", job => process.stdout.write(JSON.stringify({ type: "worker.job", queue, state: "completed", jobId: job.id ?? null }) + "\n"));
      worker.on("failed", job => process.stdout.write(JSON.stringify({ type: "worker.job", queue, state: "failed", jobId: job?.id ?? null }) + "\n"));
      return worker;
    };
    const scheduler = (name: WorkerSchedulerName, factory: () => { start(): void; close(): Promise<unknown> }) => {
      if (!plan.schedulers.has(name)) return;
      lifecycle.scheduler(name, factory()); registeredSchedulers.add(name);
    };

    if (selected(QueueName.WorkflowNode)) {
      const dispatcher = new RedisPodArtworkDispatcher();
      lifecycle.resource("workflow-pod-dispatcher", () => dispatcher.close());
      const runtime = new WorkflowNodeRuntime(database, new CatalogPackageService(database, storage), new PodArtworkOwner(database, dispatcher,
        { isToolEnabled: key => enabledPodArtworkTools().has(key) }, { recordInTransaction: recordAuditInTransaction }));
      const processor = new WorkflowNodeProcessor(runtime);
      createWorker(QueueName.WorkflowNode, envelope => processor.process(envelope));
      scheduler("workflowNodeScheduler", () => new WorkflowNodeScheduler(database, runtime));
    }
    scheduler("workflowAttentionScheduler", () => new WorkflowAttentionScheduler(database));
    scheduler("orderLineAttentionScheduler", () => new OrderLineAttentionScheduler(database));
    scheduler("businessFollowupScheduler", () => new BusinessFollowupScheduler(database));
    scheduler("materialCommandRetentionScheduler", () => new MaterialCommandRetentionScheduler(database));
    scheduler("incomingCommandRetentionScheduler", () => new IncomingCommandRetentionScheduler(database));
    scheduler("procurementCommandRetentionScheduler", () => new ProcurementCommandRetentionScheduler(database));
    scheduler("financeCommandRetentionScheduler", () => new FinanceCommandRetentionScheduler(database));
    scheduler("advertisingCommandRetentionScheduler", () => new AdvertisingCommandRetentionScheduler(database));
    scheduler("factoryErpSourceRetentionScheduler", () => new FactoryErpSourceRetentionScheduler(database));
    if (selected(QueueName.Media)) {
      const processor = new CaptureMediaProcessor(database, storage);
      createWorker(QueueName.Media, envelope => processor.process(envelope));
      scheduler("captureMediaScheduler", () => new CaptureMediaScheduler(database));
    }
    if (selected(QueueName.Logistics)) {
      const executor = new LogisticsExecutor(database, createEnvironmentSecretVault("INTEGRATION_SECRET_ENCRYPTION_KEY", "yummyai-integration-v1"), createEnvironmentSecretVault("ORDER_PII_ENCRYPTION_KEY", "yummyai-order-pii-v1"), storage, new HttpLogisticsGateway());
      const processor = new LogisticsProcessor(executor);
      createWorker(QueueName.Logistics, envelope => processor.process(envelope));
    }
    if (selected(QueueName.AiAssist)) {
      const processor = new AiAssistProcessor(database, createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:model-config"), createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist"));
      createWorker(QueueName.AiAssist, envelope => processor.process(envelope));
      scheduler("aiAssistScheduler", () => new AiAssistScheduler(database));
    }
    if (selected(QueueName.AgentLoop)) {
      const contentVault = createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist");
      const readVault = createEnvironmentSecretVault("INTEGRATION_SECRET_ENCRYPTION_KEY", "yummyai-integration-v1");
      const runtime = new AgentLoopRuntime({ database, contentVault,
        modelVault: createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:model-config"),
        reads: new SharedAgentReadGateway(database, readVault) });
      const processor = new AgentLoopProcessor(runtime);
      createWorker(QueueName.AgentLoop, envelope => processor.process(envelope));
      scheduler("agentLoopScheduler", () => new AgentLoopScheduler(database, undefined, undefined, agentObserver?.scheduler("agent-loop")));
    }
    if (selected(QueueName.AgentPlan)) {
      const contentVault = createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist");
      const readVault = createEnvironmentSecretVault("INTEGRATION_SECRET_ENCRYPTION_KEY", "yummyai-integration-v1");
      const runtime = new AgentPlanRuntime({ database, contentVault,
        modelVault: createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:model-config"),
        reads: new SharedAgentReadGateway(database, readVault) });
      const native = new AgentNativeRuntime({ database, contentVault,
        modelVault: createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:model-config"),
        tools: createWorkerAgentTools(database, readVault) });
      const nativeV2 = new AgentNativeV2Runtime({ database, contentVault,
        modelVault: createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:model-config"),
        tools: createWorkerAgentTools(database, readVault), resources: createWorkerAgentResources(database) });
      const nativeV3 = new AgentNativeV3Runtime({ database, contentVault,
        modelVault: createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:model-config"),
        tools: createWorkerAgentTools(database, readVault), resources: createWorkerAgentResources(database),
        fulfillment: createWorkerAgentFulfillment(database, createEnvironmentSecretVault("ORDER_PII_ENCRYPTION_KEY", "yummyai-order-pii-v1")) });
      const v4Tools=createWorkerAgentTools(database,readVault);
      const nativeV4 = new AgentNativeV4Runtime({database,contentVault,
        modelVault:createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY","yummyai:model-config"),
        tools:v4Tools,resources:createWorkerAgentResources(database),
        fulfillment:createWorkerAgentFulfillment(database,createEnvironmentSecretVault("ORDER_PII_ENCRYPTION_KEY","yummyai-order-pii-v1")),
        commandDefinitions:new SharedAgentCommandV2Gateway(database,v4Tools,{capabilities:agentCommandV2Capabilities})});
      const processor = new AgentPlanProcessor(agentPlanRuntimeRouter(database,runtime,native,nativeV2,nativeV3,nativeV4));
      createWorker(QueueName.AgentPlan, envelope => processor.process(envelope));
      scheduler("agentPlanScheduler", () => new AgentPlanScheduler(database, undefined, undefined, agentObserver?.scheduler("agent-plan")));
    }
    if (selected(QueueName.KnowledgeMaintenance)) {
      const processor = new KnowledgeMaintenanceProcessor(database);
      createWorker(QueueName.KnowledgeMaintenance, envelope => processor.process(envelope));
      scheduler("knowledgeMaintenanceScheduler", () => new KnowledgeMaintenanceScheduler(database));
    }
    if (selected(QueueName.StudioGeneration)) {
      const processor = new StudioGenerationProcessor(database, storage, createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:model-config"));
      createWorker(QueueName.StudioGeneration, envelope => processor.process(envelope));
      scheduler("studioGenerationScheduler", () => new CreativeExecutionScheduler(database, storage, "studio_generation"));
    }
    if ([QueueName.Publication, QueueName.PublicationBatch, QueueName.PublicationReconciliation].some(selected)) {
      const repository = new DrizzlePublicationExecutionRepository(database, createMarketplaceSecretVault(), storage), gateway = new HttpMarketplaceDraftGateway();
      let publisher: RedisMarketplacePublicationReconciliationScheduler | undefined;
      const getPublisher = () => {
        if (!publisher) {
          const current = new RedisMarketplacePublicationReconciliationScheduler(); publisher = current;
          lifecycle.resource("publication-reconciliation-publisher", () => current.close());
        }
        return publisher;
      };
      if (selected(QueueName.Publication)) {
        const processor = new MarketplacePublicationProcessor(repository, gateway, getPublisher());
        createWorker(QueueName.Publication, envelope => processor.process(envelope));
      }
      if (selected(QueueName.PublicationReconciliation)) {
        const processor = new MarketplacePublicationReconciliationProcessor(new MarketplacePublicationProcessor(repository, gateway), repository);
        createWorker(QueueName.PublicationReconciliation, envelope => processor.process(envelope));
      }
      if (selected(QueueName.PublicationBatch)) {
        const processor = new MarketplacePublicationBatchProcessor(new DrizzlePublicationBatchExecutionRepository(database, createMarketplaceSecretVault()), gateway, getPublisher());
        createWorker(QueueName.PublicationBatch, envelope => processor.process(envelope));
      }
    }
    if (selected(QueueName.ListingSync)) {
      const processor = new MarketplaceListingSyncProcessor(new DrizzleListingSyncExecutionRepository(database, createMarketplaceSecretVault(), new DrizzleChannelMutationReconciliationWriter()), new HttpMarketplaceDraftGateway());
      createWorker(QueueName.ListingSync, envelope => processor.process(envelope));
    }
    if (selected(QueueName.CustomizationFileScan)) {
      const processor = new CustomizationFileScanProcessor(new DrizzleCustomizationFileScanRepository(database), storage, new ClamAvScanner());
      createWorker(QueueName.CustomizationFileScan, envelope => processor.process(envelope));
    }
    if (selected(QueueName.ShipmentWriteback)) {
      const processor = new ShipmentWritebackProcessor(new DrizzleShipmentWritebackExecutionRepository(database, createMarketplaceSecretVault()), { amazon: new AmazonShipmentWritebackConnector(), etsy: new EtsyShipmentWritebackConnector() });
      createWorker(QueueName.ShipmentWriteback, envelope => processor.process(envelope));
    }
    if (selected(QueueName.FulfillmentAutomation)) {
      const processor = new FulfillmentAutomationProcessor(new DrizzleFulfillmentAutomationExecutionRepository(database), new DrizzleFulfillmentAttentionRunner(database));
      createWorker(QueueName.FulfillmentAutomation, envelope => processor.process(envelope));
    }
    if (selected(QueueName.AmazonOrderReportRetention)) {
      const processor = new AmazonOrderReportRetentionProcessor(new DrizzleAmazonOrderReportRetentionRepository(database));
      createWorker(QueueName.AmazonOrderReportRetention, envelope => processor.process(envelope));
    }
    if (selected(QueueName.AmazonOrderReportProcessing)) {
      const processor = new AmazonOrderReportProcessingProcessor(createAmazonReportBatchProcessor(database, new AmazonReportArchiveProcessor(database, createEnvironmentSecretVault("ORDER_PII_ENCRYPTION_KEY", "yummyai-order-pii-v1"), new HttpAmazonReportArchiveGateway())));
      createWorker(QueueName.AmazonOrderReportProcessing, envelope => processor.process(envelope));
    }
    if (selected(QueueName.ProductionEditorRender)) {
      const processor = new ProductionEditorRenderProcessor(database, storage, createEnvironmentSecretVault("ORDER_PII_ENCRYPTION_KEY", "yummyai-order-pii-v1"), createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:model-config"), undefined, undefined, createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist"));
      createWorker(QueueName.ProductionEditorRender, envelope => processor.process(envelope));
      scheduler("productionRenderDispatcher", () => new RedisProductionRenderDispatcher(database, createEnvironmentSecretVault("ORDER_PII_ENCRYPTION_KEY", "yummyai-order-pii-v1")));
    }
    if (selected(QueueName.OrderDesign)) {
      const processor = new OrderDesignQueueProcessor(new OrderDesignProcessor(database, storage,
        createEnvironmentSecretVault("ORDER_PII_ENCRYPTION_KEY", "yummyai-order-pii-v1"),
        new OrderDesignStudioGateway(database, createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:model-config")),
        undefined, new LocalPillowSuperResolutionGateway()));
      createWorker(QueueName.OrderDesign, envelope => processor.process(envelope));
      scheduler("orderDesignDispatcher", () => new RedisOrderDesignDispatcher(database));
    }
    if (selected(QueueName.WebhookDelivery)) {
      const processor = new WebhookDeliveryProcessor(new DrizzleWebhookDeliveryRepository(database, createEnvironmentSecretVault("INTEGRATION_SECRET_ENCRYPTION_KEY", "yummyai-integration-v1")), new HttpWebhookGateway());
      createWorker(QueueName.WebhookDelivery, envelope => processor.process(envelope));
    }
    if (selected(QueueName.PodArtwork)) {
      createWorker(QueueName.PodArtwork, envelope => new PodArtworkProcessor(new DrizzlePodArtworkExecutionRepository(database, storage), lazyPodGateway()).process(envelope));
      scheduler("podArtworkScheduler", () => new PodArtworkScheduler(database, storage, undefined, tool => podProcessorConfigured() && enabledPodArtworkTools().has(tool as Parameters<ReturnType<typeof enabledPodArtworkTools>["has"]>[0])));
    }
    if (selected(QueueName.PodExport)) {
      const processor = new PodExportProcessor(new DrizzlePodExportRepository(database, storage), storage);
      createWorker(QueueName.PodExport, envelope => processor.process(envelope));
    }
    if (selected(QueueName.PersonalizationTemplateSourceInspection)) {
      const processor = new PersonalizationTemplateSourceInspectionProcessor(new DrizzleTemplateSourceInspectionRepository(database, storage));
      createWorker(QueueName.PersonalizationTemplateSourceInspection, envelope => processor.process(envelope));
    }
    if (selected(QueueName.OrderPersonalizationBatch)) {
      const processor = new OrderPersonalizationBatchProcessor(new DrizzleOrderPersonalizationBatchRepository(database), createEnvironmentSecretVault("ORDER_PII_ENCRYPTION_KEY", "yummyai-order-pii-v1"));
      createWorker(QueueName.OrderPersonalizationBatch, envelope => processor.process(envelope));
    }
    if (selected(QueueName.OrderPersonalizationRender)) {
      createWorker(QueueName.OrderPersonalizationRender, envelope => new OrderPersonalizationRenderProcessor(new DrizzleOrderPersonalizationRenderRepository(database, storage), HttpOrderPersonalizationRenderGateway.fromEnvironment(), createEnvironmentSecretVault("ORDER_PII_ENCRYPTION_KEY", "yummyai-order-pii-v1")).process(envelope));
    }
    if (selected(QueueName.CreativeDesign)) createWorker(QueueName.CreativeDesign, envelope => new CreativeDesignCandidateProcessor(database, storage, createCreativeGatewayFromEnvironment()).process(envelope));
    if (selected(QueueName.CreativeDesignAdaptation)) createWorker(QueueName.CreativeDesignAdaptation, envelope => new CreativeDesignAdaptationProcessor(database, storage, createCreativeGatewayFromEnvironment()).process(envelope));
    if (selected(QueueName.MockupTemplateCompile)) createWorker(QueueName.MockupTemplateCompile, envelope => new MockupTemplateCompileProcessor(database, storage).process(envelope));
    if (selected(QueueName.MockupRender)) createWorker(QueueName.MockupRender, envelope => new MockupRenderProcessor(database, storage).process(envelope));
    scheduler("creativeDesignScheduler", () => new CreativeExecutionScheduler(database, storage, "creative_candidate"));
    scheduler("creativeAdaptationScheduler", () => new CreativeExecutionScheduler(database, storage, "creative_adaptation"));
    scheduler("mockupCompileScheduler", () => new CreativeExecutionScheduler(database, storage, "template_compile"));
    scheduler("mockupRenderScheduler", () => new CreativeExecutionScheduler(database, storage, "mockup_render"));

    if (registered.size !== plan.queues.size || registeredSchedulers.size !== plan.schedulers.size) throw new Error("Worker runtime plan was not fully assembled");
    await lifecycle.start();
    const result = await lifecycle.stopped;
    return result.clean && ["signal", "parent_shutdown", "shutdown"].includes(result.reason) ? 0 : 1;
  } catch (error) {
    report({ type: "worker.lifecycle", state: "error", code: error instanceof WorkerSelectionError ? "WORKER_RUNTIME_SELECTION_INVALID" : "WORKER_BOOTSTRAP_FAILED", queues: [], schedulers: [] });
    await lifecycle.shutdown("startup_failed"); return 1;
  } finally {
    process.off("SIGINT", signal); process.off("SIGTERM", signal); process.off("message", parent);
    if (process.connected) process.disconnect();
  }
}

void main().then(code => process.exit(code)).catch(() => {
  process.stderr.write("Worker configuration is invalid\n"); process.exit(1);
});

function podProcessorConfigured() {
  return Boolean(
    process.env.POD_PROCESSOR_URL?.trim()
    && process.env.POD_PROCESSOR_API_KEY?.trim()
    && process.env.POD_PROCESSOR_DEPLOYMENT_ID?.trim()
    && process.env.POD_ENABLED_TOOLS?.trim(),
  );
}

function lazyPodGateway() {
  let gateway: HttpPodArtworkGateway | undefined;
  return {
    prepare: (task: { toolKey: string }) => {
      if (!podProcessorConfigured() || !enabledPodArtworkTools().has(task.toolKey as Parameters<ReturnType<typeof enabledPodArtworkTools>["has"]>[0])) throw new Error("POD processor is unavailable");
      gateway = HttpPodArtworkGateway.fromEnvironment();
    },
    execute: (...args: Parameters<HttpPodArtworkGateway["execute"]>) => {
      if (!gateway) throw new Error("POD processor preparation is required");
      return gateway.execute(...args);
    },
  };
}

function orderPersonalizationProcessorConfigured() {
  return Boolean(
    process.env.POD_ORDER_PROCESSOR_URL?.trim()
    && process.env.POD_ORDER_PROCESSOR_API_KEY?.trim()
    && process.env.POD_ORDER_PROCESSOR_DEPLOYMENT_ID?.trim()
    && process.env.POD_ORDER_ENABLED_TOOLS?.trim(),
  );
}

function podBatchCreativeConfigured() {
  const enabled = process.env.POD_BATCH_WORKFLOWS_ENABLED?.trim().toLowerCase() === "true";
  const tools = new Set(process.env.POD_ENABLED_TOOLS?.split(",").map((value) => value.trim()).filter(Boolean));
  return enabled && podProcessorConfigured() && tools.has("text_to_image") && tools.has("canvas_extend");
}

function mockupRendererConfigured() {
  return process.env.POD_BATCH_WORKFLOWS_ENABLED?.trim().toLowerCase() === "true"
    && process.env.POD_MOCKUP_RENDERER_ENABLED?.trim().toLowerCase() === "true";
}
import { FinanceCommandRetentionScheduler } from "./processors/finance-command-retention.scheduler.js";
import { AdvertisingCommandRetentionScheduler } from "./processors/advertising-command-retention.scheduler.js";
