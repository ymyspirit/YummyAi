import { requireProductionEditorFixtureEnvironment } from "../../../tools/testing/production-editor-fixture-environment.mjs";
import type { StudioGateway } from "../src/processors/studio-generation.gateway.js";
import type { OrderDesignSuperResolutionGateway, OrderDesignImageGateway } from "@yummyai/order-design";

// This E2E entry has no ordinary-resource mode. Validate all resource identities
// before importing runtime clients, connecting or admitting a queue consumer.
const environment = requireProductionEditorFixtureEnvironment();
const { isolatedDaily, designFault } = environment;
const { createEnvironmentSecretVault } = await import("@yummyai/ai-core");
const { connectDatabase, withTenant, orderDesignAgentSteps, orderDesignAgentRuns, orderWorkItems, purgeExpiredAmazonOrderReports } = await import("@yummyai/database");
const { eq } = await import("drizzle-orm");
const { QueueName } = await import("@yummyai/jobs");
const { createStorageFromEnvironment } = await import("@yummyai/storage");
const { createWorker } = await import("../src/main.js");
const { ProductionEditorRenderProcessor } = await import("../src/processors/production-editor.processor.js");
const { default: sharp } = await import("sharp");
const { OrderDesignProcessor, PILLOW_REALESRGAN_POLICY } = await import("@yummyai/order-design");
const { OrderDesignQueueProcessor, OrderDesignStudioGateway, RedisOrderDesignDispatcher } = await import("../src/processors/order-design.processor.js");
const { HttpLogisticsGateway, LogisticsExecutor } = await import("@yummyai/logistics");
const { LogisticsProcessor } = await import("../src/processors/logistics.processor.js");
const database = connectDatabase(environment.databaseUrl);
const syntheticGateway: StudioGateway = {
  async generate(execution) {
    // Only the disposable design-agent fixture may use the exact pillow route.
    // These deterministic shapes test orchestration, never model image quality.
    if (isolatedDaily && execution.endpoint === "https://synthetic.invalid/v1" && execution.apiKey === "synthetic-never-used"
      && execution.model === "gpt-image-2.5" && execution.references.length === 1) {
      execution.signal?.throwIfAborted();
      process.stdout.write("SYNTHETIC_DESIGN_MODEL_CALL\n");
      if (designFault === "unknown_pillow_cutout" && execution.input.background === "transparent")
        throw new Error("Synthetic provider result unknown after submission");
      const bytes = execution.input.background === "transparent"
        ? await sharp(Buffer.from('<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg"><ellipse cx="256" cy="256" rx="220" ry="225" fill="#795630"/></svg>')).png().toBuffer()
        : await sharp(execution.references[0]!.bytes).png().toBuffer();
      return { bytes, mediaType: "image/png" };
    }
    if (!isolatedDaily || execution.endpoint !== "https://synthetic-daily.invalid/v1" || execution.apiKey !== "synthetic-daily-not-a-real-key"
      || execution.model !== "synthetic-upscale-fixture" || execution.references.length !== 1)
      throw new Error("Synthetic daily gateway refused an unexpected model request");
    const source = execution.references[0]!.bytes;
    const metadata = await sharp(source).metadata();
    return { bytes: await sharp(source).resize(Math.round(metadata.width! * 1.5), Math.round(metadata.height! * 1.5)).png().toBuffer(), mediaType: "image/png" };
  },
};
const syntheticSuperResolution: OrderDesignSuperResolutionGateway = {
  async validatePolicy(policy) {
    if (!isolatedDaily || Object.entries(PILLOW_REALESRGAN_POLICY).some(([key, value]) => policy[key as keyof typeof policy] !== value))
      throw new Error("Synthetic pillow gateway refused an unexpected runtime policy");
  },
  async upscale({ bytes, policy, signal }) {
    await this.validatePolicy(policy);
    signal?.throwIfAborted();
    const metadata = await sharp(bytes).metadata();
    return { bytes: await sharp(bytes).resize(metadata.width! * 4, metadata.height! * 4).png().toBuffer(), evidence: { engine: "synthetic-e2e", purpose: "orchestration-only" } };
  },
};
const processor = new ProductionEditorRenderProcessor(database, createStorageFromEnvironment(), createEnvironmentSecretVault("ORDER_PII_ENCRYPTION_KEY", "yummyai-order-pii-v1"),
  isolatedDaily ? createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:model-config") : undefined,
  isolatedDaily ? syntheticGateway : undefined);
const worker = createWorker(QueueName.ProductionEditorRender, (envelope) => processor.process(envelope), environment.redisUrl);
const originalOrderGateway=isolatedDaily?new OrderDesignStudioGateway(database,createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY","yummyai:model-config"),syntheticGateway):null;
const orderGateway:OrderDesignImageGateway={async generate(input){
 if(!originalOrderGateway)throw new Error("Disposable order design gateway required");
 const result=await originalOrderGateway.generate(input);
 if(designFault==="expire_order_before_response"){
  if(!isolatedDaily)throw new Error("Disposable privacy fault required");
  await withTenant(database.db,input.context,async tx=>{
   const [source]=await tx.select({workItemId:orderDesignAgentRuns.workItemId}).from(orderDesignAgentSteps).innerJoin(orderDesignAgentRuns,eq(orderDesignAgentRuns.id,orderDesignAgentSteps.runId)).where(eq(orderDesignAgentSteps.requestId,input.requestId));
   if(!source)throw new Error("Original synthetic call required");
   await tx.update(orderWorkItems).set({expiresAt:new Date(0)}).where(eq(orderWorkItems.id,source.workItemId));
  });
  await purgeExpiredAmazonOrderReports(database,input.context);
  return {...result,actualCostUsd:0.00000001};
 }
 return result;
}};
const designProcessor = isolatedDaily ? new OrderDesignQueueProcessor(new OrderDesignProcessor(database, createStorageFromEnvironment(),
  createEnvironmentSecretVault("ORDER_PII_ENCRYPTION_KEY", "yummyai-order-pii-v1"),
  orderGateway, undefined, syntheticSuperResolution)) : undefined;
const designWorker = designProcessor ? createWorker(QueueName.OrderDesign, envelope => designProcessor.process(envelope), environment.redisUrl) : undefined;
const dispatcher = isolatedDaily ? new RedisOrderDesignDispatcher(database) : undefined;
const logisticsProcessor = isolatedDaily && process.env.LOGISTICS_TEST_BASE_URL ? new LogisticsProcessor(new LogisticsExecutor(database,
  createEnvironmentSecretVault("INTEGRATION_SECRET_ENCRYPTION_KEY", "yummyai-integration-v1"),
  createEnvironmentSecretVault("ORDER_PII_ENCRYPTION_KEY", "yummyai-order-pii-v1"), createStorageFromEnvironment(), new HttpLogisticsGateway())) : undefined;
const logisticsWorker = logisticsProcessor ? createWorker(QueueName.Logistics, envelope => logisticsProcessor.process(envelope), environment.redisUrl) : undefined;
await worker.waitUntilReady();
await designWorker?.waitUntilReady();
await logisticsWorker?.waitUntilReady();
dispatcher?.start(500);
process.stdout.write("PRODUCTION_EDITOR_WORKER_READY\n");
async function close() { await dispatcher?.close(); await designWorker?.close(); await logisticsWorker?.close(); await worker.close(); await database.client.end(); }
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
process.once("SIGINT", () => void close().finally(() => process.exit(0)));
