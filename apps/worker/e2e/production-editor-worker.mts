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
      // This family exercises the legacy native-size recipe, which has no
      // upscaling step. Return actual 2048px synthetic provider bytes; the
      // original pixel/preflight checks still determine acceptance. Other
      // families retain the small response used to exercise their upscale.
      const size = process.env.E2E_ORDER_REQUIREMENTS_ISOLATED === "1" ? 2048 : 512;
      const bytes = execution.input.background === "transparent"
        ? await sharp(Buffer.from(`<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><ellipse cx="${size / 2}" cy="${size / 2}" rx="${size * 220 / 512}" ry="${size * 225 / 512}" fill="#795630"/></svg>`)).png().toBuffer()
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
let assistWorker: ReturnType<typeof createWorker> | undefined;
if (isolatedDaily && process.env.E2E_ORDER_REQUIREMENTS_ISOLATED === "1") {
  const { createHash } = await import("node:crypto");
  const { AiAssistProcessor, assistPricing } = await import("../src/processors/ai-assist.processor.js");
  const { OpenAiCompatibleProvider } = await import("@yummyai/ai-core");
  const { AssistResultSchema } = await import("@yummyai/contracts/ai/assist");
  const { OrderRequirementSourceSchema } = await import("@yummyai/contracts/order/requirement-interpretation");
  const { CustomizationSchema, TenantContextSchema } = await import("@yummyai/contracts");
  const actor = JSON.parse(process.env.ERP_FIXTURE_ACTORS ?? "null")?.operator;
  const identity = TenantContextSchema.pick({ tenantId: true, userId: true }).parse({ tenantId: actor?.tenantId, userId: actor?.userId });
  const endpoint = "https://synthetic-order-requirements.invalid/v1", model = "synthetic-order-requirements-text";
  const processor = new AiAssistProcessor(database,
    createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:model-config"),
    createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist"),
    (provider, key, run) => {
      if (provider.provider !== "openai-compatible" || provider.endpoint !== endpoint || key !== "synthetic-order-requirements-not-a-real-key"
        || run.modelSnapshot.model !== model || run.kind !== "order_review" || run.tenantId !== identity.tenantId || run.ownerId !== identity.userId)
        throw new Error("Synthetic requirement analysis refused an unexpected provider or owner");
      return new OpenAiCompatibleProvider({ providerId: provider.id, endpoint, apiKey: key, pricing: assistPricing(run.modelSnapshot),
        fetch: async (url, init) => {
          if (String(url) !== endpoint + "/chat/completions" || init?.method !== "POST" || typeof init.body !== "string")
            throw new Error("Synthetic requirement analysis refused an unexpected transport");
          init.signal?.throwIfAborted();
          const payload = JSON.parse(init.body) as { model?: unknown; messages?: Array<{ role?: string; content?: unknown }> };
          if (payload.model !== model) throw new Error("Synthetic requirement analysis model mismatch");
          const message = payload.messages?.filter(row => row.role === "user");
          if (message?.length !== 1) throw new Error("Synthetic requirement analysis requires the original input");
          const content = message[0]!.content;
          const texts = typeof content === "string" ? [content] : Array.isArray(content)
            ? content.filter((part): part is { type: string; text: string } => !!part && typeof part === "object"
              && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string").map(part => part.text) : [];
          const encoded = texts.filter(text => text.includes("<untrusted_source_data>"));
          if (encoded.length !== 1) throw new Error("Synthetic requirement analysis source packet missing");
          const match = /<untrusted_source_data>\n([^]*?)\n<\/untrusted_source_data>$/.exec(encoded[0]!);
          if (!match) throw new Error("Synthetic requirement analysis source packet invalid");
          const packet = JSON.parse(match[1]!) as { kind?: unknown; order?: { requirementSources?: unknown; customization?: unknown;
            requirementSourceIds?: Record<string, string>; draft?: { fields?: Array<{ key?: string; sourceKey?: string; value?: string }> } } };
          if (packet.kind !== "order_review") throw new Error("Synthetic requirement analysis kind mismatch");
          const sources = OrderRequirementSourceSchema.array().parse(packet.order?.requirementSources);
          const fields = CustomizationSchema.parse(packet.order?.customization).fields;
          const target = fields.find(field => field.key === "operator_message" && field.type === "short_text");
          const selected = sources.filter(source => source.origin === "operator" && source.role === "text"
            && source.label === "Synthetic operator message" && source.value === "Synthetic operator original text");
          if (!target || selected.length !== 1) throw new Error("Synthetic requirement analysis exact original field missing");
          const source = selected[0]!, sourceId = "order-field:" + createHash("sha256").update(JSON.stringify(source.sourceFieldKey)).digest("hex");
          if (packet.order?.requirementSourceIds?.[source.sourceFieldKey] !== sourceId ||
            packet.order?.draft?.fields?.filter(field => (field.sourceKey ?? field.key) === source.sourceFieldKey && field.value === source.value).length !== 1)
            throw new Error("Synthetic requirement analysis original evidence mismatch");
          const result = AssistResultSchema.parse({ summary: "Synthetic classification of the one unchanged operator field", findings: [],
            directions: [], matches: [], missingInformation: [], orderFieldBindings: [{ sourceFieldKey: source.sourceFieldKey,
              targetFieldKey: target.key, role: "text", confidence: 0.98, reason: "The current original operator text matches this declared text field",
              evidence: [{ sourceId, detail: "Exact current original source field" }] }] });
          process.stdout.write("SYNTHETIC_ORDER_REQUIREMENTS_ASSIST_CALL\n");
          return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }],
            usage: { prompt_tokens: 120, completion_tokens: 80 } });
        } });
    }, async () => { throw new Error("Synthetic requirement analysis refuses external image reads"); });
  assistWorker = createWorker(QueueName.AiAssist, envelope => {
    const payload = envelope.payload as { operation?: unknown };
    if (envelope.tenantId !== identity.tenantId || envelope.requestedBy !== identity.userId || payload.operation !== "analyze")
      throw new Error("Synthetic requirement analysis refused an unexpected queue envelope");
    return processor.process(envelope);
  }, environment.redisUrl);
}
await worker.waitUntilReady();
await designWorker?.waitUntilReady();
await logisticsWorker?.waitUntilReady();
await assistWorker?.waitUntilReady();
dispatcher?.start(500);
process.stdout.write("PRODUCTION_EDITOR_WORKER_READY\n");
async function close() { try { await assistWorker?.close(); } finally { await dispatcher?.close(); await designWorker?.close(); await logisticsWorker?.close(); await worker.close(); await database.client.end(); } }
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
process.once("SIGINT", () => void close().finally(() => process.exit(0)));
