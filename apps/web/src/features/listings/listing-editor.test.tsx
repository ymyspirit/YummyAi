import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ListingEditor, readCurrentListing, type ListingEditorView } from "./listing-editor";
import { PersonalAccessFixture } from "../identity/erp-access.fixture";
import { Permission } from "@yummyai/authz/permissions";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { previewDenied } from "../marketplaces/publication-preview-client";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/listings/listing",
}));
afterEach(() => vi.unstubAllGlobals());

describe("listing editor", () => {
  it("renders stable platform tabs, field provenance, and validation", () => {
    const html = renderToStaticMarkup(
      <PersonalAccessFixture permissions={[Permission.ListingRead, Permission.ListingWrite]}>
        <ListingEditor listing={fixture()} />
      </PersonalAccessFixture>,
    );
    for (const tab of [
      "Content",
      "Media",
      "Variants",
      "Attributes",
      "Compliance",
      "Publish",
      "Channels",
      "History",
    ])
      expect(html).toContain(tab);
    expect(html).toContain("当前草稿");
    expect(html).not.toContain("AI SUGGESTION");
    expect(html).toContain("平台本地预览");
    expect(html).toContain("不代表平台在线状态");
    expect(html).toContain("版本活动");
    expect(html).toContain("保存为新版本");
    expect(html).toContain("刊登健康度");
    expect(html).toContain("attributes.brand");
    expect(html).toContain("amazon-2026.07");
  });
  it("does not expose a draft when the current identity has no Listing read authority", () => {
    const html = renderToStaticMarkup(<ListingEditor listing={fixture()} />);
    expect(html).toContain("刊登当前不可读取");
    expect(html).not.toContain("Travel mug");
  });
  it("keeps content read-only with read authority alone", () => {
    const html = renderToStaticMarkup(
      <PersonalAccessFixture permissions={[Permission.ListingRead]}>
        <ListingEditor listing={fixture()} />
      </PersonalAccessFixture>,
    );
    expect(html).toContain("当前刊登内容仅可查看");
    expect(html).toContain("Travel mug");
  });
  it("keeps an explicitly pinned immutable version read-only even with write permission", () => {
    const html = renderToStaticMarkup(<PersonalAccessFixture permissions={[Permission.ListingRead, Permission.ListingWrite]}><ListingEditor listing={fixture()} fixedVersion /></PersonalAccessFixture>);
    expect(html).toContain("链接指定的不可变原版本"); expect(html).toContain("旧编辑器提交"); expect(html).not.toContain('contenteditable="true"');
  });
  it("does not let an old SSR session stamp expose content to a changed identity", () => {
    const html = renderToStaticMarkup(<PersonalAccessFixture permissions={[Permission.ListingRead, Permission.ListingWrite]}><ListingEditor listing={fixture()} contextAuthority="old-session" /></PersonalAccessFixture>);
    expect(html).toContain("原资料已隐藏"); expect(html).not.toContain("Travel mug");
  });
  it("does not use even a matching personal SSR stamp as current object-read proof", () => {
    const permissions = [Permission.ListingRead, Permission.ListingWrite], authority = erpSessionAuthority({ userId: "019f0000-0000-7000-8000-000000000001",
      tenantId: "019f0000-0000-7000-8000-000000000002", permissions, dataScope: "tenant" });
    const html = renderToStaticMarkup(<PersonalAccessFixture permissions={permissions}><ListingEditor listing={fixture()} contextAuthority={authority} /></PersonalAccessFixture>);
    expect(html).toContain("正在核对原刊登的当前读取权限"); expect(html).not.toContain("Travel mug"); expect(html).not.toContain("保存为新版本");
  });
  it("reads finite GET plus HEAD before accepting current metadata and preserves the isolated positive presentation", async () => {
    const id = "019f0000-0000-7000-8000-000000000101", version = "019f0000-0000-7000-8000-000000000102", owner = "019f0000-0000-7000-8000-000000000001", authority = "original-canonical-personal-context";
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ listing: { id, ownerUserId: owner, status: "draft" }, version: { id: version } }, { headers: { "x-yummyai-context-authority": authority } }))
      .mockResolvedValueOnce(new Response(null, { headers: { "x-yummyai-context-authority": authority } })); vi.stubGlobal("fetch", fetch);
    const current = await readCurrentListing(id, authority); expect(current).toEqual({ id, ownerUserId: owner, versionId: version, status: "draft" });
    expect(fetch.mock.calls.map(call => call[1].method)).toEqual(["GET", "HEAD"]); expect(fetch.mock.calls.every(call => call[0] === `/api/listings/${id}`)).toBe(true);
    // This is the legacy isolated presentation boundary, not an effect/hydration assertion.
    const html = renderToStaticMarkup(<PersonalAccessFixture permissions={[Permission.ListingRead, Permission.ListingWrite]}><ListingEditor listing={{ ...fixture(), id, ownerUserId: current.ownerUserId, versionId: current.versionId }} /></PersonalAccessFixture>);
    expect(html).toContain("Travel mug"); expect(html).toContain("保存为新版本");
  });
  it("rejects a delayed original body when HEAD loses the object and keeps ordinary conflicts distinct", async () => {
    const id = "019f0000-0000-7000-8000-000000000101", version = "019f0000-0000-7000-8000-000000000102", authority = "same-personal-authority";
    for (const [status, code, denied] of [[403, undefined, true], [409, "authority_changed", true], [409, undefined, false]] as const) {
      const fetch = vi.fn().mockResolvedValueOnce(Response.json({ listing: { id, status: "draft" }, version: { id: version } }, { headers: { "x-yummyai-context-authority": authority } }))
        .mockResolvedValueOnce(new Response(null, { status, headers: code ? { "x-yummyai-error-code": code } : {} })); vi.stubGlobal("fetch", fetch);
      const error = await readCurrentListing(id, authority).catch(error => error); expect(error.status).toBe(status); expect(previewDenied(error)).toBe(denied);
      expect(fetch.mock.calls.map(call => call[1].method)).toEqual(["GET", "HEAD"]);
    }
  });
});

function fixture(): ListingEditorView {
  const content = {
    platform: "amazon" as const,
    locale: "en-US",
    title: "Travel mug",
    description: "Gift ready",
    bullets: ["Personalized"],
    tags: [],
    mainImageId: "asset",
    mediaAssetIds: ["asset"],
    variants: [{ skuId: "sku", skuCode: "MUG", optionValues: {} }],
    attributes: {},
    compliance: { countryOfOrigin: "CN" },
  };
  return {
    id: "listing",
    platform: "amazon",
    locale: "en-US",
    status: "draft",
    spuCode: "MUG",
    versionId: "version",
    versionNumber: 3,
    ruleVersion: "amazon-2026.07",
    source: "human",
    updatedAt: "2026-07-18T00:00:00Z",
    content,
    validation: {
      completeness: 83,
      blockers: [
        {
          severity: "blocker",
          code: "common.required",
          path: "attributes.brand",
          message: "brand is required",
          ruleVersion: "amazon-2026.07",
        },
      ],
      warnings: [],
    },
    history: [
      {
        id: "version",
        versionNumber: 3,
        status: "draft",
        source: "human",
        createdAt: "2026-07-18T00:00:00Z",
      },
    ],
  };
}
