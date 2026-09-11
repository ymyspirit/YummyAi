import type { ProductionEditorRenderView } from "@yummyai/contracts/pod/production-editor-api";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createProductionDocument } from "./production-editor-model";
import { ProductionConfirmations, ProductionProcessPanel } from "./production-editor-panels";
import { ProductionOutputPanel } from "./production-editor-workspace";

describe("production editor review boundaries", () => {
  it("shows sample factory parameters as unconfirmed and does not fabricate barcode dimensions", () => {
    const html = renderToStaticMarkup(<ProductionProcessPanel document={createProductionDocument("shaped_pillow")} onChange={() => undefined} />);
    expect(html).toContain("待工厂确认");
    expect(html).toContain('placeholder="待填写"');
    expect(html).toContain("150");
    expect(html).toContain("200");
  });

  it("requires a matching server preview before the visual checkbox is available", () => {
    const html = renderToStaticMarkup(<ProductionConfirmations document={createProductionDocument("tire_cover")} hasPreview={false} onChange={() => undefined} />);
    expect(html).toContain('disabled=""');
    expect(html).toContain("先生成后台校对预览");
    expect(html).not.toContain("条码框");
  });

  it("does not display a later historical preview as the current artwork", () => {
    const renders = [renderFixture("later", "version-3"), renderFixture("selected", "version-1")];
    const html = renderToStaticMarkup(<ProductionOutputPanel projectId="project" renders={renders} previewId="selected" versions={[{ id: "version-1", versionNumber: 1, createdAt: "2026-09-08T00:00:00.000Z", reviewed: false }, { id: "version-3", versionNumber: 3, createdAt: "2026-09-08T00:00:00.000Z", reviewed: false }]} onError={() => undefined} />);
    expect(html).toContain('src="/api/production-editor/projects/project/renders/selected/files/preview.png"');
    expect(html).not.toContain('src="/api/production-editor/projects/project/renders/later');
    expect(html).toContain("历史记录");
    expect(html).toContain("V1");
    expect(html).toContain("V3");
  });

  it("keeps private production files downloadable without rendering a full-size production canvas", () => {
    const render = { ...renderFixture("production", "version-1"), purpose: "production" as const };
    const html = renderToStaticMarkup(<ProductionOutputPanel projectId="project" renders={[render]} selectedVersionId="version-1" onError={() => undefined} />);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<canvas");
    expect(html).toContain("当前图稿尚无匹配");
    expect(html).toContain("preview.png");
    expect(html).toContain("当前图稿");
    expect(html).not.toContain("历史记录");
  });
});

function renderFixture(id: string, versionId: string): ProductionEditorRenderView {
  return { id, versionId, purpose: "preview", status: "completed", errorCode: null, createdAt: "2026-09-08T00:00:00.000Z", files: [{ key: "preview.png", name: "preview.png", mediaType: "image/png", byteSize: 20 }], preflight: null };
}
