import { createHash } from "node:crypto";

import { SecretVault } from "@yummyai/ai-core";
import { createEntityId, type OrderPersonalizationResolutionSnapshot } from "@yummyai/contracts";
import type { JobEnvelope } from "@yummyai/jobs";
import { describe, expect, it, vi } from "vitest";

import {
  OrderPersonalizationRenderProcessor,
  type OrderPersonalizationRenderExecutionRecord,
  type OrderPersonalizationRenderGateway,
  type OrderPersonalizationRenderRepository,
  type OrderPersonalizationRenderTaskRecord,
} from "./order-personalization-render.processor.js";
import type { PodArtworkExecutionResult } from "./pod-artwork.processor.js";

describe("OrderPersonalizationRenderProcessor", () => {
  const vault = new SecretVault(Buffer.alloc(32, 51));

  it("decrypts a pinned v2 resolution only after claim and stores a reviewable result", async () => {
    const fixture = renderFixture(vault);
    const repository = fakeRepository(fixture.task, fixture.execution);
    const gateway = fakeGateway();
    const processor = new OrderPersonalizationRenderProcessor(repository, gateway, vault);

    await expect(processor.process(envelope(fixture.task.id))).resolves.toMatchObject({
      disposition: "awaiting_review",
      outputCount: 1,
    });
    expect(repository.hydrate).toHaveBeenCalledWith(
      expect.anything(),
      fixture.task,
      expect.objectContaining({ version: 2, orderLineId: fixture.task.orderLineId }),
    );
    expect(gateway.execute).toHaveBeenCalledOnce();
    expect(repository.complete).toHaveBeenCalledOnce();
  });

  it("fails closed before decryption when the encrypted snapshot checksum changes", async () => {
    const fixture = renderFixture(vault);
    fixture.task.resolutionChecksum = "0".repeat(64);
    const repository = fakeRepository(fixture.task, fixture.execution);
    const gateway = fakeGateway();
    const processor = new OrderPersonalizationRenderProcessor(repository, gateway, vault);

    await expect(processor.process(envelope(fixture.task.id))).rejects.toThrow("no longer matches");
    expect(repository.hydrate).not.toHaveBeenCalled();
    expect(gateway.execute).not.toHaveBeenCalled();
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), fixture.task.id, expect.objectContaining({
      terminal: true,
      code: "RESOLUTION_CHECKSUM_MISMATCH",
    }));
  });

  it("retries infrastructure errors with a generic non-PII diagnostic", async () => {
    const fixture = renderFixture(vault);
    const repository = fakeRepository(fixture.task, fixture.execution);
    const gateway = fakeGateway();
    vi.mocked(gateway.execute).mockRejectedValueOnce(new Error("processor included private upstream detail"));
    const processor = new OrderPersonalizationRenderProcessor(repository, gateway, vault);

    await expect(processor.process(envelope(fixture.task.id))).rejects.toThrow();
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), fixture.task.id, {
      attempt: 0,
      terminal: false,
      code: "ERROR",
      message: "Order personalization rendering could not complete",
    });
  });

  it("fails terminally when a processor performs AI inference without pinned consent", async () => {
    const fixture = renderFixture(vault);
    const repository = fakeRepository(fixture.task, fixture.execution);
    const gateway = fakeGateway();
    vi.mocked(gateway.execute).mockResolvedValueOnce({
      outputs: [{
        bytes: Uint8Array.from([1, 2, 3]),
        mediaType: "image/png",
        role: "effect",
        fileName: "preview.png",
        metadata: {
          width: 1000,
          height: 1000,
          unit: "px",
          dpi: 300,
          colorMode: "rgb",
          transparent: true,
          aiInference: "full",
        },
      }],
      modelKey: "order-renderer",
      modelVersion: "1.0.0",
      qualityCheckSnapshot: { passed: true },
      partial: false,
    });
    const processor = new OrderPersonalizationRenderProcessor(repository, gateway, vault);

    await expect(processor.process(envelope(fixture.task.id))).rejects.toThrow("not enabled");
    expect(repository.complete).not.toHaveBeenCalled();
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), fixture.task.id, expect.objectContaining({
      terminal: true,
      code: "UNAUTHORIZED_AI_INFERENCE",
    }));
  });

  it("accepts a group photo only when every output proves all distinct people were preserved", async () => {
    const fixture = creativeFixture(vault, "group_photo");
    const repository = fakeRepository(fixture.task, fixture.execution);
    const gateway = fakeGateway();
    vi.mocked(gateway.execute).mockResolvedValueOnce(creativeResult("group_photo", ["customer.person.1", "customer.person.2"]));
    const processor = new OrderPersonalizationRenderProcessor(repository, gateway, vault);

    await expect(processor.process(envelope(fixture.task.id))).resolves.toMatchObject({ disposition: "awaiting_review" });
    expect(repository.complete).toHaveBeenCalledWith(expect.anything(), fixture.execution, expect.objectContaining({
      qualityCheckSnapshot: {
        passed: true,
        outputChecks: [expect.objectContaining({
          usedInputStableKeys: ["customer.person.1", "customer.person.2"],
          identityPreserved: true,
          subjectCountMatched: true,
          noAddedSubjects: true,
          duplicateSubjectsDetected: false,
        })],
      },
    }));
    const stored = vi.mocked(repository.complete).mock.calls[0]?.[2].qualityCheckSnapshot;
    expect(stored).not.toHaveProperty("providerPrivateDetail");
  });

  it("fails a group photo when one customer image is reused as two people", async () => {
    const fixture = creativeFixture(vault, "group_photo", true);
    const repository = fakeRepository(fixture.task, fixture.execution);
    const gateway = fakeGateway();
    vi.mocked(gateway.execute).mockResolvedValueOnce(creativeResult("group_photo", ["customer.person.1", "customer.person.2"]));
    const processor = new OrderPersonalizationRenderProcessor(repository, gateway, vault);

    await expect(processor.process(envelope(fixture.task.id))).rejects.toThrow("cannot reuse");
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), fixture.task.id, expect.objectContaining({
      terminal: true,
      code: "GROUP_PHOTO_DUPLICATE_INPUT",
    }));
  });

  it("fails a group photo when an output does not prove every customer image was used", async () => {
    const fixture = creativeFixture(vault, "group_photo");
    const repository = fakeRepository(fixture.task, fixture.execution);
    const gateway = fakeGateway();
    vi.mocked(gateway.execute).mockResolvedValueOnce(creativeResult("group_photo", ["customer.person.1"]));
    const processor = new OrderPersonalizationRenderProcessor(repository, gateway, vault);

    await expect(processor.process(envelope(fixture.task.id))).rejects.toThrow("all pinned customer image slots");
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), fixture.task.id, expect.objectContaining({
      terminal: true,
      code: "CREATIVE_INPUT_EVIDENCE_MISMATCH",
    }));
  });

  it("accepts pet outfit output only with identity, markings, body shape, and reference isolation evidence", async () => {
    const fixture = creativeFixture(vault, "pet_outfit");
    const repository = fakeRepository(fixture.task, fixture.execution);
    const gateway = fakeGateway();
    vi.mocked(gateway.execute).mockResolvedValueOnce(creativeResult("pet_outfit", ["customer.pet"]));
    const processor = new OrderPersonalizationRenderProcessor(repository, gateway, vault);

    await expect(processor.process(envelope(fixture.task.id))).resolves.toMatchObject({ disposition: "awaiting_review" });
    expect(repository.complete).toHaveBeenCalledWith(expect.anything(), fixture.execution, expect.objectContaining({
      qualityCheckSnapshot: expect.objectContaining({
        outputChecks: [expect.objectContaining({
          referenceIdentityTransferred: false,
          coatPatternPreserved: true,
          bodyShapePreserved: true,
        })],
      }),
    }));
  });

  it("fails closed when pet outfit evidence reports reference identity transfer", async () => {
    const fixture = creativeFixture(vault, "pet_outfit");
    const repository = fakeRepository(fixture.task, fixture.execution);
    const gateway = fakeGateway();
    const result = creativeResult("pet_outfit", ["customer.pet"]);
    const outputChecks = result.qualityCheckSnapshot.outputChecks as Array<Record<string, unknown>>;
    outputChecks[0]!.referenceIdentityTransferred = true;
    vi.mocked(gateway.execute).mockResolvedValueOnce(result);
    const processor = new OrderPersonalizationRenderProcessor(repository, gateway, vault);

    await expect(processor.process(envelope(fixture.task.id))).rejects.toThrow("quality evidence");
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), fixture.task.id, expect.objectContaining({
      terminal: true,
      code: "CREATIVE_QUALITY_EVIDENCE_INVALID",
    }));
  });

  it("accepts a complete SVG only when template, inputs, canvas, and production checks are pinned", async () => {
    const fixture = vectorFixture(vault);
    const repository = fakeRepository(fixture.task, fixture.execution);
    const gateway = fakeGateway();
    vi.mocked(gateway.execute).mockResolvedValueOnce(vectorResult());
    const processor = new OrderPersonalizationRenderProcessor(repository, gateway, vault);

    await expect(processor.process(envelope(fixture.task.id))).resolves.toMatchObject({
      disposition: "awaiting_review",
      outputCount: 1,
    });
    expect(repository.complete).toHaveBeenCalledWith(expect.anything(), fixture.execution, expect.objectContaining({
      outputs: [expect.objectContaining({ mediaType: "image/svg+xml", role: "production", fileName: "production.svg" })],
      qualityCheckSnapshot: expect.objectContaining({
        passed: true,
        exportReady: true,
        textConvertedToPaths: true,
        rasterImagesEmbedded: false,
        outputChecks: [expect.objectContaining({
          usedInputStableKeys: ["customer.name"],
          width: 300,
          height: 400,
          unit: "mm",
        })],
      }),
    }));
  });

  it("fails before calling the processor when vector fulfillment has no approved SVG template source", async () => {
    const fixture = vectorFixture(vault);
    delete fixture.execution.templateSource;
    const repository = fakeRepository(fixture.task, fixture.execution);
    const gateway = fakeGateway();
    const processor = new OrderPersonalizationRenderProcessor(repository, gateway, vault);

    await expect(processor.process(envelope(fixture.task.id))).rejects.toThrow("requires the pinned template source");
    expect(gateway.execute).not.toHaveBeenCalled();
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), fixture.task.id, expect.objectContaining({
      terminal: true,
      code: "VECTOR_TEMPLATE_REQUIRED",
    }));
  });

  it("fails closed when a vector output contains executable SVG markup", async () => {
    const fixture = vectorFixture(vault);
    const repository = fakeRepository(fixture.task, fixture.execution);
    const gateway = fakeGateway();
    const result = vectorResult();
    result.outputs[0]!.bytes = new TextEncoder().encode('<svg viewBox="0 0 300 400"><script>alert(1)</script></svg>');
    vi.mocked(gateway.execute).mockResolvedValueOnce(result);
    const processor = new OrderPersonalizationRenderProcessor(repository, gateway, vault);

    await expect(processor.process(envelope(fixture.task.id))).rejects.toThrow("unsafe executable");
    expect(repository.complete).not.toHaveBeenCalled();
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), fixture.task.id, expect.objectContaining({
      terminal: true,
      code: "VECTOR_OUTPUT_UNSAFE_MARKUP",
    }));
  });
});

