import { createEntityId } from "@yummyai/contracts/common/ids";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetchMock, revalidatePathMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn<typeof fetch>(),
  revalidatePathMock: vi.fn(),
}));
vi.mock("../../server-api", () => ({ apiFetch: apiFetchMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

import {
  createBlankPersonalizationTemplate,
  clonePersonalizationTemplate,
  createListingArtifactBinding,
  createSkuTemplateBinding,
  createTemplateSourceInspection,
  confirmTemplateSourceInspection,
  reviewProductionManifest,
  runPodVisualSearch,
} from "./pod-governance-actions";

const idle = { message: "", status: "idle" as const };

beforeEach(() => {
  apiFetchMock.mockReset();
  revalidatePathMock.mockReset();
  process.env.API_BASE_URL = "http://api.test";
});

describe("POD governance actions", () => {
  it("copies an approved template into a pinned independent draft", async () => {
    const sourceTemplateVersionId = createEntityId();
    const copiedTemplateVersionId = createEntityId();
    const copiedTemplateId = createEntityId();
    apiFetchMock.mockResolvedValueOnce(json({
      id: copiedTemplateVersionId,
      templateId: copiedTemplateId,
      versionNumber: 1,
      name: "组织宠物模板副本",
      source: "popular_template",
      sourceTemplateVersionId,
      canvas: { width: 3000, height: 3000, dpi: 300, colorMode: "rgb" },
      status: "draft",
      slots: [],
      createdAt: "2026-08-04T00:00:00.000Z",
    }, 201));
    const form = new FormData();
    form.set("id", sourceTemplateVersionId);
    form.set("name", "组织宠物模板副本");

    const result = await clonePersonalizationTemplate(idle, form);

    expect(result.status).toBe("success");
    expect(apiFetchMock).toHaveBeenCalledWith(
      `http://api.test/v1/pod/personalization-templates/${sourceTemplateVersionId}/clone`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "组织宠物模板副本" }) }),
    );
    expect(revalidatePathMock).toHaveBeenCalledWith("/pod-workbench");
  });

  it("creates a fixed blank template request with same-name image slots", async () => {
    const templateId = createEntityId();
    const versionId = createEntityId();
    const responseSlots = [slot(versionId, "front.photo", "顾客图片", 0), slot(versionId, "back.photo", "顾客图片", 1600), {
      ...slot(versionId, "caption", "顾客姓名", 300),
      kind: "text",
      fillMode: "none",
    }];
    apiFetchMock.mockResolvedValueOnce(json({
      id: versionId,
      templateId,
      versionNumber: 1,
      name: "双面宠物挂牌",
      source: "blank",
      canvas: { width: 3000, height: 3000, dpi: 300, colorMode: "rgb" },
      status: "draft",
      slots: responseSlots,
      createdAt: "2026-08-03T08:00:00.000Z",
    }, 201));

    const result = await createBlankPersonalizationTemplate(idle, templateForm());

    expect(result.status).toBe("success");
    const body = JSON.parse(String(apiFetchMock.mock.calls[0]?.[1]?.body)) as { slots: Array<{ name: string; stableKey: string }> };
    expect(body.slots.slice(0, 2)).toEqual([
      expect.objectContaining({ stableKey: "front.photo", name: "顾客图片" }),
      expect.objectContaining({ stableKey: "back.photo", name: "顾客图片" }),
    ]);
    expect(apiFetchMock).toHaveBeenCalledWith("http://api.test/v1/pod/personalization-templates", expect.objectContaining({ method: "POST" }));
    expect(revalidatePathMock).toHaveBeenCalledWith("/pod-workbench");
  });

  it("keeps repeated template slots mapped to one customer field", async () => {
    const bindingId = createEntityId();
    const skuId = createEntityId();
    const templateVersionId = createEntityId();
    apiFetchMock.mockResolvedValueOnce(json({
      id: bindingId,
      skuId,
      templateVersionId,
      sizeLabel: "M",
      mappingSnapshot: { slotFieldMap: { "front.photo": "customer_image_1", "back.photo": "customer_image_1" } },
      effectiveFrom: "2026-08-03T08:00:00.000Z",
      status: "active",
      createdAt: "2026-08-03T08:00:00.000Z",
    }, 201));
    const form = new FormData();
    form.set("skuId", skuId);
    form.set("templateVersionId", templateVersionId);
    form.set("sizeLabel", "M");
    form.set("slotField.front.photo", "customer_image_1");
    form.set("slotField.back.photo", "customer_image_1");

    const result = await createSkuTemplateBinding(idle, form);

    expect(result.status).toBe("success");
    const body = JSON.parse(String(apiFetchMock.mock.calls[0]?.[1]?.body)) as { mappingSnapshot: { slotFieldMap: Record<string, string> } };
    expect(body.mappingSnapshot.slotFieldMap).toEqual({
      "front.photo": "customer_image_1",
      "back.photo": "customer_image_1",
    });
  });

  it("creates an identifier-only source inspection request pinned to an asset version", async () => {
    const inspectionId = createEntityId();
    const sourceAssetId = createEntityId();
    apiFetchMock.mockResolvedValueOnce(json({
      id: inspectionId,
      sourceAssetId,
      sourceAssetVersion: 4,
      checksumSha256: "a".repeat(64),
      source: "psd",
      status: "queued",
      parserKey: "yummyai-template-source",
      parserVersion: "1.0.0",
      slots: [],
      warnings: [],
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
    }, 201));
    const form = new FormData();
    form.set("sourceAsset", `${sourceAssetId}:4`);

    const result = await createTemplateSourceInspection(idle, form);

    expect(result.status).toBe("success");
    const body = JSON.parse(String(apiFetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ sourceAssetId, sourceAssetVersion: 4 });
    expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).not.toHaveProperty("objectKey");
  });

  it("confirms only reviewed slot controls while geometry remains server-owned", async () => {
    const inspectionId = createEntityId();
    const templateVersionId = createEntityId();
    const templateId = createEntityId();
    const sourceAssetId = createEntityId();
    apiFetchMock.mockResolvedValueOnce(json({
      id: templateVersionId,
      templateId,
      versionNumber: 1,
      name: "PSD 宠物模板",
      source: "psd",
      sourceAssetId,
      sourceAssetVersion: 1,
      sourceInspectionId: inspectionId,
      canvas: { width: 3000, height: 3000, dpi: 300, colorMode: "rgb" },
      status: "draft",
      slots: [{ ...slot(templateVersionId, "image.customer", "顾客照片", 100), psdGroup: "image" }],
      createdAt: "2026-08-04T00:02:00.000Z",
    }, 201));
    const form = new FormData();
    form.set("inspectionId", inspectionId);
    form.set("slotCount", "1");
    form.set("name", "PSD 宠物模板");
    form.set("acknowledgeWarnings", "on");
    form.set("slot.0.stableKey", "image.customer");
    form.set("slot.0.name", "顾客照片");
    form.set("slot.0.kind", "image");
    form.set("slot.0.fillMode", "cover");
    form.set("slot.0.replaceable", "on");

    const result = await confirmTemplateSourceInspection(idle, form);

    expect(result.status).toBe("success");
    const body = JSON.parse(String(apiFetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ name: "PSD 宠物模板", slots: [{ stableKey: "image.customer", kind: "image", replaceable: true }] });
    expect(JSON.stringify(body)).not.toContain("geometry");
  });

  it("requires a rejection reason before reviewing a production manifest", async () => {
    const form = new FormData();
    form.set("id", createEntityId());
    form.set("decision", "reject");

    const result = await reviewProductionManifest(idle, form);

    expect(result.status).toBe("error");
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("returns visual similarity evidence without converting it into a legal conclusion", async () => {
    const assetId = createEntityId();
    const fingerprintId = createEntityId();
    const hitAssetId = createEntityId();
    apiFetchMock.mockResolvedValueOnce(json({
      queryFingerprintId: fingerprintId,
      hits: [{
        fingerprintId: createEntityId(),
        assetId: hitAssetId,
        assetVersion: 2,
        assetDomain: "research",
        exactChecksumMatch: false,
        perceptualSimilarityPermille: 875,
      }],
    }));
    const form = new FormData();
    form.set("assetId", assetId);
    form.set("assetVersion", "1");
    form.set("domain", "all");
    form.set("maxHammingDistance", "16");
    form.set("limit", "20");

    const result = await runPodVisualSearch(idle, form);

    expect(result).toMatchObject({ status: "success", queryFingerprintId: fingerprintId });
    expect(result.hits?.[0]).toMatchObject({ assetId: hitAssetId, assetDomain: "research", perceptualSimilarityPermille: 875 });
    expect(result.message).not.toContain("侵权");
  });

  it("pins a reviewed asset version to a fixed Listing slot", async () => {
    const id = createEntityId();
    const listingVersionId = createEntityId();
    const assetId = createEntityId();
    apiFetchMock.mockResolvedValueOnce(json({
      id,
      listingVersionId,
      assetId,
      assetVersion: 3,
      contentKind: "image",
      slotKey: "gallery.1",
      status: "candidate",
      createdAt: "2026-08-03T08:00:00.000Z",
    }, 201));
    const form = new FormData();
    form.set("listingVersionId", listingVersionId);
    form.set("assetSelection", `${assetId}:3`);
    form.set("contentKind", "image");
    form.set("slotKey", "gallery.1");

    const result = await createListingArtifactBinding(idle, form);

    expect(result.status).toBe("success");
    expect(JSON.parse(String(apiFetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      listingVersionId,
      assetId,
      assetVersion: 3,
      contentKind: "image",
      slotKey: "gallery.1",
    });
    expect(apiFetchMock).toHaveBeenCalledWith("http://api.test/v1/pod/listing-artifacts", expect.objectContaining({ method: "POST" }));
  });
});

function templateForm() {
  const form = new FormData();
  const entries: Record<string, string> = {
    name: "双面宠物挂牌",
    canvasWidth: "3000",
    canvasHeight: "3000",
    canvasDpi: "300",
    colorMode: "rgb",
    primaryStableKey: "front.photo",
    primaryName: "顾客图片",
    primaryX: "0",
    primaryY: "0",
    primaryWidth: "1400",
    primaryHeight: "2200",
    secondaryStableKey: "back.photo",
    secondaryName: "顾客图片",
    secondaryX: "1600",
    secondaryY: "0",
    secondaryWidth: "1400",
    secondaryHeight: "2200",
    captionStableKey: "caption",
    captionName: "顾客姓名",
    captionX: "300",
    captionY: "2450",
    captionWidth: "2400",
    captionHeight: "300",
  };
  for (const [key, value] of Object.entries(entries)) form.set(key, value);
  return form;
}

function slot(templateVersionId: string, stableKey: string, name: string, x: number) {
  return {
    id: createEntityId(),
    templateVersionId,
    stableKey,
    name,
    kind: "image",
    geometry: { x, y: 0, width: 1400, height: 2200, rotationDegrees: 0 },
    fillMode: "cover",
    validationSnapshot: { required: true },
    replaceable: true,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}
