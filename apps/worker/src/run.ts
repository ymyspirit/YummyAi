import { connectDatabase } from "@yummyai/database";
import { QueueName } from "@yummyai/jobs";
import {
  HttpMarketplaceDraftGateway,
  AmazonShipmentWritebackConnector,
  EtsyShipmentWritebackConnector,
  createMarketplaceSecretVault,
} from "@yummyai/marketplace-connectors";
import { createStorageFromEnvironment } from "@yummyai/storage";

import { createWorker } from "./main.js";
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
import { DrizzleShipmentWritebackExecutionRepository, ShipmentWritebackProcessor } from "./processors/shipment-writeback.processor.js";
import { DrizzleFulfillmentAttentionRunner, DrizzleFulfillmentAutomationExecutionRepository, FulfillmentAutomationProcessor } from "./processors/fulfillment-automation.processor.js";
import { DrizzleWebhookDeliveryRepository, HttpWebhookGateway, WebhookDeliveryProcessor } from "./processors/webhook-delivery.processor.js";
import { createEnvironmentSecretVault } from "@yummyai/ai-core";
import { PodArtworkProcessor } from "./processors/pod-artwork.processor.js";
import { DrizzlePodArtworkExecutionRepository } from "./processors/pod-artwork.repository.js";
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

const database = connectDatabase();
const storage = createStorageFromEnvironment();
const publicationRepository = new DrizzlePublicationExecutionRepository(
  database,
  createMarketplaceSecretVault(),
  storage,
);
const publicationGateway = new HttpMarketplaceDraftGateway();
const publicationReconciliationScheduler = new RedisMarketplacePublicationReconciliationScheduler();
const processor = new MarketplacePublicationProcessor(
  publicationRepository,
  publicationGateway,
  publicationReconciliationScheduler,
);
const worker = createWorker(QueueName.Publication, (envelope) => processor.process(envelope));
const publicationReconciliationProcessor = new MarketplacePublicationReconciliationProcessor(
  new MarketplacePublicationProcessor(publicationRepository, publicationGateway),
  publicationRepository,
);
const publicationReconciliationWorker = createWorker(
  QueueName.PublicationReconciliation,
  (envelope) => publicationReconciliationProcessor.process(envelope),
);
const publicationBatchProcessor = new MarketplacePublicationBatchProcessor(
  new DrizzlePublicationBatchExecutionRepository(database, createMarketplaceSecretVault()),
  publicationGateway,
  publicationReconciliationScheduler,
);
const publicationBatchWorker = createWorker(
  QueueName.PublicationBatch,
  (envelope) => publicationBatchProcessor.process(envelope),
);
const listingSyncProcessor = new MarketplaceListingSyncProcessor(
  new DrizzleListingSyncExecutionRepository(
    database,
    createMarketplaceSecretVault(),
    new DrizzleChannelMutationReconciliationWriter(),
  ),
  new HttpMarketplaceDraftGateway(),
);
const listingSyncWorker = createWorker(QueueName.ListingSync, (envelope) => listingSyncProcessor.process(envelope));
const customizationFileScanProcessor = new CustomizationFileScanProcessor(
  new DrizzleCustomizationFileScanRepository(database),
  storage,
  new ClamAvScanner(),
);
const customizationFileScanWorker = createWorker(QueueName.CustomizationFileScan, (envelope) => customizationFileScanProcessor.process(envelope));
const shipmentWritebackProcessor = new ShipmentWritebackProcessor(
  new DrizzleShipmentWritebackExecutionRepository(database, createMarketplaceSecretVault()),
  { amazon: new AmazonShipmentWritebackConnector(), etsy: new EtsyShipmentWritebackConnector() },
);
const shipmentWritebackWorker = createWorker(QueueName.ShipmentWriteback, (envelope) => shipmentWritebackProcessor.process(envelope));
const fulfillmentAutomationProcessor = new FulfillmentAutomationProcessor(new DrizzleFulfillmentAutomationExecutionRepository(database), new DrizzleFulfillmentAttentionRunner(database));
const fulfillmentAutomationWorker = createWorker(QueueName.FulfillmentAutomation, (envelope) => fulfillmentAutomationProcessor.process(envelope));
const webhookDeliveryProcessor = new WebhookDeliveryProcessor(new DrizzleWebhookDeliveryRepository(database, createEnvironmentSecretVault("INTEGRATION_SECRET_ENCRYPTION_KEY", "yummyai-integration-v1")), new HttpWebhookGateway());
const webhookDeliveryWorker = createWorker(QueueName.WebhookDelivery, (envelope) => webhookDeliveryProcessor.process(envelope));
const podArtworkWorker = podProcessorConfigured()
  ? createWorker(
      QueueName.PodArtwork,
      (envelope) => new PodArtworkProcessor(
        new DrizzlePodArtworkExecutionRepository(database, storage),
        HttpPodArtworkGateway.fromEnvironment(),
      ).process(envelope),
    )
  : undefined;