function renderFixture(vault: SecretVault) {
  const resolution: OrderPersonalizationResolutionSnapshot = {
    version: 2,
    orderId: createEntityId(),
    orderLineId: createEntityId(),
    customizationVersionId: createEntityId(),
    templateVersionId: createEntityId(),
    slots: [{ slotId: createEntityId(), stableKey: "customer.name", kind: "text", value: "Private Customer" }],
  };
  const encryptedResolution = vault.encrypt(JSON.stringify(resolution));
  const task: OrderPersonalizationRenderTaskRecord = {
    id: createEntityId(),
    designTaskId: createEntityId(),
    batchItemId: createEntityId(),
    toolKey: "image_composite",
    parameterSnapshot: {
      outputFormat: "png",
      fitMode: "template",
      autoComposition: "off",
      allowAiEnhancement: false,
      identityMode: "standard",
      customerAssetUsage: "mapped",
      referenceIdentityTransfer: "not_applicable",
    },
    encryptedResolution,
    resolutionChecksum: createHash("sha256").update(encryptedResolution).digest("hex"),
    orderId: resolution.orderId,
    orderLineId: resolution.orderLineId,
    customizationVersionId: resolution.customizationVersionId,
    templateVersionId: resolution.templateVersionId,
    maxAttempts: 3,
  };
  const execution: OrderPersonalizationRenderExecutionRecord = {
    ...task,
    resolution,
    canvas: { width: 1000, height: 1000, dpi: 300, colorMode: "rgb" },
    slots: [],
    customerAssets: [],
  };
  return { task, execution };
}

