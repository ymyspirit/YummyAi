import { describe, expect, it } from "vitest";

import {
  contentScriptFileForUrl,
  isMissingContentScriptConnection,
} from "./content-script-recovery.js";

describe("content script recovery", () => {
  it("selects the generated script for supported public marketplace pages", () => {
    expect(contentScriptFileForUrl("https://www.amazon.com/dp/B000TEST")).toBe(
      "content-scripts/amazon.js",
    );
    expect(contentScriptFileForUrl("https://www.etsy.com/listing/123/example")).toBe(
      "content-scripts/etsy.js",
    );
    expect(contentScriptFileForUrl("https://www.etsy.com/shop/ExampleShop")).toBe(
      "content-scripts/etsy.js",
    );
  });

  it("rejects unsupported and non-public pages", () => {
    expect(contentScriptFileForUrl("https://www.etsy.com/your/shops/me")).toBeNull();
    expect(contentScriptFileForUrl("https://example.com/product/1")).toBeNull();
    expect(contentScriptFileForUrl("not a url")).toBeNull();
  });

  it("recognizes the Chromium missing-receiver failure", () => {
    expect(
      isMissingContentScriptConnection(
        new Error("Could not establish connection. Receiving end does not exist."),
      ),
    ).toBe(true);
    expect(isMissingContentScriptConnection(new Error("Parser failed"))).toBe(false);
  });
});