const podExportProcessor = new PodExportProcessor(new DrizzlePodExportRepository(database, storage), storage);
const podExportWorker = createWorker(QueueName.PodExport, (envelope) => podExportProcessor.process(envelope));
const templateSourceInspectionProcessor = new PersonalizationTemplateSourceInspectionProcessor(
  new DrizzleTemplateSourceInspectionRepository(database, storage),
);
const templateSourceInspectionWorker = createWorker(
  QueueName.PersonalizationTemplateSourceInspection,
  (envelope) => templateSourceInspectionProcessor.process(envelope),
);
const orderPersonalizationBatchProcessor = new OrderPersonalizationBatchProcessor(
  new DrizzleOrderPersonalizationBatchRepository(database),
  createEnvironmentSecretVault("ORDER_PII_ENCRYPTION_KEY", "yummyai-order-pii-v1"),
);
const orderPersonalizationBatchWorker = createWorker(
  QueueName.OrderPersonalizationBatch,
  (envelope) => orderPersonalizationBatchProcessor.process(envelope),
);
const orderPersonalizationRenderWorker = orderPersonalizationProcessorConfigured()
  ? createWorker(
      QueueName.OrderPersonalizationRender,
      (envelope) => new OrderPersonalizationRenderProcessor(
        new DrizzleOrderPersonalizationRenderRepository(database, storage),
        HttpOrderPersonalizationRenderGateway.fromEnvironment(),
        createEnvironmentSecretVault("ORDER_PII_ENCRYPTION_KEY", "yummyai-order-pii-v1"),
      ).process(envelope),
    )
  : undefined;
const creativeDesignWorker = podBatchCreativeConfigured()
  ? createWorker(
      QueueName.CreativeDesign,
      (envelope) => new CreativeDesignCandidateProcessor(database, storage, createCreativeGatewayFromEnvironment()).process(envelope),
    )
  : undefined;
const creativeDesignAdaptationWorker = podBatchCreativeConfigured()
  ? createWorker(
      QueueName.CreativeDesignAdaptation,
      (envelope) => new CreativeDesignAdaptationProcessor(database, storage, createCreativeGatewayFromEnvironment()).process(envelope),
    )
  : undefined;
const mockupTemplateCompileWorker = mockupRendererConfigured()
  ? createWorker(
      QueueName.MockupTemplateCompile,
      (envelope) => new MockupTemplateCompileProcessor(database, storage).process(envelope),
    )
  : undefined;
const mockupRenderWorker = mockupRendererConfigured()
  ? createWorker(
      QueueName.MockupRender,
      (envelope) => new MockupRenderProcessor(database, storage).process(envelope),
    )
  : undefined;

