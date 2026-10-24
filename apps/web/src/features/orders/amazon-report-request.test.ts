import { afterEach, describe, expect, it, vi } from "vitest";

import { reportRequest, reportUserError } from "./amazon-report-request";

describe("Amazon report request diagnostics", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps safe row diagnostics visible through the workspace error filter", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code: "report_columns_mismatch", row: 7 }, { status: 422 })));
    const message = await reportRequest("import", {}).catch(reportUserError);
    expect(message).toBe("订单报告第 7 行：列数与表头不一致");
  });

  it("shows only known missing headers without discarding the actionable message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code: "report_headers_missing", missingHeaders: ["order-id", "sku"] }, { status: 422 })));
    const message = await reportRequest("import", {}).catch(reportUserError);
    expect(message).toContain("缺少：order-id、sku");
    expect(message).not.toContain("操作未完成");
  });

  it.each([
    { message: "buyer@example.test https://private.example.test" },
    { code: "report_columns_mismatch", row: 7, message: "private buyer" },
    { code: "report_headers_missing", missingHeaders: ["private buyer"] },
    { code: "unknown_private_code" },
    { code: "report_columns_mismatch", row: "private buyer" },
  ])("rejects untrusted or unsupported diagnostic bodies: %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body, { status: 422 })));
    expect(await reportRequest("import", {}).catch(reportUserError)).toBe("操作未完成，请检查文件或稍后重试。");
  });

  it("keeps non-JSON errors generic and preserves authentication messages", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("<html>private buyer</html>", { status: 422 }))
      .mockResolvedValueOnce(Response.json({ code: "report_columns_mismatch", row: 7 }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await reportRequest("import", {}).catch(reportUserError)).toBe("操作未完成，请检查文件或稍后重试。");
    expect(await reportRequest("import", {}).catch(reportUserError)).toBe("登录已失效，请重新登录。");
  });

  it("accepts diagnostics only on import mutations", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(Response.json({ code: "report_columns_mismatch", row: 7 }, { status: 422 }))));
    expect(await reportRequest("workspace").catch(reportUserError)).toBe("操作未完成，请检查文件或稍后重试。");
    expect(await reportRequest("resume", {}).catch(reportUserError)).toBe("操作未完成，请检查文件或稍后重试。");
    expect(await reportRequest("import").catch(reportUserError)).toBe("操作未完成，请检查文件或稍后重试。");
  });
});
