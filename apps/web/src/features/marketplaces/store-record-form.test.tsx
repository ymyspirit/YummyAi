import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CreateMarketplaceAccountInputSchema, UpdateMarketplaceAccountInputSchema } from "@yummyai/contracts/marketplace/store";
import { StoreAuthorizationModeField, storeRecordInput } from "./store-record-form";
import { storeNodeExecutionNotice } from "./store-node-execution-workspace";
import { StoreNodeExecutionError, storeNodeExecutionDenied } from "./store-node-execution-client";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }) }));
vi.mock("../manual-operations/operation-actions", () => ({ saveOperation: vi.fn() }));

function form(mode?: string) {
  const input = new FormData();
  input.set("displayName", "  Synthetic Amazon shop  ");
  input.set("site", "ATVPDKIKX0DER");
  if (mode !== undefined) input.set("authorizationMode", mode);
  return input;
}
const selected = (value: string) => new RegExp(`<option\\b(?=[^>]*\\bvalue="${value}")(?=[^>]*\\bselected)[^>]*>`);

describe("store connection choices and public node guidance", () => {
  it("defaults a new Amazon connection to private while permitting an explicit public OAuth choice in the same original form", () => {
    const html = renderToStaticMarkup(<StoreAuthorizationModeField platform="amazon" />);
    expect(html).toContain("平台连接方式");
    expect(html).toContain('name="authorizationMode"');
    expect(html).toContain("Amazon 公开应用 OAuth");
    expect(html).toMatch(selected("amazon_private"));
    expect(html).not.toMatch(selected("amazon_public"));
    for (const mode of ["amazon_private", "amazon_public"] as const) {
      const input = CreateMarketplaceAccountInputSchema.parse(storeRecordInput(form(mode), "amazon"));
      expect(input).toEqual({ displayName: "Synthetic Amazon shop", platform: "amazon", region: "NA",
        marketplaceIds: ["ATVPDKIKX0DER"], authorizationMode: mode, requestedScopes: ["product-listing"] });
    }
    expect(CreateMarketplaceAccountInputSchema.parse(storeRecordInput(form(), "amazon")).authorizationMode).toBe("amazon_private");
  });

  it("keeps Etsy fixed to its own OAuth and scope regardless of an old Amazon form value", () => {
    const html = renderToStaticMarkup(<StoreAuthorizationModeField platform="etsy" mode="amazon_public" />);
    expect(html).toMatch(selected("etsy_oauth"));
    expect(html).not.toContain('value="amazon_public"');
    expect(html).not.toContain('value="amazon_private"');
    const input = CreateMarketplaceAccountInputSchema.parse(storeRecordInput(form("amazon_public"), "etsy"));
    expect(input).toEqual({ displayName: "Synthetic Amazon shop", platform: "etsy", region: "GLOBAL",
      marketplaceIds: ["etsy"], authorizationMode: "etsy_oauth", requestedScopes: ["listings_r", "listings_w", "shops_r"] });
    expect(renderToStaticMarkup(<StoreAuthorizationModeField platform="amazon" />)).toMatch(selected("amazon_private"));
  });

  it("retains an uncredentialed account's original edit choice and never changes a live grant from a form value", () => {
    const html = renderToStaticMarkup(<StoreAuthorizationModeField platform="amazon" mode="amazon_public" />);
    expect(html).toMatch(selected("amazon_public"));
    expect(UpdateMarketplaceAccountInputSchema.parse(storeRecordInput(form("amazon_public"), "amazon", {
      hasCredential: false, authorizationMode: "amazon_private",
    }))).toEqual({ displayName: "Synthetic Amazon shop", authorizationMode: "amazon_public" });
    expect(UpdateMarketplaceAccountInputSchema.parse(storeRecordInput(form("amazon_private"), "amazon", {
      hasCredential: true, authorizationMode: "amazon_public",
    }))).toEqual({ displayName: "Synthetic Amazon shop" });
  });

  it("leaves unsupported connection modes invalid rather than silently selecting a different authorized application", () => {
    const input = storeRecordInput(form("unsupported_connection"), "amazon");
    expect(CreateMarketplaceAccountInputSchema.safeParse(input).success).toBe(false);
    expect(input.authorizationMode).toBe("unsupported_connection");
    expect(input).not.toHaveProperty("clientSecret");
    expect(input).not.toHaveProperty("refreshToken");
  });

  it("treats application reauthorization and local configuration failures as actionable task notices rather than personal read denial", () => {
    const reauthorize = new StoreNodeExecutionError(409, "store_node_application_reauthorization_required");
    expect(storeNodeExecutionDenied(reauthorize)).toBe(false);
    const text = storeNodeExecutionNotice(reauthorize);
    expect(text).toContain("重新完成平台授权");
    expect(text).toContain("节点本地应用配置");
    expect(text).toContain("原任务与原回执保留");
    expect(text).toContain("不会自动重试平台请求");
    const configuration = new StoreNodeExecutionError(409, "store_node_configuration_invalid");
    expect(storeNodeExecutionDenied(configuration)).toBe(false);
    expect(storeNodeExecutionNotice(configuration)).toContain("配置尚未就绪");
    expect(storeNodeExecutionNotice(configuration)).not.toContain("权限已变化");
    expect(storeNodeExecutionDenied(new StoreNodeExecutionError(403))).toBe(true);
  });
});