worker.on("completed", (job) => {
  process.stdout.write(`Publication job completed: ${job.id ?? "unknown"}\n`);
});
worker.on("failed", (job, error) => {
  process.stderr.write(`Publication job failed: ${job?.id ?? "unknown"} (${error.name})\n`);
});
listingSyncWorker.on("completed", (job) => { process.stdout.write(`Listing sync job completed: ${job.id ?? "unknown"}\n`); });
listingSyncWorker.on("failed", (job, error) => { process.stderr.write(`Listing sync job failed: ${job?.id ?? "unknown"} (${error.name})\n`); });
publicationReconciliationWorker.on("completed", (job) => { process.stdout.write(`Publication reconciliation completed: ${job.id ?? "unknown"}\n`); });
publicationReconciliationWorker.on("failed", (job, error) => { process.stderr.write(`Publication reconciliation failed: ${job?.id ?? "unknown"} (${error.name})\n`); });
publicationBatchWorker.on("completed", (job) => { process.stdout.write(`Publication batch completed: ${job.id ?? "unknown"}\n`); });
publicationBatchWorker.on("failed", (job, error) => { process.stderr.write(`Publication batch failed: ${job?.id ?? "unknown"} (${error.name})\n`); });
customizationFileScanWorker.on("completed", (job) => { process.stdout.write(`Customization file scan completed: ${job.id ?? "unknown"}\n`); });
customizationFileScanWorker.on("failed", (job, error) => { process.stderr.write(`Customization file scan failed: ${job?.id ?? "unknown"} (${error.name})\n`); });
shipmentWritebackWorker.on("completed", (job) => { process.stdout.write(`Shipment writeback completed: ${job.id ?? "unknown"}\n`); });
shipmentWritebackWorker.on("failed", (job, error) => { process.stderr.write(`Shipment writeback failed: ${job?.id ?? "unknown"} (${error.name})\n`); });
fulfillmentAutomationWorker.on("completed", (job) => { process.stdout.write(`Fulfillment automation completed: ${job.id ?? "unknown"}\n`); });
fulfillmentAutomationWorker.on("failed", (job, error) => { process.stderr.write(`Fulfillment automation failed: ${job?.id ?? "unknown"} (${error.name})\n`); });
webhookDeliveryWorker.on("completed", (job) => { process.stdout.write(`Webhook delivery completed: ${job.id ?? "unknown"}\n`); });
webhookDeliveryWorker.on("failed", (job, error) => { process.stderr.write(`Webhook delivery failed: ${job?.id ?? "unknown"} (${error.name})\n`); });
podArtworkWorker?.on("completed", (job) => { process.stdout.write(`POD artwork task completed: ${job.id ?? "unknown"}\n`); });
podArtworkWorker?.on("failed", (job, error) => { process.stderr.write(`POD artwork task failed: ${job?.id ?? "unknown"} (${error.name})\n`); });
podExportWorker.on("completed", (job) => { process.stdout.write(`POD export completed: ${job.id ?? "unknown"}\n`); });
podExportWorker.on("failed", (job, error) => { process.stderr.write(`POD export failed: ${job?.id ?? "unknown"} (${error.name})\n`); });
templateSourceInspectionWorker.on("completed", (job) => { process.stdout.write(`Template source inspection completed: ${job.id ?? "unknown"}\n`); });
templateSourceInspectionWorker.on("failed", (job, error) => { process.stderr.write(`Template source inspection failed: ${job?.id ?? "unknown"} (${error.name})\n`); });
orderPersonalizationBatchWorker.on("completed", (job) => { process.stdout.write(`Order personalization batch completed: ${job.id ?? "unknown"}\n`); });
orderPersonalizationBatchWorker.on("failed", (job, error) => { process.stderr.write(`Order personalization batch failed: ${job?.id ?? "unknown"} (${error.name})\n`); });
orderPersonalizationRenderWorker?.on("completed", (job) => { process.stdout.write(`Order personalization render completed: ${job.id ?? "unknown"}\n`); });
orderPersonalizationRenderWorker?.on("failed", (job, error) => { process.stderr.write(`Order personalization render failed: ${job?.id ?? "unknown"} (${error.name})\n`); });
creativeDesignWorker?.on("completed", (job) => { process.stdout.write(`Creative design candidate completed: ${job.id ?? "unknown"}\n`); });
creativeDesignWorker?.on("failed", (job, error) => { process.stderr.write(`Creative design candidate failed: ${job?.id ?? "unknown"} (${error.name})\n`); });
creativeDesignAdaptationWorker?.on("completed", (job) => { process.stdout.write(`Creative design adaptation completed: ${job.id ?? "unknown"}\n`); });
creativeDesignAdaptationWorker?.on("failed", (job, error) => { process.stderr.write(`Creative design adaptation failed: ${job?.id ?? "unknown"} (${error.name})\n`); });
mockupTemplateCompileWorker?.on("completed", (job) => { process.stdout.write(`Mockup template compile completed: ${job.id ?? "unknown"}\n`); });
mockupTemplateCompileWorker?.on("failed", (job, error) => { process.stderr.write(`Mockup template compile failed: ${job?.id ?? "unknown"} (${error.name})\n`); });
mockupRenderWorker?.on("completed", (job) => { process.stdout.write(`Mockup render completed: ${job.id ?? "unknown"}\n`); });
mockupRenderWorker?.on("failed", (job, error) => { process.stderr.write(`Mockup render failed: ${job?.id ?? "unknown"} (${error.name})\n`); });

async function shutdown() {
  await worker.close();
  await listingSyncWorker.close();
  await publicationReconciliationWorker.close();
  await publicationBatchWorker.close();
  await publicationReconciliationScheduler.close();
  await customizationFileScanWorker.close();
  await shipmentWritebackWorker.close();
  await fulfillmentAutomationWorker.close();
  await webhookDeliveryWorker.close();
  await podArtworkWorker?.close();
  await podExportWorker.close();
  await templateSourceInspectionWorker.close();
  await orderPersonalizationBatchWorker.close();
  await orderPersonalizationRenderWorker?.close();
  await creativeDesignWorker?.close();
  await creativeDesignAdaptationWorker?.close();
  await mockupTemplateCompileWorker?.close();
  await mockupRenderWorker?.close();
  await database.client.end();
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

function podProcessorConfigured() {
  return Boolean(
    process.env.POD_PROCESSOR_URL?.trim()
    && process.env.POD_PROCESSOR_API_KEY?.trim()
    && process.env.POD_PROCESSOR_DEPLOYMENT_ID?.trim()
    && process.env.POD_ENABLED_TOOLS?.trim(),
  );
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
