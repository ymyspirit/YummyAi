import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DesignTask, type DesignTaskView } from "./design-task";

describe("design task", () => {
  it("shows immutable primary versions, file roles, and rights", () => {
    const html = renderToStaticMarkup(<DesignTask task={fixture()} />);
    expect(html).toContain("审批版本已锁定");
    expect(html).toContain("当前主版本");
    expect(html).toContain("源文件");
    expect(html).toContain("效果文件");
    expect(html).toContain("生产文件");
    expect(html).toContain("许可使用");
    expect(html).toContain("授权域");
  });
});

function fixture(): DesignTaskView {
  const id = "0198fbef-4a10-7000-8000-000000000091";
  return {
    id, skuId: id, skuCode: "TMG-NVY-16", title: "Travel mug artwork", brief: "Prepare files", status: "approved",
    primaryVersionId: id,
    versions: [{ id, versionNumber: 1, status: "approved", createdAt: "2026-07-18T00:00:00.000Z", files: [{
      id, role: "source", asset: { id, fileName: "artwork.ai", mediaType: "application/postscript", byteSize: 1200, sha256: "a".repeat(64), domain: "authorized", rightsSource: { kind: "licensed", reference: "L-1" }, rightsApprovedAt: "2026-07-18T00:00:00.000Z" },
    }] }],
  };
}
