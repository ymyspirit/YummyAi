import { ConflictException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { StudioGenerateRequestSchema, StudioGenerateSchema } from "@yummyai/contracts/pod/creative-studio";
import type { TenantContext } from "@yummyai/contracts";
import { ProductVisualsService } from "./product-visuals.service.js";

const id = (last: string) => `019a0000-0000-7000-8000-${last.padStart(12, "0")}`;
const projectId = id("1"), modelId = id("2"), requestId = id("3"), oldRevision = "a".repeat(64), newRevision = "b".repeat(64);
const context = { tenantId: id("4"), userId: id("5"), permissions: [], dataScope: "self", teamIds: [] } as TenantContext;
function fixture(slotKey: "artwork" | "scene" = "artwork") {
  const studio = { originalInput: vi.fn().mockResolvedValue(null), models: vi.fn().mockResolvedValue([
    { id: id("6"), capability: "image", selectionRevision: "c".repeat(64) },
    { id: modelId, capability: "image", selectionRevision: newRevision },
  ]), create: vi.fn().mockResolvedValue({ id: id("7"), status: "queued" }) };
  const assets = { invoke: vi.fn() }, workflow = { results: vi.fn() };
  const service = new ProductVisualsService({} as never, {} as never, {} as never, {} as never, workflow as never, studio as never, assets as never, {} as never);
  vi.spyOn(service as unknown as { group: (...args: unknown[]) => Promise<unknown[]> }, "group").mockResolvedValue([
    { id: projectId, canvasWorkflow: { visualDelivery: { slotKey } } },
  ]);
  const input = { requestId, modelId, slotKey, ...(slotKey === "scene" ? { artworkVersionId: id("8") } : {}) };
  return { service, studio, assets, workflow, input };
}

describe("product visual generation preserves the selected model request", () => {
  it("uses the exact image route and current revision for a new request", async () => {
    const f = fixture(); await f.service.generate(context, id("9"), "synthetic-group", f.input);
    expect(f.studio.originalInput).toHaveBeenCalledWith(context, projectId, requestId);
    expect(f.studio.create).toHaveBeenCalledWith(context, projectId, expect.objectContaining({ modelId, capability: "image", selectionRevision: newRevision }));
    expect(f.assets.invoke).not.toHaveBeenCalled();
  });
  it("keeps the original revision on replay even when today's catalogue is unavailable", async () => {
    const f = fixture();
    f.studio.originalInput.mockResolvedValue(StudioGenerateRequestSchema.parse({ requestId, modelId, prompt: "Original fixed input", capability: "image", selectionRevision: oldRevision }));
    f.studio.models.mockRejectedValue(new Error("Channel disabled after original admission"));
    await f.service.generate(context, id("9"), "synthetic-group", f.input);
    expect(f.studio.models).not.toHaveBeenCalled();
    expect(f.studio.create).toHaveBeenCalledWith(context, projectId, expect.objectContaining({ capability: "image", selectionRevision: oldRevision }));
  });
  it("replays retained references without writing attachments before the owner compares a changed input", async () => {
    const f = fixture("scene");
    f.studio.originalInput.mockResolvedValue(StudioGenerateRequestSchema.parse({ requestId, modelId, prompt: "Original", capability: "image", selectionRevision: oldRevision, referenceKeys: ["retained-reference"] }));
    f.studio.create.mockRejectedValue(new ConflictException("Changed original input"));
    await expect(f.service.generate(context, id("9"), "synthetic-group", { ...f.input, prompt: "Changed" })).rejects.toThrow("Changed original input");
    expect(f.workflow.results).not.toHaveBeenCalled(); expect(f.assets.invoke).not.toHaveBeenCalled(); expect(f.studio.models).not.toHaveBeenCalled();
    expect(f.studio.create).toHaveBeenCalledWith(context, projectId, expect.objectContaining({ prompt: "Changed", referenceKeys: ["retained-reference"], selectionRevision: oldRevision }));
  });
  it("keeps a legacy request read-only rather than inventing a current pin", async () => {
    const f = fixture(); f.studio.originalInput.mockResolvedValue(StudioGenerateSchema.parse({ requestId, modelId, prompt: "Legacy" }));
    await expect(f.service.generate(context, id("9"), "synthetic-group", f.input)).rejects.toThrow("原任务未固定图片模型选择版本");
    expect(f.studio.models).not.toHaveBeenCalled(); expect(f.studio.create).not.toHaveBeenCalled(); expect(f.assets.invoke).not.toHaveBeenCalled();
  });
  it("rejects a removed or wrong-purpose new route before any attachment or dispatch", async () => {
    const f = fixture("scene"); f.studio.models.mockResolvedValue([{ id: modelId, capability: "video", selectionRevision: newRevision }]);
    await expect(f.service.generate(context, id("9"), "synthetic-group", f.input)).rejects.toThrow("所选图片模型不可用");
    expect(f.workflow.results).not.toHaveBeenCalled(); expect(f.assets.invoke).not.toHaveBeenCalled(); expect(f.studio.create).not.toHaveBeenCalled();
  });
});
