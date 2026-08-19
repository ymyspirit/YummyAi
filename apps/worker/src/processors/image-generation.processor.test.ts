import type { GeneratedImageResult } from "@yummyai/ai-core";
import type { JobEnvelope } from "@yummyai/jobs";
import { describe, expect, it } from "vitest";

import {
  ImageGenerationProcessor,
  ReferenceAssetRightsError,
  type AuthorizedReferenceAsset,
  type GeneratedImageStore,
  type ImageGenerationGateway,
} from "./image-generation.processor.js";

const ids = {
  job: "0198fbef-4a10-7000-8000-000000000011",
  tenant: "0198fbef-4a10-7000-8000-000000000012",
  user: "0198fbef-4a10-7000-8000-000000000013",
  trace: "123456789abcdef0123456789abcdef0",
  correlation: "0198fbef-4a10-7000-8000-000000000014",
  idempotency: "0198fbef-4a10-7000-8000-000000000015",
  asset: "0198fbef-4a10-7000-8000-000000000016",
};

describe("ImageGenerationProcessor", () => {
  it("rejects every reference that is not authorized with approved rights metadata", async () => {
    const reference = authorizedReference();
    reference.assetDomain = "research";
    const processor = new ImageGenerationProcessor(gateway(), { load: async () => [reference] }, store());

    await expect(processor.process(envelope())).rejects.toBeInstanceOf(ReferenceAssetRightsError);
  });

  it("stores complete generated-image provenance", async () => {
    const imageStore = store();
    const processor = new ImageGenerationProcessor(gateway(), { load: async () => [authorizedReference()] }, imageStore);

    const provenance = await processor.process(envelope());

    expect(provenance).toMatchObject({
      providerId: "image-provider",
      modelKey: "image.hero",
      promptTemplateVersion: "hero-v2",
      userPrompt: "Create a clean hero composition",
      revisedPrompt: "A revised safe composition",
      providerRequestId: "image-request-1",
      seed: "73",
      costUsd: 0.08,
      createdBy: ids.user,
      aiGenerated: true,
    });
    expect(provenance.referenceAssets).toEqual([{ assetId: ids.asset, version: 3, checksumSha256: "a".repeat(64) }]);
    expect(imageStore.saved?.provenance).toEqual(provenance);
  });
});

function gateway(): ImageGenerationGateway {
  return {
    execute: async (): Promise<GeneratedImageResult> => ({
      providerId: "image-provider",
      modelKey: "image.hero",
      bytes: Uint8Array.from([1, 2, 3]),
      mimeType: "image/png",
      revisedPrompt: "A revised safe composition",
      providerRequestId: "image-request-1",
      seed: "73",
      costUsd: 0.08,
    }),
  };
}

function store(): GeneratedImageStore & { saved?: Parameters<GeneratedImageStore["save"]>[0] } {
  const target: GeneratedImageStore & { saved?: Parameters<GeneratedImageStore["save"]>[0] } = {
    save: async (input) => { target.saved = input; },
  };
  return target;
}

function authorizedReference(): AuthorizedReferenceAsset {
  return {
    id: ids.asset,
    assetDomain: "authorized",
    version: 3,
    checksumSha256: "a".repeat(64),
    bytes: Uint8Array.from([9, 8, 7]),
    mimeType: "image/png",
    rights: {
      status: "approved",
      approvedBy: ids.user,
      approvedAt: "2026-07-18T01:00:00.000Z",
      license: "owned",
    },
  };
}

function envelope(): JobEnvelope {
  return {
    jobId: ids.job,
    tenantId: ids.tenant,
    requestedBy: ids.user,
    traceId: ids.trace,
    correlationId: ids.correlation,
    idempotencyKey: ids.idempotency,
    requestedAt: "2026-07-18T01:00:00.000Z",
    attempt: 0,
    maxAttempts: 3,
    payload: {
      modelKey: "image.hero",
      promptTemplateVersion: "hero-v2",
      userPrompt: "Create a clean hero composition",
      referenceAssetIds: [ids.asset],
      maxCostUsd: 1,
    },
  };
}
