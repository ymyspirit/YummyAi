import { createHash } from "node:crypto";
import type { ReactNode } from "react";
import type { MarketplaceAccountView } from "@yummyai/contracts";
import { Permission, type Permission as PermissionValue } from "@yummyai/authz/permissions";
import { ErpSessionViewSchema, erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { MarketplaceAccountDetail, MarketplaceAccountsWorkspace, MarketplaceOAuthAction } from "./marketplace-accounts-workspace";
import { ErpIdentityContext, useErpAccess } from "../identity/erp-access";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("./marketplace-actions", () => ({
  authorizeAmazonPrivate: vi.fn(), revokeMarketplaceAuthorization: vi.fn(),
  setMarketplaceAccountEnabled: vi.fn(), startMarketplaceOAuth: vi.fn(), syncMarketplaceCapabilities: vi.fn(),
}));

const readWrite = [Permission.StoreRead, Permission.StoreManage, Permission.StoreAuthorize];
const session = (permissions: PermissionValue[] = readWrite): ErpSessionView => ErpSessionViewSchema.parse({
  authenticated: true, canUseErp: true, permissions, dataScope: "tenant", teamIds: [],
  userId: "019f0000-0000-7000-8000-000000000001", tenantId: "019f0000-0000-7000-8000-000000000002",
  displayName: "Synthetic operator", organizationName: "Synthetic organization",
});
const stamp = (identity: ErpSessionView) => createHash("sha256").update(erpSessionAuthority(identity)).digest("hex");
const person = (identity: ErpSessionView | null, children: ReactNode) => (
  <ErpIdentityContext.Provider value={{ session: identity, localDevelopment: false, logout() {} }}>{children}</ErpIdentityContext.Provider>
);
const list = (contextAuthority: string) => <MarketplaceAccountsWorkspace accounts={[account()]} contextAuthority={contextAuthority} publications={[]} />;
const detail = (contextAuthority: string, counts: [number | null, number | null, number | null] = [12, 13, 14]) => (
  <MarketplaceAccountDetail account={account()} contextAuthority={contextAuthority} listingCount={counts[0]} orderCount={counts[1]} publicationCount={counts[2]} />
);
function AccessProbe() {
  const access = useErpAccess();
  return <output data-store-read={String(access.can(Permission.StoreRead))} data-store-manage={String(access.can(Permission.StoreManage))}
    data-store-authorize={String(access.can(Permission.StoreAuthorize))} />;
}
function hidesPriorFacts(html: string) {
  for (const value of [account().displayName, account().externalAccountId!, "listing_write", "9123/10000", "2 个", "4 个", "3 次", "12 个", "13 个", "14 次"])
    expect(html).not.toContain(value);
  expect(html).not.toContain('type="password"');
}

// Pre-effect SSR gates only. Current list/detail facts, quota and nullable display
// after an actual authority read remain personal-browser verification.
describe("marketplace initial personal authority boundaries", () => {
  it("hides old account facts for anonymous viewers and a member whose StoreRead was removed", () => {
    const originalStamp = stamp(session());
    const fragments = <>{list(originalStamp)}{detail(originalStamp)}</>;
    for (const html of [renderToStaticMarkup(fragments), renderToStaticMarkup(person(null, fragments)),
      renderToStaticMarkup(person(session([Permission.StoreManage, Permission.StoreAuthorize]), fragments))]) {
      expect(html).toContain("当前店铺资料不可读取"); hidesPriorFacts(html);
      expect(html).not.toContain("新增店铺"); expect(html).not.toContain("店铺巡检台账");
    }
  });

  it("requires a new authority read before showing detail props even for the matching real personal context", () => {
    const identity = session(), html = renderToStaticMarkup(person(identity, detail(stamp(identity))));
    expect(html).toContain('aria-label="店铺授权状态"'); expect(html).toContain("核对当前店铺授权");
    expect(html).toContain("重新读取授权状态"); hidesPriorFacts(html);
    for (const control of ["验证并保存", "同步能力", "撤销授权", "Seller ID", "Refresh token"])
      expect(html).not.toContain(control);
    expect(html).not.toContain('id="store-settings"');
  });

  it("does not endorse an SSR account array with another actor or an older membership stamp", () => {
    const reader = session([Permission.StoreRead]);
    const otherActor = { ...reader, userId: "019f0000-0000-7000-8000-000000000003" };
    for (const stale of [stamp(otherActor), stamp(session())]) {
      expect(stale).not.toBe(stamp(reader));
      const html = renderToStaticMarkup(person(reader, list(stale)));
      expect(html).toContain("当前店铺资料不可读取"); hidesPriorFacts(html);
      expect(html).not.toContain("店铺巡检台账"); expect(html).not.toContain(`/stores/${account().id}`);
    }
  });

  it("does not infer authorization or management from StoreRead in an unverified personal list", () => {
    const reader = session([Permission.StoreRead]);
    const html = renderToStaticMarkup(person(reader, <><AccessProbe />{list(stamp(reader))}</>));
    expect(html).toContain('data-store-read="true"'); expect(html).toContain('data-store-manage="false"');
    expect(html).toContain('data-store-authorize="false"'); expect(html).toContain("当前店铺资料不可读取");
    for (const control of ["新增店铺", "编辑店铺资料", "验证并保存", "同步能力", "撤销授权"])
      expect(html).not.toContain(control);
  });

  it("withholds nullable unknown statistics and genuine zero statistics alike until the detail read is verified", () => {
    const identity = session(), authority = stamp(identity);
    const unknown = renderToStaticMarkup(person(identity, detail(authority, [null, null, null])));
    const actualEmpty = renderToStaticMarkup(person(identity, detail(authority, [0, 0, 0])));
    expect(unknown).toBe(actualEmpty); expect(unknown).toContain("重新读取授权状态");
    for (const value of ["0 个", "0 次", "没有发布请求", "没有可见订单", "暂无店铺档案", "undefined", "null"])
      expect(unknown).not.toContain(value);
    hidesPriorFacts(unknown);
  });
});

describe("explicit public OAuth reauthorization", () => {
  it("offers the original OAuth action for a credentialed public application without revoking or starting it during render", () => {
    const onSubmit = vi.fn();
    const active = { ...account(), platform: "amazon" as const, authorizationMode: "amazon_public" as const };
    const html = renderToStaticMarkup(<MarketplaceOAuthAction account={active} canAuthorize onSubmit={onSubmit} />);
    expect(html).toContain("重新授权公开应用");
    expect(html).toContain('type="submit"');
    expect(html).not.toContain("撤销授权");
    expect(html).not.toContain('disabled=""');
    expect(onSubmit).not.toHaveBeenCalled();
    const initial = renderToStaticMarkup(<MarketplaceOAuthAction account={{ ...active, hasCredential: false }} canAuthorize onSubmit={onSubmit} />);
    expect(initial).toContain("前往平台授权");
    expect(initial).not.toContain("重新授权公开应用");
  });

  it("keeps missing authorization and disabled accounts closed and preserves each pending or unverified gate", () => {
    const onSubmit = vi.fn(), active = { ...account(), authorizationMode: "amazon_public" as const };
    expect(renderToStaticMarkup(<MarketplaceOAuthAction account={active} canAuthorize={false} onSubmit={onSubmit} />)).toBe("");
    expect(renderToStaticMarkup(<MarketplaceOAuthAction account={{ ...active, status: "disabled" }} canAuthorize onSubmit={onSubmit} />)).toBe("");
    for (const gate of ["locked", "busy", "lifecycleBusy", "pending"] as const) {
      const html = renderToStaticMarkup(<MarketplaceOAuthAction account={active} canAuthorize {...{ [gate]: true }} onSubmit={onSubmit} />);
      expect(html).toContain("重新授权公开应用");
      expect(html).toContain('disabled=""');
    }
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("leaves Amazon private outside OAuth and preserves Etsy initial and explicitly required renewal paths", () => {
    const onSubmit = vi.fn();
    expect(renderToStaticMarkup(<MarketplaceOAuthAction account={{ ...account(), authorizationMode: "amazon_private" }} canAuthorize reauthorize onSubmit={onSubmit} />)).toBe("");
    expect(renderToStaticMarkup(<MarketplaceOAuthAction account={account()} canAuthorize onSubmit={onSubmit} />)).toBe("");
    for (const shop of [{ ...account(), hasCredential: false }, account()]) {
      const html = renderToStaticMarkup(<MarketplaceOAuthAction account={shop} canAuthorize reauthorize={shop.hasCredential} onSubmit={onSubmit} />);
      expect(html).toContain("前往平台授权");
      expect(html).not.toContain("重新授权公开应用");
    }
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

function account(): MarketplaceAccountView {
  return {
    authorizationMode: "etsy_oauth",
    capabilities: ["listing_read", "listing_write", "media_write", "inventory_write"],
    capabilityExpiresAt: "2026-07-20T00:00:00.000Z",
    quota: {
      platform: "etsy",
      windows: [{ scope: "day", limit: 10_000, remaining: 9_123 }],
      observedAt: "2026-07-19T01:00:00.000Z",
    },
    createdAt: "2026-07-19T00:00:00.000Z",
    credentialStatus: "valid",
    displayName: "Synthetic private store",
    externalAccountId: "synthetic-private-external-account",
    grantedScopes: ["listings_r", "listings_w", "shops_r"],
    hasCredential: true,
    healthStatus: "healthy",
    id: "0198fbef-4a10-7000-8000-000000000810",
    lastCapabilitySyncAt: "2026-07-19T01:00:00.000Z",
    lastErrorCode: null,
    lastHealthAt: "2026-07-19T01:00:00.000Z",
    marketplaceIds: ["etsy"],
    platform: "etsy",
    region: "GLOBAL",
    requestedScopes: ["listings_r", "listings_w", "shops_r"],
    status: "active",
    updatedAt: "2026-07-19T01:00:00.000Z",
  };
}
