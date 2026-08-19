import { createEntityId } from "@yummyai/contracts";
import type { JobEnvelope } from "@yummyai/jobs";
import { describe, expect, it, vi } from "vitest";

import {
  PersonalizationTemplateSourceInspectionProcessor,
  TemplateSourceInspectionPolicyError,
  type TemplateSourceInspectionRepository,
} from "./personalization-template-source-inspection.processor.js";

describe("personalization template source inspection processor", () => {
  it("loads identifier-only work and persists a parsed result", async () => {
    const inspectionId = createEntityId();
    const complete = vi.fn<TemplateSourceInspectionRepository["complete"]>();
    const repository: TemplateSourceInspectionRepository = {
      claimAndLoad: async () => ({ id: inspectionId, source: "png", bytes: pngFixture() }),
      complete,
      fail: vi.fn(),
    };

    const result = await new PersonalizationTemplateSourceInspectionProcessor(repository).process(envelope(inspectionId));

    expect(result).toMatchObject({ disposition: "completed", slotCount: 1 });
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: expect.any(String), userId: expect.any(String) }),
      inspectionId,
      expect.objectContaining({ canvas: expect.objectContaining({ width: 100, height: 80 }), slots: [expect.objectContaining({ stableKey: "customer.image" })] }),
    );
  });

  it("marks policy failures terminal without leaking source details into the job payload", async () => {
    const inspectionId = createEntityId();
    const fail = vi.fn<TemplateSourceInspectionRepository["fail"]>();
    const repository: TemplateSourceInspectionRepository = {
      claimAndLoad: async () => { throw new TemplateSourceInspectionPolicyError("Pinned source changed"); },
      complete: vi.fn(),
      fail,
    };

    await expect(new PersonalizationTemplateSourceInspectionProcessor(repository).process(envelope(inspectionId)))
      .rejects.toThrow("Pinned source changed");
    expect(fail).toHaveBeenCalledWith(expect.any(Object), inspectionId, {
      terminal: true,
      code: "TEMPLATE_SOURCE_POLICY_BLOCKED",
      message: "Pinned source changed",
    });
  });
});

function envelope(inspectionId: string): JobEnvelope {
  const id = createEntityId();
  return {
    attempt: 0,
    correlationId: inspectionId,
    idempotencyKey: inspectionId,
    jobId: createEntityId(),
    maxAttempts: 3,
    payload: { inspectionId },
    requestedAt: "2026-08-04T00:00:00.000Z",
    requestedBy: id,
    tenantId: createEntityId(),
    traceId: "0123456789abcdef0123456789abcdef",
  };
}

function pngFixture() {
  const values = [137, 80, 78, 71, 13, 10, 26, 10];
  u32(values, 13);
  ascii(values, "IHDR");
  u32(values, 100);
  u32(values, 80);
  values.push(8, 6, 0, 0, 0);
  u32(values, 0);
  u32(values, 0);
  ascii(values, "IEND");
  u32(values, 0);
  return Uint8Array.from(values);
}

function u32(values: number[], value: number) {
  values.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function ascii(values: number[], value: string) {
  for (const character of value) values.push(character.charCodeAt(0));
}
