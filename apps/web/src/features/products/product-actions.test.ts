import { createEntityId } from "@yummyai/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetchMock, revalidatePathMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn<typeof fetch>(),
  revalidatePathMock: vi.fn(),
}));

vi.mock("../../server-api", () => ({ apiFetch: apiFetchMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

import { createProductPlan, createProductSku, createProductSpu, transitionProductPlan } from "./product-actions";

const idle = { message: "", status: "idle" as const };

beforeEach(() => {
  apiFetchMock.mockReset();
  revalidatePathMock.mockReset();
  process.env.API_BASE_URL = "http://api.test";
});

describe("createProductPlan", () => {
  it("validates malformed research report IDs before calling the API", async () => {
    const formData = new FormData();
    formData.set("name", "定制抱枕");
    formData.set("sourceReportIds", "not-a-report-id");

    const result = await createProductPlan(idle, formData);

    expect(result.status).toBe("error");
    expect(result.fieldErrors?.sourceReportIds).toContain("UUIDv7");
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("creates a researching plan through the authenticated API boundary", async () => {
    const planId = createEntityId();
    const reportId = createEntityId();
    apiFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: planId, status: "researching" }), {
        headers: { "content-type": "application/json" },
        status: 201,
      }),
    );
    const formData = new FormData();
    formData.set("name", "定制抱枕");
    formData.set("description", "宿舍与礼赠场景");
    formData.set("targetCostAmount", "8.50");
    formData.set("targetCostCurrency", "USD");
    formData.set("sourceReportIds", reportId);

    const result = await createProductPlan(idle, formData);

    expect(result).toMatchObject({ planId, status: "success" });
    expect(apiFetchMock).toHaveBeenCalledWith(
      "http://api.test/v1/products/plans",
      expect.objectContaining({ method: "POST" }),
    );
    const request = apiFetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({
      customization: { fields: [], version: 1 },
      description: "宿舍与礼赠场景",
      name: "定制抱枕",
      sourceReportIds: [reportId],
      targetCost: { amount: 8.5, currency: "USD" },
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/products");
  });

  it("uses lifecycle, SPU, and SKU API routes for product development", async () => {
    const planId = createEntityId();
    const spuId = createEntityId();
    apiFetchMock.mockResolvedValue(new Response(JSON.stringify({ id: createEntityId() }), { headers: { "content-type": "application/json" }, status: 201 }));

    await transitionProductPlan(planId, "pending_approval", idle, new FormData());
    const spu = new FormData(); spu.set("code", "pillow"); spu.set("name", "Custom pillow");
    await createProductSpu(planId, idle, spu);
    const sku = new FormData(); sku.set("code", "pillow-std"); sku.set("attributes", "size: 16x16, color: natural"); sku.set("unitCostAmount", "7.50"); sku.set("unitCostCurrency", "USD");
    await createProductSku(planId, spuId, idle, sku);

    expect(apiFetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      `http://api.test/v1/products/plans/${planId}/transitions`,
      `http://api.test/v1/products/plans/${planId}/spu`,
      "http://api.test/v1/products/skus",
    ]);
    expect(JSON.parse(String(apiFetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      attributes: { color: "natural", size: "16x16" }, code: "PILLOW-STD", spuId,
    });
  });
});
