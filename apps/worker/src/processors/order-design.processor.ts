import type { SecretVault } from "@yummyai/ai-core";
import { createEntityId } from "@yummyai/contracts";
import { modelProviderConfigs, modelRoutes, withTenant, type DatabaseConnection } from "@yummyai/database";
import { createQueue, createTraceId, enqueueJob, OrderDesignJobPayloadSchema, QueueName, type JobEnvelope } from "@yummyai/jobs";
import { dispatchOrderDesignOutbox, OrderDesignError, OrderDesignSubmissionNotSentError, type OrderDesignImageGateway, type OrderDesignModelResponseReceipt, type OrderDesignProcessor } from "@yummyai/order-design";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { HttpStudioGateway, type StudioGateway } from "./studio-generation.gateway.js";

export class OrderDesignQueueProcessor {
  constructor(private readonly processor: Pick<OrderDesignProcessor, "process">) {}
  process(envelope: JobEnvelope) {
    const { runId } = OrderDesignJobPayloadSchema.parse(envelope.payload);
    return this.processor.process({ tenantId: envelope.tenantId, requestedBy: envelope.requestedBy, runId });
  }
}

/** Re-check the pinned destination immediately before crossing the provider boundary. */
export class OrderDesignStudioGateway implements OrderDesignImageGateway {
  constructor(private readonly database: DatabaseConnection, private readonly vault: SecretVault, private readonly gateway: StudioGateway = new HttpStudioGateway()) {}
  async generate(input: Parameters<OrderDesignImageGateway["generate"]>[0]) {
    const prepared = await (async () => {
      input.signal.throwIfAborted();
      const selected = await withTenant(this.database.db, input.context, async tx => {
      const [route] = await tx.select().from(modelRoutes).where(and(eq(modelRoutes.id, input.model.routeId), eq(modelRoutes.status, "enabled"), eq(modelRoutes.taskType, "studio_image")));
      const [provider] = await tx.select().from(modelProviderConfigs).where(and(eq(modelProviderConfigs.id, input.model.providerConfigId), eq(modelProviderConfigs.status, "enabled")));
      if (!route || !provider || route.targets.length !== 1 || route.targets[0]!.providerConfigId !== provider.id
        || route.targets[0]!.providerModel !== input.model.model || provider.endpoint !== input.model.endpoint)
        throw new OrderDesignError("agent_model_configuration_changed");
      return provider;
      });
      const bytes = await sharp(input.bytes, { limitInputPixels: 100_000_000, failOn: "warning" }).rotate().png().toBuffer();
      input.signal.throwIfAborted();
      return { selected, bytes };
    })().catch(error => { throw new OrderDesignSubmissionNotSentError(error instanceof OrderDesignError ? error.code : input.signal.aborted ? "agent_model_cancelled_before_submission" : "agent_model_preparation_failed"); });
    const { selected } = prepared;
    let receipt:OrderDesignModelResponseReceipt|undefined;
    const output = await this.vault.withSecret(selected.encryptedApiKey, apiKey => this.gateway.generate({
      endpoint: selected.endpoint ?? "https://api.openai.com/v1", apiKey, model: input.model.model, capability: "image", providerTaskId: null,
      signal: input.signal, references: [{ bytes: prepared.bytes, mediaType: "image/png" }],
      input: { requestId: input.requestId, modelId: input.model.routeId, prompt: input.prompt, referenceKeys: [], size: input.size,
        quality: "high", background: input.transparent ? "transparent" : "auto", seconds: 4 },
    }, async () => undefined, async original => {
      receipt={requestId:input.requestId,...(original.costUsd!==null?{actualCostUsd:Number(original.costUsd)}:{}),tokenUsage:original.tokenUsage??null};
      await input.onReceipt?.(receipt);
    }));
    input.signal.throwIfAborted();
    if (!("bytes" in output) || !output.mediaType.startsWith("image/")) throw new OrderDesignError("agent_model_invalid_output", true);
    return { bytes: output.bytes,...(receipt?.actualCostUsd!==undefined?{actualCostUsd:receipt.actualCostUsd}:{}),tokenUsage:receipt?.tokenUsage??null };
  }
}

/** One local polling loop; multiple worker processes remain safe through durable IDs. */
export class RedisOrderDesignDispatcher {
  private readonly queue = createQueue(QueueName.OrderDesign);
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private closed = false;
  constructor(private readonly database: DatabaseConnection) {}
  start(intervalMs = 5_000) {
    if (this.timer || this.closed) return;
    const tick = () => { if (!this.pending && !this.closed) this.pending = this.flush().catch(() => {
      process.stderr.write("Order design dispatch unavailable; persisted tasks will be retried\n");
    }).finally(() => { this.pending = undefined; }); };
    tick();
    this.timer = setInterval(tick, intervalMs);
  }
  async flush() {
    await dispatchOrderDesignOutbox(this.database, { enqueue: async input => {
      await enqueueJob(this.queue, "order-design.execute", { attempt: 0, correlationId: input.runId, idempotencyKey: input.dispatchId,
        jobId: createEntityId(), maxAttempts: 3, payload: OrderDesignJobPayloadSchema.parse({ runId: input.runId }),
        requestedAt: new Date().toISOString(), requestedBy: input.requestedBy, tenantId: input.tenantId, traceId: createTraceId(),
      });
    } });
  }
  async close() { this.closed = true; clearInterval(this.timer); await this.pending; await this.queue.close(); }
}