function creativeFixture(
  vault: SecretVault,
  toolKey: "group_photo" | "pet_outfit",
  duplicateGroupInput = false,
) {
  const base = renderFixture(vault);
  const firstAssetId = createEntityId();
  const secondAssetId = duplicateGroupInput ? firstAssetId : createEntityId();
  const slotInputs = toolKey === "group_photo"
    ? [
      { stableKey: "customer.person.1", assetId: firstAssetId },
      { stableKey: "customer.person.2", assetId: secondAssetId },
    ]
    : [{ stableKey: "customer.pet", assetId: firstAssetId }];
  const resolution: OrderPersonalizationResolutionSnapshot = {
    ...base.execution.resolution,
    slots: slotInputs.map((input) => ({
      slotId: createEntityId(),
      stableKey: input.stableKey,
      kind: "image" as const,
      assetId: input.assetId,
      assetVersion: 1,
      checksumSha256: "b".repeat(64),
      mediaType: "image/png",
    })),
  };
  const encryptedResolution = vault.encrypt(JSON.stringify(resolution));
  const task: OrderPersonalizationRenderTaskRecord = {
    ...base.task,
    toolKey,
    parameterSnapshot: {
      outputFormat: "png",
      fitMode: "template",
      autoComposition: "subject_focus",
      allowAiEnhancement: true,
      identityMode: "strict",
      customerAssetUsage: "all",
      referenceIdentityTransfer: toolKey === "pet_outfit" ? "forbid" : "not_applicable",
    },
    encryptedResolution,
    resolutionChecksum: createHash("sha256").update(encryptedResolution).digest("hex"),
  };
  const uniqueAssets = [...new Set(slotInputs.map((input) => input.assetId))];
  const execution: OrderPersonalizationRenderExecutionRecord = {
    ...base.execution,
    ...task,
    resolution,
    customerAssets: uniqueAssets.map((assetId) => ({
      id: assetId,
      version: 1,
      checksumSha256: "b".repeat(64),
      mediaType: "image/png",
      bytes: Uint8Array.from([1, 2, 3]),
    })),
  };
  return { task, execution };
}

