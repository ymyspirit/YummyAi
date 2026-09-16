import { createHash } from "node:crypto";
import type { SecretVault } from "@yummyai/ai-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { assetFiles, creativeStudioEntries, creativeStudioGenerations as generations, creativeStudioRevisions, modelProviderConfigs, withTenant, type DatabaseConnection } from "@yummyai/database";
import type { JobEnvelope } from "@yummyai/jobs";
import { ClamAvScanner, type Storage } from "@yummyai/storage";
import { and, eq, isNull } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";
import { HttpStudioGateway, type StudioGateway, type StudioReference } from "./studio-generation.gateway.js";

type Generation = typeof generations.$inferSelect;
export class StudioGenerationProcessor {
  constructor(private readonly database: DatabaseConnection, private readonly storage: Storage, private readonly vault: SecretVault,
    private readonly gateway: StudioGateway = new HttpStudioGateway(), private readonly scanner: Pick<ClamAvScanner, "scan"> = new ClamAvScanner()) {}
  async process(envelope: JobEnvelope) {
    const { generationId: id } = z.object({ generationId: z.uuidv7() }).parse(envelope.payload);
    const context: TenantContext = { tenantId: envelope.tenantId, userId: envelope.requestedBy, dataScope: "tenant", permissions: ["design:read", "design:write", "asset:read", "asset:write"] };
    const row = await withTenant(this.database.db, context, async tx => {
      const [current] = await tx.select().from(generations).where(and(eq(generations.id, id), eq(generations.ownerId, context.userId))).for("update");
      if (!current || ["completed", "failed"].includes(current.status)) return null;
      if (current.status === "running" && !current.providerTaskId) {
        await tx.update(generations).set({ status: "failed", error: "studio_submission_interrupted", updatedAt: new Date() }).where(eq(generations.id, id));
        return null;
      }
      await tx.update(generations).set({ status: "running", updatedAt: new Date() }).where(eq(generations.id, id));
      return current;
    });
    if (!row) return { id, disposition: "already_claimed" };
    try {
      const [provider] = await withTenant(this.database.db, context, tx => tx.select().from(modelProviderConfigs).where(and(eq(modelProviderConfigs.id, row.modelSnapshot.providerConfigId), eq(modelProviderConfigs.status, "enabled"))));
      if (!provider || !["openai", "openai-compatible"].includes(provider.provider)) throw new Error("studio_provider_unavailable");
      const references = await this.references(context, row);
      const output = await this.vault.withSecret(provider.encryptedApiKey, apiKey => this.gateway.generate({
        endpoint: provider.endpoint ?? "https://api.openai.com/v1", apiKey, model: row.modelSnapshot.model, capability: row.modelSnapshot.capability,
        input: row.input, references, providerTaskId: row.providerTaskId,
      }, async taskId => { await withTenant(this.database.db, context, tx => tx.update(generations).set({ providerTaskId: taskId, updatedAt: new Date() }).where(and(eq(generations.id, id), eq(generations.status, "running")))); }));
      if ("text" in output) {
        await withTenant(this.database.db, context, tx => tx.update(generations).set({ status: "completed", resultText: output.text, updatedAt: new Date() }).where(and(eq(generations.id, id), eq(generations.status, "running"))));
      } else {
        if (!output.bytes.length || output.bytes.length > 20 * 1024 * 1024) throw new Error("studio_result_too_large");
        if (output.mediaType.startsWith("image/")) {
          const image = sharp(output.bytes, { limitInputPixels: 64_000_000, failOn: "error" });
          const meta = await image.metadata();
          if (`image/${meta.format}` !== output.mediaType || (meta.pages ?? 1) !== 1) throw new Error("studio_provider_invalid_result");
          await image.stats();
        } else if (output.mediaType !== "video/mp4" || output.bytes.subarray(4, 8).toString() !== "ftyp") throw new Error("studio_provider_invalid_result");
        if ((await this.scanner.scan({ body: output.bytes, fileName: "studio-result", mediaType: output.mediaType })).result !== "clean") throw new Error("studio_result_scan_failed");
        await this.references(context, row);
        const fileName = `studio-${id}.${output.mediaType.split("/")[1]}`, assetId = createEntityId(), entryId = createEntityId();
        const stored = await this.storage.putPrivate(context, { body: output.bytes, domain: "authorized", fileName, mediaType: output.mediaType });
        await withTenant(this.database.db, context, async tx => {
          const [current] = await tx.select().from(generations).where(eq(generations.id, id)).for("update");
          if (current?.status !== "running") return;
          await tx.insert(assetFiles).values({ id: assetId, tenantId: context.tenantId, ownerUserId: context.userId, objectKey: stored.objectKey, fileName, assetDomain: "authorized", mediaType: output.mediaType, byteSize: output.bytes.length, checksumSha256: createHash("sha256").update(output.bytes).digest("hex"), aiGenerated: true, rightsStatus: "unverified", rightsMetadata: { source: { kind: "ai_generated", reference: `studio:${id}` }, studioScope: row.scope, generationId: id, model: row.modelSnapshot.model, references: row.references } });
          const image = output.mediaType.startsWith("image/");
          await tx.insert(creativeStudioEntries).values({ id: entryId, tenantId: context.tenantId, ownerId: context.userId, scope: row.scope, namespace: image ? "image_files" : "media_files", key: `${image ? "image" : "video"}:${id}`, revision: 1, assetId });
          await tx.insert(creativeStudioRevisions).values({ id: createEntityId(), tenantId: context.tenantId, entryId, revision: 1, assetId });
          await tx.update(generations).set({ status: "completed", assetId, updatedAt: new Date() }).where(eq(generations.id, id));
        });
      }
      return { id, disposition: "completed" };
    } catch (cause) {
      const error = cause instanceof Error && /^studio_[a-z_0-9]+$/.test(cause.message) ? cause.message : "studio_generation_failed";
      await withTenant(this.database.db, context, tx => tx.update(generations).set({ status: "failed", error, updatedAt: new Date() }).where(and(eq(generations.id, id), eq(generations.status, "running"))));
      // Never propagate a provider body, URL, authorization header or prompt into queue logs.
      throw new Error(error);
    }
  }
  private async references(context: TenantContext, row: Generation): Promise<StudioReference[]> {
    const result: StudioReference[] = [];
    for (const pin of row.references) {
      const [asset] = await withTenant(this.database.db, context, tx => tx.select().from(assetFiles).where(and(eq(assetFiles.id, pin.assetId), isNull(assetFiles.deletedAt))));
      const source = asset?.rightsMetadata.source as { kind?: string } | undefined;
      if (!asset || asset.assetDomain !== "authorized" || asset.rightsStatus !== "approved" || asset.version !== pin.version || asset.checksumSha256 !== pin.checksum || !asset.mediaType.startsWith("image/") || !["owned", "licensed", "ai_generated"].includes(source?.kind ?? "")) throw new Error("studio_reference_changed");
      const bytes = Buffer.from(await this.storage.readPrivate(context, { ...asset, assetDomain: "authorized" }, { requiredDomain: "authorized" }));
      if (createHash("sha256").update(bytes).digest("hex") !== pin.checksum) throw new Error("studio_reference_changed");
      result.push({ bytes, mediaType: asset.mediaType });
    }
    return result;
  }
}
