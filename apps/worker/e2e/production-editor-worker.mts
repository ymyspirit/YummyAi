import { createEnvironmentSecretVault } from "@yummyai/ai-core";
import { connectDatabase } from "@yummyai/database";
import { QueueName } from "@yummyai/jobs";
import { createStorageFromEnvironment } from "@yummyai/storage";
import { createWorker } from "../src/main.js";
import { ProductionEditorRenderProcessor } from "../src/processors/production-editor.processor.js";

// The browser acceptance fixture starts only the real production-render queue.
const database = connectDatabase();
const processor = new ProductionEditorRenderProcessor(database, createStorageFromEnvironment(), createEnvironmentSecretVault("ORDER_PII_ENCRYPTION_KEY", "yummyai-order-pii-v1"));
const worker = createWorker(QueueName.ProductionEditorRender, (envelope) => processor.process(envelope));
await worker.waitUntilReady();
process.stdout.write("PRODUCTION_EDITOR_WORKER_READY\n");
async function close() { await worker.close(); await database.client.end(); }
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
process.once("SIGINT", () => void close().finally(() => process.exit(0)));
