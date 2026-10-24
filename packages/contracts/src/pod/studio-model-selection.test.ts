import { describe, expect, it } from "vitest";
import { StudioGenerateRequestSchema, StudioGenerateSchema, StudioRpcSchema, publicStudioModelSelectionError } from "./creative-studio.js";
import { StudioGenerationRecordSchema, StudioModelSchema } from "./studio-personal.js";

const id = "019a0000-0000-7000-8000-000000000001";
const revision = "a".repeat(64);
const legacy = { requestId: id, modelId: id, prompt: "Synthetic model selection" };

describe("Studio model selection admission and retained history", () => {
  it("exposes finite owner errors only for the documented code and status pair", () => {
    expect(publicStudioModelSelectionError("studio_model_capability_mismatch", 400)?.message).toBe("所选模型不适用于当前工具 请重新选择");
    expect(publicStudioModelSelectionError("studio_model_selection_changed", 409)?.code).toBe("studio_model_selection_changed");
    expect(publicStudioModelSelectionError("studio_model_selection_changed", 400)).toBeUndefined();
    expect(publicStudioModelSelectionError("private-diagnostic", 409)).toBeUndefined();
  });
  it("requires explicit capability and selection revision for new RPC submissions", () => {
    expect(StudioRpcSchema.safeParse({ operation: "generate", input: legacy }).success).toBe(false);
    for (const capability of ["image", "video", "text"] as const) {
      expect(StudioRpcSchema.parse({ operation: "generate", input: { ...legacy, capability, selectionRevision: revision } })).toMatchObject({ input: { capability, selectionRevision: revision } });
    }
  });
  it.each([
    { capability: "image" }, { selectionRevision: revision },
    { capability: "audio", selectionRevision: revision },
    { capability: "video", selectionRevision: "A".repeat(64) },
    { capability: "video", selectionRevision: "a".repeat(63) },
  ])("rejects an incomplete or unsupported selection: %j", fields => {
    expect(StudioGenerateRequestSchema.safeParse({ ...legacy, ...fields }).success).toBe(false);
  });
  it("keeps old immutable input readable without backfilling intent", () => {
    const input = StudioGenerateSchema.parse(legacy);
    expect(input).not.toHaveProperty("capability");
    expect(input).not.toHaveProperty("selectionRevision");
    const record = StudioGenerationRecordSchema.parse({ id, assetId: null, status: "completed", input,
      model: { providerConfigId: id, model: "synthetic-original", capability: "image" },
      createdAt: "2026-10-24T00:00:00.000Z", error: null });
    expect(record.input).toEqual(input);
    expect(record.model.model).toBe("synthetic-original");
  });
  it("publishes only a complete credential-free selectable model", () => {
    const model = { id, label: "Synthetic", model: "synthetic-model", capability: "video", providerLabel: "Synthetic channel", isDefault: false, selectionRevision: revision };
    expect(StudioModelSchema.parse(model)).toEqual(model);
    expect(StudioModelSchema.safeParse({ ...model, selectionRevision: undefined }).success).toBe(false);
    expect(StudioModelSchema.safeParse({ ...model, apiKey: "synthetic-forbidden" }).success).toBe(false);
  });
});
