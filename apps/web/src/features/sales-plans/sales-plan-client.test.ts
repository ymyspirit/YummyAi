import { afterEach, describe, expect, it, vi } from "vitest";
import { salesPlanReadDenied, salesPlanRequest } from "./sales-plan-client";
describe("sales-plan transport errors", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("retains status for denial while a conflict can keep a legitimate draft", async () => {
    const mock = vi
      .fn()
      .mockResolvedValue(Response.json({ message: "Synthetic denied" }, { status: 404 }));
    vi.stubGlobal("fetch", mock);
    const denied = await salesPlanRequest("synthetic").catch((error) => error);
    expect(salesPlanReadDenied(denied)).toBe(true);
    mock.mockResolvedValue(
      Response.json({ message: "Synthetic revision conflict" }, { status: 409 }),
    );
    const conflict = await salesPlanRequest("synthetic", {}).catch((error) => error);
    expect(conflict).toMatchObject({ status: 409 });
    expect(salesPlanReadDenied(conflict)).toBe(false);
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it("does not retry an uncertain write or describe an unreadable response as success", async () => {
    const mock = vi.fn().mockRejectedValue(new TypeError("Synthetic network outage"));
    vi.stubGlobal("fetch", mock);
    await expect(
      salesPlanRequest("synthetic", { idempotencyKey: "same-owned-key" }),
    ).rejects.toThrow("操作结果尚未确认");
    expect(mock).toHaveBeenCalledTimes(1);
    mock.mockResolvedValue(
      Response.json({ message: "Synthetic upstream failure" }, { status: 502 }),
    );
    await expect(
      salesPlanRequest("synthetic", { idempotencyKey: "same-owned-key" }),
    ).rejects.toMatchObject({ status: 502, message: expect.stringContaining("操作结果尚未确认") });
    expect(mock).toHaveBeenCalledTimes(2);
    mock.mockResolvedValue(new Response("not JSON"));
    await expect(salesPlanRequest("synthetic")).rejects.toMatchObject({ status: 502 });
    await expect(
      salesPlanRequest("synthetic", { idempotencyKey: "same-owned-key" }),
    ).rejects.toThrow("操作结果尚未确认");
    expect(mock).toHaveBeenCalledTimes(4);
  });
});