function creativeResult(
  toolKey: "group_photo" | "pet_outfit",
  usedInputStableKeys: string[],
): PodArtworkExecutionResult {
  return {
    outputs: [{
      bytes: Uint8Array.from([1, 2, 3]),
      mediaType: "image/png",
      role: "effect",
      fileName: "creative.png",
      metadata: {
        width: 1000,
        height: 1000,
        unit: "px",
        dpi: 300,
        colorMode: "rgb",
        transparent: false,
        aiInference: "full",
      },
    }],
    modelKey: "creative-order-renderer",
    modelVersion: "1.0.0",
    qualityCheckSnapshot: {
      passed: true,
      providerPrivateDetail: "must be discarded",
      outputChecks: [{
        fileName: "creative.png",
        usedInputStableKeys,
        identityPreserved: true,
        ...(toolKey === "group_photo" ? {
          subjectCountMatched: true,
          noAddedSubjects: true,
          duplicateSubjectsDetected: false,
        } : {
          referenceIdentityTransferred: false,
          coatPatternPreserved: true,
          bodyShapePreserved: true,
        }),
      }],
    },
    partial: false,
  };
}

function vectorFixture(vault: SecretVault) {
  const base = renderFixture(vault);
  const task: OrderPersonalizationRenderTaskRecord = {
    ...base.task,
    toolKey: "vector_fulfillment",
    parameterSnapshot: {
      outputFormat: "svg",
      fitMode: "template",
      autoComposition: "off",
      allowAiEnhancement: false,
      identityMode: "standard",
      customerAssetUsage: "mapped",
      referenceIdentityTransfer: "not_applicable",
      colorMode: "spot",
      transparent: true,
      vectorTemplateProfile: "laser-cut-v1",
      vectorWidth: 300,
      vectorHeight: 400,
      vectorUnit: "mm",
      vectorLayoutMode: "template",
      textToPath: true,
      hollowMode: true,
      bridgeWidthMm: 1.5,
      minimumLineWidthMm: 0.3,
      pathRepair: "safe",
    },
  };
  const execution: OrderPersonalizationRenderExecutionRecord = {
    ...base.execution,
    ...task,
    templateSource: {
      id: createEntityId(),
      version: 1,
      checksumSha256: "c".repeat(64),
      mediaType: "image/svg+xml",
      bytes: new TextEncoder().encode('<svg viewBox="0 0 300 400"></svg>'),
    },
  };
  return { task, execution };
}

