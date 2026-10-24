import { describe, expect, it } from "vitest";

import { isPublicAddress, safeAmazonArchiveUrl } from "./amazon-report-archive.gateway.js";

describe("Amazon Custom download boundary", () => {
  it("allows Custom HTTPS endpoints and only allows S3 on redirects", () => {
    expect(safeAmazonArchiveUrl("https://zme-caps.amazon.com/example").hostname).toBe("zme-caps.amazon.com");
    expect(safeAmazonArchiveUrl("https://custom.s3.amazonaws.com/example", true).hostname).toBe("custom.s3.amazonaws.com");
    expect(() => safeAmazonArchiveUrl("https://custom.s3.amazonaws.com/example")).toThrow("unsafe_url");
  });
  it.each(["http://zme-caps.amazon.com/a", "https://zme-caps.amazon.com.evil.test/a", "https://127.0.0.1/a", "https://zme-caps.amazon.com:8443/a", "https://user:password@zme-caps.amazon.com/a", "file:///a", "https://169.254.169.254/latest/meta-data"])("rejects unsafe URL %s", (url) => {
    expect(() => safeAmazonArchiveUrl(url)).toThrow("unsafe_url");
  });
  it.each(["127.0.0.1", "10.2.3.4", "172.16.0.1", "192.168.1.2", "169.254.169.254", "100.64.1.1", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "2001:db8::1", "invalid"])("rejects private or reserved destination %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
  it("accepts global destinations", () => { expect(isPublicAddress("54.239.28.85")).toBe(true); expect(isPublicAddress("2600:9000::1")).toBe(true); });
});
