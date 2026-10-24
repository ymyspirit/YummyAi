import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { apiFetch } from "../../../server-api";
import { ApiConnectionError } from "../../../server-api-transport";
import ResearchPage from "./page";

vi.mock("../../../server-api", () => ({ apiFetch: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

it("shows a recoverable outage without a false zero count and preserves filters in a full reload", async () => {
  vi.stubEnv("API_BASE_URL", "http://api.test");
  vi.mocked(apiFetch).mockRejectedValue(new ApiConnectionError("api", new TypeError("fetch failed")));
  const page = await ResearchPage({ searchParams: Promise.resolve({ visibility: "archived", q: "custom pillow", priceMin: "10" }) });
  const html = renderToStaticMarkup(page);
  expect(html).toContain('role="alert"');
  expect(html).toContain("数据服务暂时无法连接");
  expect(html).toContain("暂不可用");
  expect(html).not.toContain("0 RESULTS");
  expect(html).not.toContain("fetch failed");
  expect(html).toContain('href="/research?visibility=archived&amp;priceMin=10&amp;q=custom+pillow"');
  expect(html).toContain("重新加载");
});

it("retains an authorization failure instead of claiming the backend is restarting", async () => {
  vi.stubEnv("API_BASE_URL", "http://api.test");
  vi.mocked(apiFetch).mockResolvedValue(new Response(null, { status: 403 }));
  const html = renderToStaticMarkup(await ResearchPage({ searchParams: Promise.resolve({}) }));
  expect(html).toContain("当前成员没有 research:read 权限");
  expect(html).not.toContain("可能正在重启");
});
