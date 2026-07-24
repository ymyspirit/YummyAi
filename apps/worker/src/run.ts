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
customizationFileScanWorker.on("completed", (job) => { process.stdout.write(`Customization file scan completed: ${job.id ?? "unknown"}\n`); });
customizationFileScanWorker.on("failed", (job, error) => { process.stderr.write(`Customization file scan failed: ${job?.id ?? "unknown"} (${error.name})\n`); });
shipmentWritebackWorker.on("completed", (job) => { process.stdout.write(`Shipment writeback completed: ${job.id ?? "unknown"}\n`); });
shipmentWritebackWorker.on("failed", (job, error) => { process.stderr.write(`Shipment writeback failed: ${job?.id ?? "unknown"} (${error.name})\n`); });
fulfillmentAutomationWorker.on("completed", (job) => { process.stdout.write(`Fulfillment automation completed: ${job.id ?? "unknown"}\n`); });
fulfillmentAutomationWorker.on("failed", (job, error) => { process.stderr.write(`Fulfillment automation failed: ${job?.id ?? "unknown"} (${error.name})\n`); });
webhookDeliveryWorker.on("completed", (job) => { process.stdout.write(`Webhook delivery completed: ${job.id ?? "unknown"}\n`); });
webhookDeliveryWorker.on("failed", (job, error) => { process.stderr.write(`Webhook delivery failed: ${job?.id ?? "unknown"} (${error.name})\n`); });

async function shutdown() {
  await worker.close();
  await listingSyncWorker.close();
  await publicationReconciliationWorker.close();
  await publicationReconciliationScheduler.close();
  await customizationFileScanWorker.close();
  await shipmentWritebackWorker.close();
  await fulfillmentAutomationWorker.close();
  await webhookDeliveryWorker.close();
  await database.client.end();
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
