import { createHash } from "node:crypto";
import type { SecretVault } from "@yummyai/ai-core";
import { createEntityId } from "@yummyai/contracts";
import { creativeStudioEntries, creativeStudioGenerations as generations, creativeStudioRevisions, modelProviderConfigs,
  type DatabaseConnection } from "@yummyai/database";
import type { JobEnvelope } from "@yummyai/jobs";
import { ClamAvScanner, type Storage } from "@yummyai/storage";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";
import { HttpStudioGateway, type StudioGateway } from "./studio-generation.gateway.js";
import { CreativeExecutionRecovery, type CreativeExecutionClaim } from "./creative-execution-recovery.js";
import { creativeOwnerRunning, creativeOwnerStopped } from "./creative-execution-owner-state.js";
import { readCreativeAssets } from "./creative-execution-assets.js";
import { decodeCreativeOutputs, parseCreativeResponse } from "./creative-execution-response.js";
import { creativeFailure } from "./creative-execution-pod.js";
import { podInvocationReceipt } from "./pod-invocation-receipt.js";
import type { CreativeOperation } from "@yummyai/pod-core";

export class StudioGenerationProcessor {
  private readonly recovery: CreativeExecutionRecovery;
  constructor(database: DatabaseConnection, private readonly storage: Storage, private readonly modelVault: SecretVault,
    private readonly gateway: StudioGateway = new HttpStudioGateway(), scanner: Pick<ClamAvScanner, "scan"> = new ClamAvScanner(),
    executionVault?: SecretVault) {
    this.recovery = new CreativeExecutionRecovery(database, storage, executionVault, creativeOwnerStopped, scanner);
  }
  async process(envelope: JobEnvelope, signal = new AbortController().signal) {
    const { generationId: id } = z.object({ generationId: z.uuidv7() }).strict().parse(envelope.payload);
    const identity = { tenantId: envelope.tenantId, userId: envelope.requestedBy };
    const operation: CreativeOperation = { kind: "studio_generation", ownerId: id, stepKey: "generate" };
    let claim: CreativeExecutionClaim | undefined;
    try {
      claim = await this.recovery.claim(identity, operation, (tx, admission) => creativeOwnerRunning(tx, admission.execution));
      if (!claim) return { id, disposition: "already_claimed" as const };
      return await this.recovery.withLease(identity, claim, signal, async executionSignal => {
        const loaded = await this.recovery.authorized(identity, claim!, async (tx, admission) => {
          const [generation] = await tx.select().from(generations).where(eq(generations.id, id));
          const [provider] = await tx.select().from(modelProviderConfigs).where(eq(modelProviderConfigs.id, generation!.modelSnapshot.providerConfigId));
          return { generation: generation!, provider: provider!, receipt: admission.execution.receipt };
        });
        const row = loaded.generation;
        if (!claim!.hasResponse) {
          const files = await readCreativeAssets(this.recovery, this.storage, identity, claim!, row.references.map(ref => ref.assetId));
          if (!claim!.submissionToken) await this.recovery.markSubmitted(identity, claim!, {
            taskType: `studio_${row.modelSnapshot.capability}`, modelKey: row.modelSnapshot.model, provider: loaded.provider.provider,
            ...(row.modelSnapshot.visualCeilingUsd === undefined ? {} : { ceilingUsd: row.modelSnapshot.visualCeilingUsd.toFixed(6) }),
          });
          let receipt = loaded.receipt, providerTaskId = row.providerTaskId;
          const output = await this.modelVault.withSecret(loaded.provider.encryptedApiKey, apiKey => this.gateway.generate({
            endpoint: loaded.provider.endpoint ?? "https://api.openai.com/v1", apiKey, model: row.modelSnapshot.model,
            capability: row.modelSnapshot.capability, input: row.input, references: files.map(file => ({ bytes: Buffer.from(file.input.bytes), mediaType: file.input.mediaType })),
            textProtocol: loaded.provider.provider === "openai" ? "responses" : "chat_completions",
            providerTaskId, originalReceipt: receipt, signal: executionSignal,
          }, async taskId => { await this.recovery.rememberStudioTask(identity, claim!, taskId); providerTaskId = taskId; },
          async original => { await this.recovery.record(identity, claim!, undefined, original); receipt = original; }));
          // Adapters without receipt support explicitly retain unknown billing/model-version evidence.
          receipt ??= podInvocationReceipt({ modelKey: row.modelSnapshot.model }, createHash("sha256").update("text" in output ? output.text : output.bytes).digest("hex"));
          const response = parseCreativeResponse({ version: "creative-response-v1", kind: "studio", receipt, providerTaskId,
            text: "text" in output ? output.text : null,
            outputs: "text" in output ? [] : [{ dataBase64: output.bytes.toString("base64"), mediaType: output.mediaType, role: row.modelSnapshot.capability }],
          });
          await this.recovery.record(identity, claim!, response, receipt);
        }
        const response = await this.recovery.read(identity, claim!);
        if (response.kind !== "studio") throw new Error("CREATIVE_RESPONSE_INVALID");
        if (response.text !== null) {
          if (row.modelSnapshot.capability !== "text" || !response.text.trim()) throw new Error("CREATIVE_RESPONSE_INVALID");
          await this.recovery.complete(identity, claim!, [], async tx => {
            await tx.update(generations).set({ status: "completed", resultText: response.text, error: null, updatedAt: new Date() }).where(eq(generations.id, id));
            return { generationId: id, textChecksum: createHash("sha256").update(response.text!).digest("hex") };
          });
        } else {
          const outputs = decodeCreativeOutputs(response), output = outputs[0]!;
          if (outputs.length !== 1 || output.bytes.length > 20 * 1024 * 1024) throw new Error("CREATIVE_RESPONSE_INVALID");
          if (row.modelSnapshot.capability === "image" && ["image/png", "image/jpeg", "image/webp"].includes(output.mediaType)) {
            const image = sharp(output.bytes, { limitInputPixels: 64_000_000, failOn: "error" }), metadata = await image.metadata();
            if (`image/${metadata.format}` !== output.mediaType || (metadata.pages ?? 1) !== 1) throw new Error("CREATIVE_RESPONSE_INVALID");
            await image.stats();
          } else if (row.modelSnapshot.capability !== "video" || output.mediaType !== "video/mp4" || Buffer.from(output.bytes).subarray(4, 8).toString() !== "ftyp")
            throw new Error("CREATIVE_RESPONSE_INVALID");
          const image = output.mediaType.startsWith("image/");
          await this.recovery.complete(identity, claim!, [{ ...output, aiGenerated: true, rightsStatus: "unverified",
            rightsMetadata: { source: { kind: "ai_generated", reference: `studio:${id}` }, studioScope: row.scope, generationId: id,
              model: row.modelSnapshot.model, modelVersion: response.receipt.modelVersion, references: row.references } }],
            async (tx, _admission, assets) => {
              const asset = assets[0]!, entryId = createEntityId();
              await tx.insert(creativeStudioEntries).values({ id: entryId, tenantId: identity.tenantId, ownerId: identity.userId,
                scope: row.scope, namespace: image ? "image_files" : "media_files", key: `${image ? "image" : "video"}:${id}`, revision: 1, assetId: asset.id });
              await tx.insert(creativeStudioRevisions).values({ id: createEntityId(), tenantId: identity.tenantId, entryId, revision: 1, assetId: asset.id });
              await tx.update(generations).set({ status: "completed", assetId: asset.id, error: null, updatedAt: new Date() }).where(eq(generations.id, id));
              return { generationId: id, assetId: asset.id };
            });
        }
        return { id, disposition: "completed" as const };
      });
    } catch (cause) {
      const failure = creativeFailure(cause), result = await this.recovery.fail(identity, operation, claim, failure.code, failure.permanent);
      if (result === "deferred") return { id, disposition: "recovery_pending" as const };
      throw new Error("studio_generation_failed");
    }
  }
}