function vectorResult(): PodArtworkExecutionResult {
  return {
    outputs: [{
      bytes: new TextEncoder().encode('<svg viewBox="0 0 300 400"><path d="M0 0H300V400H0Z"/></svg>'),
      mediaType: "image/svg+xml",
      role: "production",
      fileName: "production.svg",
      metadata: {
        width: 300,
        height: 400,
        unit: "mm",
        colorMode: "spot",
        transparent: true,
        aiInference: "none",
      },
    }],
    modelKey: "deterministic-vector-renderer",
    modelVersion: "1.0.0",
    qualityCheckSnapshot: {
      passed: true,
      exportReady: true,
      templateProfileMatched: true,
      canvasMatched: true,
      textConvertedToPaths: true,
      authorizedFontsOnly: true,
      pathsClosed: true,
      selfIntersectionsDetected: false,
      duplicatePathsDetected: false,
      isolatedNodesDetected: false,
      holeDirectionsValid: true,
      minimumLineWidthPassed: true,
      minimumBridgeWidthPassed: true,
      outOfBoundsDetected: false,
      rasterImagesEmbedded: false,
      repairs: ["close_path"],
      outputChecks: [{
        fileName: "production.svg",
        usedInputStableKeys: ["customer.name"],
        width: 300,
        height: 400,
        unit: "mm",
        viewBox: "0 0 300 400",
        pathCount: 1,
        minimumLineWidthMm: 0.3,
        minimumBridgeWidthMm: 1.5,
      }],
    },
    partial: false,
  };
}

function fakeRepository(
  task: OrderPersonalizationRenderTaskRecord,
  execution: OrderPersonalizationRenderExecutionRecord,
): OrderPersonalizationRenderRepository {
  return {
    load: vi.fn(async () => task),
    claim: vi.fn(async () => true),
    hydrate: vi.fn(async () => execution),
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
  };
}

function fakeGateway(): OrderPersonalizationRenderGateway {
  const result: PodArtworkExecutionResult = {
    outputs: [{
      bytes: Uint8Array.from([1, 2, 3]),
      mediaType: "image/png",
      role: "effect",
      fileName: "preview.png",
      metadata: {
        width: 1000,
        height: 1000,
        unit: "px",
        dpi: 300,
        colorMode: "rgb",
        transparent: true,
        aiInference: "none",
      },
    }],
    modelKey: "order-renderer",
    modelVersion: "1.0.0",
    qualityCheckSnapshot: { passed: true },
    partial: false,
  };
  return {
    execute: vi.fn(async () => result),
  };
}

function envelope(renderTaskId: string): JobEnvelope {
  return {
    jobId: createEntityId(),
    tenantId: createEntityId(),
    requestedBy: createEntityId(),
    traceId: "0123456789abcdef0123456789abcdef",
    correlationId: renderTaskId,
    idempotencyKey: renderTaskId,
    requestedAt: new Date().toISOString(),
    attempt: 0,
    maxAttempts: 3,
    payload: { renderTaskId },
  };
}
