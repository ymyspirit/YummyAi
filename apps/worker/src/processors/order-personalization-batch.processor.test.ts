import { SecretVault } from "@yummyai/ai-core";
import { createHash } from "node:crypto";
import { createEntityId, type CustomizationDefinition, type TemplateSlot } from "@yummyai/contracts";
import type { JobEnvelope } from "@yummyai/jobs";
import { describe, expect, it, vi } from "vitest";

import {
  OrderPersonalizationBatchProcessor,
  type OrderPersonalizationBatchRepository,
  type OrderPersonalizationItemSnapshot,
} from "./order-personalization-batch.processor.js";

describe("OrderPersonalizationBatchProcessor", () => {
  const vault = new SecretVault(Buffer.alloc(32, 41));

  it("decrypts customer values only for resolution and stores a new encrypted snapshot", async () => {
    const snapshot = itemSnapshot(vault);
    const repository = fakeRepository(snapshot);
    const processor = new OrderPersonalizationBatchProcessor(repository, vault);

    await expect(processor.process(envelope())).resolves.toMatchObject({
      disposition: "completed",
      preparedCount: 1,
      failedCount: 0,
    });

    expect(repository.completeItem).toHaveBeenCalledOnce();
    const result = vi.mocked(repository.completeItem).mock.calls[0]![2];
    expect(result.encryptedResolution).not.toContain("Private Customer");
    expect(result.resolutionChecksum).toBe(createHash("sha256").update(result.encryptedResolution).digest("hex"));
    const decrypted = vault.withSecret(result.encryptedResolution, (plaintext) => JSON.parse(plaintext) as {
      version: number;
      slots: Array<{ kind: string; value?: string; assetId?: string }>;
    });
    expect(decrypted.version).toBe(2);
    expect(decrypted.slots).toEqual([
      expect.objectContaining({ kind: "text", value: "Private Customer" }),
      expect.objectContaining({ kind: "image", assetId: snapshot.files[0]!.assetId }),
    ]);
    expect(repository.failItem).not.toHaveBeenCalled();
  });

  it("isolates a row with an invalid customer-file mapping without failing the batch job", async () => {
    const snapshot = { ...itemSnapshot(vault), files: [] };
    const repository = fakeRepository(snapshot, { preparedCount: 0, failedCount: 1 });
    const processor = new OrderPersonalizationBatchProcessor(repository, vault);

    await expect(processor.process(envelope())).resolves.toMatchObject({ failedCount: 1 });
    expect(repository.completeItem).not.toHaveBeenCalled();
    expect(repository.failItem).toHaveBeenCalledWith(
      expect.anything(),
      snapshot.id,
      { code: "TEMPLATE_MAPPING_INVALID", message: expect.any(String) },
    );
  });

  it("retries infrastructure failures without recording customer values in diagnostics", async () => {
    const snapshot = itemSnapshot(vault);
    const repository = fakeRepository(snapshot);
    vi.mocked(repository.loadItem).mockRejectedValueOnce(new Error("database unavailable"));
    const processor = new OrderPersonalizationBatchProcessor(repository, vault);

    await expect(processor.process(envelope())).rejects.toThrow("database unavailable");
    expect(repository.retryOrFail).toHaveBeenCalledWith(expect.anything(), expect.any(String), {
      terminal: false,
      code: "ERROR",
      message: "Order personalization preparation could not complete",
    });
  });
});

function fakeRepository(
  snapshot: OrderPersonalizationItemSnapshot,
  counts = { preparedCount: 1, failedCount: 0 },
): OrderPersonalizationBatchRepository {
  return {
    claim: vi.fn(async () => [snapshot.id]),
    loadItem: vi.fn(async () => snapshot),
    completeItem: vi.fn(async () => undefined),
    failItem: vi.fn(async () => undefined),
    finalize: vi.fn(async () => counts),
    retryOrFail: vi.fn(async () => undefined),
  };
}

function itemSnapshot(vault: SecretVault): OrderPersonalizationItemSnapshot {
  const textSlot = slot("customer.name", "text");
  const imageSlot = slot("customer.photo", "image");
  const schemaSnapshot: CustomizationDefinition = {
    version: 1,
    fields: [
      { key: "customer_name", label: "Customer name", type: "short_text", required: true },
      {
        key: "customer_photo",
        label: "Customer photo",
        type: "image",
        required: true,
        validation: { allowedMediaTypes: ["image/png"], maxFiles: 1, maxBytes: 10_000_000 },
      },
    ],
  };
  return {
    id: createEntityId(),
    orderId: createEntityId(),
    orderLineId: createEntityId(),
    customizationVersionId: createEntityId(),
    encryptedValues: vault.encrypt(JSON.stringify({
      values: { customer_name: "Private Customer" },
      fileReferences: [{ fieldKey: "customer_photo", externalReference: "provider-file-id" }],
      unmappedSourceLabels: [],
    })),
    schemaSnapshot,
    mapping: { slotFieldMap: { "customer.name": "customer_name", "customer.photo": "customer_photo" } },
    templateVersionId: textSlot.templateVersionId,
    slots: [textSlot, { ...imageSlot, templateVersionId: textSlot.templateVersionId }],
    files: [{
      fieldKey: "customer_photo",
      assetId: createEntityId(),
      assetVersion: 1,
      checksumSha256: "b".repeat(64),
      mediaType: "image/png",
    }],
  };
}

function slot(stableKey: string, kind: TemplateSlot["kind"]): TemplateSlot {
  return {
    id: createEntityId(),
    templateVersionId: createEntityId(),
    stableKey,
    name: stableKey,
    kind,
    geometry: { x: 0, y: 0, width: 100, height: 100, rotationDegrees: 0 },
    fillMode: kind === "text" ? "none" : "cover",
    validationSnapshot: { required: true },
    replaceable: true,
  };
}

function envelope(): JobEnvelope {
  const batchId = createEntityId();
  return {
    jobId: createEntityId(),
    tenantId: createEntityId(),
    requestedBy: createEntityId(),
    traceId: "0123456789abcdef0123456789abcdef",
    correlationId: batchId,
    idempotencyKey: batchId,
    requestedAt: new Date().toISOString(),
    attempt: 0,
    maxAttempts: 3,
    payload: { batchId },
  };
}
