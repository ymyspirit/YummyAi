import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { studioImages, studioText, studioVideo } from "./generation";
import { useStudioModels } from "./model-state";
import { modelToken, projectStudioModels, studioModelCatalogue, studioNodeModelFields } from "./model-selection";
import { modelSelectionConfig, modelSelectionFixtures as models } from "./model-selection-fixtures";
import { rpc } from "./rpc";

vi.mock("./rpc", () => ({ rpc: vi.fn(), notify: vi.fn() }));
vi.mock("./storage", () => ({ decodeBlob: vi.fn() }));
const id = "019a0000-0000-7000-8000-000000000099";
const config = () => projectStudioModels(modelSelectionConfig({ model: modelToken(models[0]!), imageModel: modelToken(models[1]!), videoModel: modelToken(models[2]!), textModel: modelToken(models[3]!) }), models);
beforeEach(async () => {
  vi.mocked(rpc).mockReset(); studioModelCatalogue.configure(""); studioModelCatalogue.configure("unit-owner"); await studioModelCatalogue.load(async () => structuredClone(models));
  // This is a pure mock-transport fixture, never a live workspace or policy change.
  useStudioModels.setState({ status: "ready", executionAllowed: true });
});
afterEach(() => { useStudioModels.setState({ executionAllowed: false }); studioModelCatalogue.configure(""); });
describe("actual Studio generation entries with current model metadata", () => {
  it("submits the exact image route, capability and revision through studioImages", async () => {
    vi.mocked(rpc).mockResolvedValueOnce({ id }).mockResolvedValueOnce({ id, status: "completed", contentBase64: "AAAA", mediaType: "image/png" });
    expect(await studioImages(config(), "fixture prompt", [])).toHaveLength(1);
    expect(rpc).toHaveBeenNthCalledWith(1, { operation: "generate", input: expect.objectContaining({ modelId: models[1]!.id, capability: "image", selectionRevision: models[1]!.selectionRevision }) });
  });
  it("uses videoModel despite an image generic model and never guesses capability from a same-name label", async () => {
    vi.mocked(rpc).mockResolvedValueOnce({ id }); const result = await studioVideo(config(), "fixture prompt", []);
    expect(rpc).toHaveBeenCalledExactlyOnceWith({ operation: "generate", input: expect.objectContaining({ modelId: models[2]!.id, capability: "video", selectionRevision: models[2]!.selectionRevision }) });
    expect(result.model).toBe(modelToken(models[2]!));
  });
  it("submits text capability/revision and returns the actual text through studioText", async () => {
    vi.mocked(rpc).mockResolvedValueOnce({ id }).mockResolvedValueOnce({ id, status: "completed", text: "fixture answer" }); const delta = vi.fn();
    expect(await studioText(config(), [{ role: "user", content: "fixture prompt" }], delta)).toBe("fixture answer");
    expect(rpc).toHaveBeenNthCalledWith(1, { operation: "generate", input: expect.objectContaining({ modelId: models[3]!.id, capability: "text", selectionRevision: models[3]!.selectionRevision }) }); expect(delta).toHaveBeenCalledWith("fixture answer");
  });
  it("retains an explicit canvas node route rather than replacing it with another same-capability default", async () => {
    const selected = { ...config(), ...studioNodeModelFields(config(), modelToken(models[0]!), "image") };
    vi.mocked(rpc).mockResolvedValueOnce({ id }).mockResolvedValueOnce({ id, status: "completed", contentBase64: "AAAA", mediaType: "image/png" });
    await studioImages(selected, "fixture prompt", []); expect(rpc).toHaveBeenNthCalledWith(1, { operation: "generate", input: expect.objectContaining({ modelId: models[0]!.id, capability: "image" }) });
  });
  it("rejects missing, mismatched, forged suffix and old unbound configs before any transport request", async () => {
    for (const input of [
      { ...config(), videoModel: "" },
      { ...config(), videoModel: modelToken(models[0]!) },
      { ...config(), videoModel: `${models[2]!.id}::different-name` },
      JSON.parse(JSON.stringify(config())),
    ]) await expect(studioVideo(input, "fixture prompt", [])).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
  it("invalidates a retained selection after its route is disabled/removed from a refreshed directory", async () => {
    const retained = config(); await studioModelCatalogue.load(async () => models.filter(model => model.id !== models[2]!.id));
    await expect(studioVideo(retained, "fixture prompt", [])).rejects.toThrow(); expect(rpc).not.toHaveBeenCalled(); expect(retained.videoModel).toBe(modelToken(models[2]!));
  });
  it("keeps paused execution blocked even with a valid current selection and directory", async () => {
    useStudioModels.setState({ executionAllowed: false }); await expect(studioVideo(config(), "fixture prompt", [])).rejects.toThrow(); expect(rpc).not.toHaveBeenCalled();
  });
});
