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

  it("turns an empty task into an actionable first-version state", () => {
    const html = renderToStaticMarkup(
      <DesignTask
        task={{
          id: "019f9a00-5635-7889-adb8-f30149da968d",
          skuId: "019f9a00-560d-7360-a08a-56eb7f1e8c42",
          skuCode: "P1G-PILLOW-STD",
          title: "Personalized Pillow Cover · 原创图案与生产校样",
          brief: "Only use the research item as demand evidence.",
          status: "open",
          versions: [],
        }}
      />,
    );

    expect(html).toContain("尚未上传设计版本");
    expect(html).toContain("上传自有或已获许可的设计文件");
    expect(html).toContain("不能上传竞品图片作为设计资产");
    expect(html).toContain("P1G-PILLOW-STD");
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
