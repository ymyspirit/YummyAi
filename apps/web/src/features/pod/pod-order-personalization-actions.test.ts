import { createEntityId } from "@yummyai/contracts/common/ids";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetchMock, revalidatePathMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn<typeof fetch>(),
  revalidatePathMock: vi.fn(),
}));
vi.mock("../../server-api", () => ({ apiFetch: apiFetchMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

import {
  createOrderPersonalizationBatch,
  createOrderPersonalizationRenderTask,
} from "./pod-order-personalization-actions";

const idle = { message: "", status: "idle" as const };

beforeEach(() => {
  apiFetchMock.mockReset();
  revalidatePathMock.mockReset();
  process.env.API_BASE_URL = "http://api.test";
});

describe("POD order personalization actions", () => {
  it("creates an identifier-only preparation batch", async () => {
    const orderId = createEntityId();
    const orderLineId = createEntityId();
    const customizationVersionId = createEntityId();
    const bindingId = createEntityId();
    const batchId = createEntityId();
    const itemId = createEntityId();
    apiFetchMock.mockResolvedValueOnce(json({
      id: batchId,
      idempotencyKey: createEntityId(),
      status: "queued",
      itemCount: 1,
      preparedCount: 0,
      failedCount: 0,
      items: [{
        id: itemId,
        ordinal: 0,
        orderId,
        orderLineId,
        customizationVersionId,
        bindingId,
        status: "queued",
        resolvedSlotCount: 0,
      }],
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
    }, 201));
    const form = new FormData();
    form.append("candidate", [orderId, orderLineId, customizationVersionId, bindingId].join(":"));

    const result = await createOrderPersonalizationBatch(idle, form);

    expect(result.status).toBe("success");
    const body = JSON.parse(String(apiFetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ items: [{ orderId, orderLineId, customizationVersionId, bindingId }] });
    expect(JSON.stringify(body)).not.toMatch(/customer|encrypted|name|message/i);
    expect(revalidatePathMock).toHaveBeenCalledWith("/pod-workbench");
  });

  it("rejects selecting two template bindings for the same order line", async () => {
    const orderId = createEntityId();
    const orderLineId = createEntityId();
    const customizationVersionId = createEntityId();
    const form = new FormData();
    form.append("candidate", [orderId, orderLineId, customizationVersionId, createEntityId()].join(":"));
    form.append("candidate", [orderId, orderLineId, customizationVersionId, createEntityId()].join(":"));

    const result = await createOrderPersonalizationBatch(idle, form);

    expect(result).toMatchObject({ status: "error" });
    expect(result.message).toContain("同一订单行");
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("creates a fulfillment render without accepting customer values", async () => {
    const batchItemId = createEntityId();
    const renderTaskId = createEntityId();
    const designTaskId = createEntityId();
    apiFetchMock.mockResolvedValueOnce(json({
      id: renderTaskId,
      idempotencyKey: createEntityId(),
      batchItemId,
      designTaskId,
      toolKey: "fulfillment_composite",
      status: "queued",
      parameterSnapshot: {
        outputFormat: "tiff",
        fitMode: "cover",
        autoComposition: "off",
        allowAiEnhancement: false,
        dpi: 300,
        colorMode: "cmyk",
        transparent: false,
      },
      progressPercent: 0,
      attemptCount: 0,
      maxAttempts: 3,
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
    }, 201));
    const form = new FormData();
    form.set("batchItemId", batchItemId);
    form.set("toolKey", "fulfillment_composite");
    form.set("outputFormat", "tiff");
    form.set("fitMode", "cover");
    form.set("autoComposition", "off");
    form.set("dpi", "300");
    form.set("colorMode", "cmyk");
    form.set("customerName", "must not leave the browser");

    const result = await createOrderPersonalizationRenderTask(idle, form);

    expect(result.status).toBe("success");
    const body = JSON.parse(String(apiFetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      batchItemId,
      toolKey: "fulfillment_composite",
      parameterSnapshot: { outputFormat: "tiff", dpi: 300, colorMode: "cmyk" },
    });
    expect(JSON.stringify(body)).not.toContain("must not leave the browser");
  });

  it("pins strict identity and all-input rules for a group photo render", async () => {
    const batchItemId = createEntityId();
    apiFetchMock.mockResolvedValueOnce(json({
      id: createEntityId(),
      idempotencyKey: createEntityId(),
      batchItemId,
      designTaskId: createEntityId(),
      toolKey: "group_photo",
      status: "queued",
      parameterSnapshot: {
        outputFormat: "png",
        fitMode: "template",
        autoComposition: "subject_focus",
        allowAiEnhancement: true,
        identityMode: "strict",
        customerAssetUsage: "all",
        referenceIdentityTransfer: "not_applicable",
        dpi: 300,
        colorMode: "rgb",
        transparent: false,
      },
      progressPercent: 0,
      attemptCount: 0,
      maxAttempts: 3,
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
    }, 201));
    const form = new FormData();
    form.set("batchItemId", batchItemId);
    form.set("toolKey", "group_photo");
    form.set("outputFormat", "png");
    form.set("fitMode", "template");
    form.set("autoComposition", "subject_focus");
    form.set("allowAiEnhancement", "on");
    form.set("identityMode", "strict");
    form.set("customerAssetUsage", "all");
    form.set("referenceIdentityTransfer", "not_applicable");
    form.set("dpi", "300");
    form.set("colorMode", "rgb");

    const result = await createOrderPersonalizationRenderTask(idle, form);

    expect(result.status).toBe("success");
    const body = JSON.parse(String(apiFetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      batchItemId,
      toolKey: "group_photo",
      parameterSnapshot: {
        autoComposition: "subject_focus",
        allowAiEnhancement: true,
        identityMode: "strict",
        customerAssetUsage: "all",
        referenceIdentityTransfer: "not_applicable",
      },
    });
  });

  it("creates a non-generative SVG production plan without forwarding customer values", async () => {
    const batchItemId = createEntityId();
    apiFetchMock.mockResolvedValueOnce(json({
      id: createEntityId(),
      idempotencyKey: createEntityId(),
      batchItemId,
      designTaskId: createEntityId(),
      toolKey: "vector_fulfillment",
      status: "queued",
      parameterSnapshot: {
        outputFormat: "svg",
        fitMode: "template",
        autoComposition: "off",
        allowAiEnhancement: false,
        identityMode: "standard",
        customerAssetUsage: "mapped",
        referenceIdentityTransfer: "not_applicable",
        colorMode: "spot",
        transparent: true,
        vectorTemplateProfile: "laser-cut-v1",
        vectorWidth: 300,
        vectorHeight: 400,
        vectorUnit: "mm",
        vectorLayoutMode: "template",
        textToPath: true,
        hollowMode: true,
        bridgeWidthMm: 1.5,
        minimumLineWidthMm: 0.3,
        pathRepair: "safe",
      },
      progressPercent: 0,
      attemptCount: 0,
      maxAttempts: 3,
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
    }, 201));
    const form = new FormData();
    form.set("batchItemId", batchItemId);
    form.set("toolKey", "vector_fulfillment");
    form.set("colorMode", "spot");
    form.set("vectorTemplateProfile", "laser-cut-v1");
    form.set("vectorWidth", "300");
    form.set("vectorHeight", "400");
    form.set("vectorUnit", "mm");
    form.set("vectorLayoutMode", "template");
    form.set("hollowMode", "on");
    form.set("bridgeWidthMm", "1.5");
    form.set("minimumLineWidthMm", "0.3");
    form.set("pathRepair", "safe");
    form.set("customerMessage", "must stay in the protected order domain");

    const result = await createOrderPersonalizationRenderTask(idle, form);

    expect(result).toMatchObject({ status: "success" });
    const body = JSON.parse(String(apiFetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      batchItemId,
      toolKey: "vector_fulfillment",
      parameterSnapshot: {
        outputFormat: "svg",
        allowAiEnhancement: false,
        colorMode: "spot",
        transparent: true,
        textToPath: true,
        vectorWidth: 300,
        bridgeWidthMm: 1.5,
      },
    });
    expect(JSON.stringify(body)).not.toContain("must stay in the protected order domain");
  });

  it("rejects an incomplete vector production plan before calling the API", async () => {
    const form = new FormData();
    form.set("batchItemId", createEntityId());
    form.set("toolKey", "vector_fulfillment");
    form.set("colorMode", "spot");

    const result = await createOrderPersonalizationRenderTask(idle, form);

    expect(result).toMatchObject({ status: "error" });
    expect(result.message).toContain("SVG 生产参数");
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}
