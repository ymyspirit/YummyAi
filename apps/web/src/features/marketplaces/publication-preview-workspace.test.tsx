import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { PublicationPreviewWorkspace } from "./publication-preview-workspace";
import { PublicationPreviewReceipt } from "./publication-preview-receipt";
import { PersonalAccessFixture } from "../identity/erp-access.fixture";
import { Permission } from "@yummyai/authz/permissions";
import { publicationPreviewFixture, previewId } from "./publication-preview.test-fixture";
describe("publication preview display boundaries", () => {
  it("does not use old page props or read permission as proof that a new target may be prepared", () => {
    const html = renderToStaticMarkup(<PersonalAccessFixture permissions={[Permission.ListingRead, Permission.StoreRead]}><PublicationPreviewWorkspace listingId={previewId(3)} listingVersionId={previewId(4)} /></PersonalAccessFixture>);
    expect(html).toContain("Amazon 节点校验预览"); expect(html).not.toContain("保存原节点预览"); expect(html).not.toContain("原版本标题");
    expect(renderToStaticMarkup(<PublicationPreviewWorkspace listingId={previewId(3)} listingVersionId={previewId(4)} />)).toContain("原预览资料已隐藏");
  });
  it("requires Listing and Store read separately without using one bit as the other", () => {
    for (const permissions of [[Permission.ListingRead], [Permission.StoreRead]]) {
      const html = renderToStaticMarkup(<PersonalAccessFixture permissions={permissions}><PublicationPreviewWorkspace listingId={previewId(3)} listingVersionId={previewId(4)} /></PersonalAccessFixture>);
      expect(html).toContain("当前没有原刊登或店铺读取权限"); expect(html).toContain("原预览资料已隐藏"); expect(html).not.toContain("本人原发布预览恢复");
    }
  });
  it("shows complete original identifiers and actual issues without claiming publication or exposing a continuation action", async () => {
    const { value } = await publicationPreviewFixture(); value.request.current.issues = [{ severity: "blocker", code: "SYNTHETIC_BLOCK", message: "Original issue", path: "attributes.color" }];
    const html = renderToStaticMarkup(<PublicationPreviewReceipt value={value} events={null} busy={false} canCancel={false} onRefresh={() => {}} onEvents={() => {}} onCancel={() => {}} />);
    expect(html).toContain(value.request.id); expect(html).toContain(value.request.listingVersionId); expect(html).toContain(value.request.payloadChecksum); expect(html).toContain("Original issue");
    expect(html).toContain("不自动继续正式提交"); expect(html).not.toContain("明确取消此原预览"); expect(html).not.toContain("正式提交到平台");
  });
});
