import { createHash } from "node:crypto";

import type { GeneratedImageResult } from "@yummyai/ai-core";
import {
  GeneratedImageProvenanceSchema,
  EntityIdSchema,
  createEntityId,
  type GeneratedImageProvenance,
  type TenantContext,
} from "@yummyai/contracts";
import type { JobEnvelope } from "@yummyai/jobs";
import { z } from "zod";

const ImageGenerationPayloadSchema = z.object({
  modelKey: z.string().min(1),
  promptTemplateVersion: z.string().min(1),
  userPrompt: z.string().min(1).max(8_000),
  referenceAssetIds: z.array(EntityIdSchema).max(16).default([]),
  maxCostUsd: z.number().positive().max(100),
});

export interface AuthorizedReferenceAsset {
  id: string;
  assetDomain: "research" | "authorized";
  version: number;
  checksumSha256: string;
  bytes: Uint8Array;
  mimeType: string;
  rights: {
    status: "unverified" | "approved" | "rejected";
    approvedBy?: string;
    approvedAt?: string;
    license?: string;
  };
}

export interface ImageReferenceRepository {
  load(context: Pick<TenantContext, "tenantId" | "userId">, assetIds: readonly string[]): Promise<readonly AuthorizedReferenceAsset[]>;
}

export interface ImageGenerationGateway {
  execute(
    context: Pick<TenantContext, "tenantId" | "userId">,
    request: {
      modelKey: string;
      prompt: string;
      referenceImages: Array<{ bytes: Uint8Array; mimeType: string }>;
      maxCostUsd: number;
    },
    signal: AbortSignal,
  ): Promise<GeneratedImageResult>;
}

export interface GeneratedImageStore {
  save(input: {
    context: Pick<TenantContext, "tenantId" | "userId">;
    bytes: Uint8Array;
    mimeType: GeneratedImageResult["mimeType"];
    provenance: GeneratedImageProvenance;
  }): Promise<void>;
}

export class ReferenceAssetRightsError extends Error {
  constructor(readonly assetId: string) {
    super(`Reference asset ${assetId} is not authorized with approved rights metadata`);
    this.name = "ReferenceAssetRightsError";
  }
}

export class ImageGenerationProcessor {
  constructor(
    private readonly gateway: ImageGenerationGateway,
    private readonly references: ImageReferenceRepository,
    private readonly images: GeneratedImageStore,
  ) {}

  async process(envelope: JobEnvelope, signal = new AbortController().signal): Promise<GeneratedImageProvenance> {
    const input = ImageGenerationPayloadSchema.parse(envelope.payload);
    const context = { tenantId: envelope.tenantId, userId: envelope.requestedBy };
    const references = await this.references.load(context, input.referenceAssetIds);
    assertReferenceAssets(input.referenceAssetIds, references);

    const result = await this.gateway.execute(context, {
      modelKey: input.modelKey,
      prompt: input.userPrompt,
      referenceImages: references.map((asset) => ({ bytes: asset.bytes, mimeType: asset.mimeType })),
      maxCostUsd: input.maxCostUsd,
    }, signal);
    const checksumSha256 = createHash("sha256").update(result.bytes).digest("hex");
    const provenance = GeneratedImageProvenanceSchema.parse({
      id: createEntityId(),
      providerId: result.providerId,
      modelKey: result.modelKey,
      promptTemplateVersion: input.promptTemplateVersion,
      userPrompt: input.userPrompt,
      revisedPrompt: result.revisedPrompt,
      providerRequestId: result.providerRequestId,
      referenceAssets: references.map((asset) => ({
        assetId: asset.id,
        version: asset.version,
        checksumSha256: asset.checksumSha256,
      })),
      costUsd: result.costUsd,
      seed: result.seed,
      createdBy: envelope.requestedBy,
      createdAt: new Date().toISOString(),
      checksumSha256,
      aiGenerated: true,
    });
    await this.images.save({ context, bytes: result.bytes, mimeType: result.mimeType, provenance });
    return provenance;
  }
}

function assertReferenceAssets(requestedIds: readonly string[], assets: readonly AuthorizedReferenceAsset[]): void {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  for (const id of requestedIds) {
    const asset = byId.get(id);
    if (
      !asset ||
      asset.assetDomain !== "authorized" ||
      asset.rights.status !== "approved" ||
      !asset.rights.approvedBy ||
      !asset.rights.approvedAt ||
      !asset.rights.license
    ) {
      throw new ReferenceAssetRightsError(id);
    }
  }
}
