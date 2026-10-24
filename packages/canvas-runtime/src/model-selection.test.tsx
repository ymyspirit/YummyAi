import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStudioModelCatalogue, modelToken, projectStudioModels, requireStudioModel, selectStudioConfigModel, selectStudioModel, studioModelCatalogue, studioNodeModelFields, studioWorkbenchModel } from "./model-selection";
import { modelSelectionConfig, modelSelectionFixtures as models } from "./model-selection-fixtures";
import { StudioModelSelectionNoticeView } from "./model-selection-view";
import type { WorkbenchDraftDocument } from "./workbench-draft";

vi.mock("./rpc", () => ({ openSettings: vi.fn() }));
const held = () => { let resolve!: (value: unknown) => void; const promise = new Promise<unknown>(accept => { resolve = accept; }); return { promise, resolve }; };
beforeEach(async () => { studioModelCatalogue.configure(""); studioModelCatalogue.configure("unit-owner"); await studioModelCatalogue.load(async () => structuredClone(models)); });

describe("current owner and capability model selection", () => {
  it("distinguishes exact routes with the same name and rejects a suffix, bare-name or capability mismatch", () => {
    const state = studioModelCatalogue.snapshot();
    expect(selectStudioModel(state, modelToken(models[1]!), "image").model?.id).toBe(models[1]!.id);
    for (const value of [models[1]!.model, `${models[1]!.id}::other-name`, modelToken(models[2]!)]) expect(selectStudioModel(state, value, "image")).toMatchObject({ status: "invalid", value: "", original: value });
    expect(selectStudioModel(state, modelToken(models[2]!), "video").status).toBe("ready");
  });
  it("does not choose the first configured model or replace an explicit stale choice with a personal default", () => {
    const config = modelSelectionConfig({ imageModel: "old-route::old-name" });
    expect(projectStudioModels(modelSelectionConfig(), models).imageModel).toBe("");
    expect(projectStudioModels(config, [{ ...models[0]!, isDefault: true }]).imageModel).toBe(config.imageModel);
    expect(projectStudioModels(modelSelectionConfig(), [{ ...models[0]!, isDefault: true }]).imageModel).toBe(modelToken(models[0]!));
  });
  it("keeps native draft/history values unchanged and uses the tool's own choice before a generic field", () => {
    const document: WorkbenchDraftDocument = { version: 1, activeId: "copied", drafts: [{ id: "copied", prompt: "原输入", references: [], config: { model: modelToken(models[0]!), videoModel: modelToken(models[2]!) } }] };
    const original = JSON.stringify(document), config = projectStudioModels(modelSelectionConfig({ model: modelToken(models[0]!) }), models);
    expect(studioWorkbenchModel(config, "video", document)).toBe(modelToken(models[2]!));
    delete document.drafts[0]!.config.videoModel;
    expect(studioWorkbenchModel(config, "video", document)).toBe(modelToken(models[0]!));
    expect(selectStudioConfigModel(config, studioWorkbenchModel(config, "video", document), "video").status).toBe("invalid");
    document.drafts[0]!.config.videoModel = modelToken(models[2]!); expect(JSON.stringify(document)).toBe(original);
    expect(studioWorkbenchModel(config, "video", { version: 1, activeId: null, drafts: [] })).toBe("");
  });
  it("projects a node's explicit model into its corresponding request field without modifying the node", () => {
    const node = { metadata: { model: modelToken(models[1]!), prompt: "原节点" } }, original = JSON.stringify(node);
    const config = projectStudioModels(modelSelectionConfig({ imageModel: modelToken(models[0]!) }), models);
    const projected = { ...config, ...studioNodeModelFields(config, node.metadata.model, "image") };
    expect(requireStudioModel(projected, "image").id).toBe(models[1]!.id); expect(JSON.stringify(node)).toBe(original);
  });
  it("keeps empty, unselected, failed and loading explicit and never invents audio support", () => {
    const state = studioModelCatalogue.snapshot();
    expect(selectStudioModel(state, "", "video").status).toBe("missing");
    expect(selectStudioModel({ ...state, models: [] }, "", "video").status).toBe("empty");
    expect(selectStudioModel({ ...state, models: [] }, modelToken(models[2]!), "video").status).toBe("invalid");
    expect(selectStudioModel({ ...state, status: "error", models: [] }, "", "video").status).toBe("failed");
    expect(selectStudioModel({ ...state, status: "loading", models: [] }, "", "video").status).toBe("loading");
    expect(selectStudioModel(state, "", "audio").status).toBe("unsupported");
  });
  it("deduplicates pending reads for equivalent owner echoes and does not abort a completed read", async () => {
    const catalogue = createStudioModelCatalogue(), response = held(), read = vi.fn((signal: AbortSignal) => { expect(signal.aborted).toBe(false); return response.promise; }); catalogue.configure("A");
    const first = catalogue.load(read); expect(catalogue.configure("A")).toBe(false); expect(catalogue.load(read)).toBe(first); expect(read).toHaveBeenCalledOnce();
    const signal = read.mock.calls[0]![0]; expect(signal.aborted).toBe(false); response.resolve(models); await first;
    catalogue.configure("B"); expect(signal.aborted).toBe(false); expect(catalogue.snapshot().models).toEqual([]);
  });
  it("discards a held old catalogue after owner CLEAR and never repopulates its metadata", async () => {
    const catalogue = createStudioModelCatalogue(), response = held(); let signal!: AbortSignal; catalogue.configure("A");
    const first = catalogue.load(captured => { signal = captured; return response.promise; }); catalogue.configure(""); response.resolve(models); await first;
    expect(signal.aborted).toBe(true); expect(catalogue.snapshot()).toMatchObject({ owner: "", status: "unavailable", models: [] });
  });
  it("rejects old catalogue metadata without a selection revision instead of treating it as an empty valid response", async () => {
    const catalogue = createStudioModelCatalogue(); catalogue.configure("A");
    await catalogue.load(async () => [{ ...models[0], selectionRevision: undefined }]); expect(catalogue.snapshot()).toMatchObject({ status: "error", models: [] });
  });
  it("rejects an old owner's config even if its token exists for the new owner, without exposing its original label", async () => {
    const original = projectStudioModels(modelSelectionConfig({ imageModel: modelToken(models[0]!) }), models);
    studioModelCatalogue.configure("other-owner"); await studioModelCatalogue.load(async () => models);
    expect(selectStudioConfigModel(original, original.imageModel, "image")).toMatchObject({ status: "failed", original: "", value: "" });
    expect(() => requireStudioModel(original, "image")).toThrow(); expect(projectStudioModels(original, models).imageModel).toBe("");
  });
  it("shows an explicit invalid-state notice with the original value and configuration action only under current permission", () => {
    const selection = selectStudioModel(studioModelCatalogue.snapshot(), modelToken(models[0]!), "video");
    // This checks the pure view's explicit permission props. The production
    // container reads its own live store; client authorization needs browser QA.
    const render = (canConfigure: boolean) => renderToStaticMarkup(createElement(StudioModelSelectionNoticeView, { selection, canConfigure, onConfigure: vi.fn() }));
    const allowed = render(true), denied = render(false);
    expect(allowed).toContain('data-studio-model-state="invalid"'); expect(allowed).toContain("原选择"); expect(allowed).toContain("打开 ERP 模型配置"); expect(allowed).not.toContain('disabled=""');
    expect(denied).toContain("需要模型配置权限"); expect(denied).toContain('disabled=""'); expect(denied).not.toContain("打开 ERP 模型配置");
    for (const html of [allowed, denied]) { expect(html).toContain(models[0]!.model); expect(html).not.toContain(models[0]!.id); }
    expect(selection.original).toBe(modelToken(models[0]!));
  });
});
