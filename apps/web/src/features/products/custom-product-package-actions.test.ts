import type { CustomProductProfileV1 } from "@yummyai/contracts/catalog/custom-product-package";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetchMock, revalidatePathMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn<typeof fetch>(),
  revalidatePathMock: vi.fn(),
}));

vi.mock("../../server-api", () => ({ apiFetch: apiFetchMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

import {
  generateProvisionalCustomProductProfile,
  saveCustomProductProfile,
} from "./custom-product-package-actions";

const planId = "019fb6f5-0985-74b0-88d2-f4c6cf22555b";
const researchItemId = "019fb6ba-fa80-7c6c-afb5-1c9594cc0d8c";
const idle = { message: "", status: "idle" as const };

beforeEach(() => {
  apiFetchMock.mockReset();
  revalidatePathMock.mockReset();
  process.env.API_BASE_URL = "http://api.test";
  apiFetchMock.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
      status: 200,
    }),
  );
});

describe("Amazon Custom product package actions", () => {
  it("generates provisional facts from an explicit research item", async () => {
    const formData = new FormData();
    formData.set("researchItemId", researchItemId);
    formData.set("targetMarketplace", "amazon.com");

    const result = await generateProvisionalCustomProductProfile(planId, idle, formData);

    expect(result.status).toBe("success");
    expect(apiFetchMock).toHaveBeenCalledWith(
      `http://api.test/v1/products/plans/${planId}/custom-package/provisional`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(String(apiFetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      researchItemId,
      targetMarketplace: "amazon.com",
    });
  });

  it("persists seller edits while unchanged competitor facts retain provenance", async () => {
    const formData = profileForm(profile());
    formData.set("sku", "VPHOTO-TOPPER-DRAFT-001");

    const result = await saveCustomProductProfile(planId, idle, formData);

    expect(result.status).toBe("success");
    const request = apiFetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as { profile: CustomProductProfileV1 };
    expect(body.profile.sku).toMatchObject({
      source: "seller_provided",
      value: "VPHOTO-TOPPER-DRAFT-001",
      verificationStatus: "unverified",
    });
    expect(body.profile.materials[0]).toMatchObject({
      source: "competitor_reference",
      value: "3mm wood and acrylic",
      verificationStatus: "unverified",
    });
    expect(request?.method).toBe("PATCH");
  });
});

function profileForm(current: CustomProductProfileV1) {
  const formData = new FormData();
  formData.set("currentProfile", JSON.stringify(current));
  formData.set("sku", current.sku?.value ?? "");
  formData.set("targetMarketplace", current.targetMarketplace?.value ?? "");
  formData.set("productType", current.productType?.value ?? "");
  formData.set("brand", current.brand?.value ?? "");
  formData.set("materials", current.materials.map((fact) => fact.value).join("\n"));
  formData.set("colors", "");
  formData.set("sizeOptions", current.sizeOptions.map((fact) => fact.value).join("\n"));
  formData.set("packageQuantity", "");
  formData.set("packageContents", "");
  formData.set("manufacturingProcess", current.manufacturingProcess?.value ?? "");
  formData.set("targetAudiences", current.targetAudiences.map((fact) => fact.value).join("\n"));
  formData.set("sellingPoints", current.sellingPoints.map((fact) => fact.value).join("\n"));
  formData.set("surfaceLabel", current.surfaces[0]?.label ?? "");
  formData.set("surfaceProcess", current.surfaces[0]?.process ?? "");
  formData.set("surfaceFieldKeys", JSON.stringify(current.surfaces[0]?.fieldKeys ?? []));
  formData.set("assetAssignments", "");
  return formData;
}

function profile(): CustomProductProfileV1 {
  const competitor = (value: string) => ({
    value,
    source: "competitor_reference" as const,
    verificationStatus: "unverified" as const,
  });
  return {
    schemaVersion: "1.0",
    sku: {
      value: "DRAFT-4451179943",
      source: "inferred_from_research",
      verificationStatus: "unverified",
    },
    targetMarketplace: {
      value: "amazon.com",
      source: "seller_provided",
      verificationStatus: "unverified",
    },
    productType: {
      value: "Cake Toppers",
      source: "inferred_from_research",
      verificationStatus: "unverified",
    },
    materials: [competitor("3mm wood and acrylic")],
    colors: [],
    sizeOptions: [competitor('6"x6" (recommend)')],
    packageContents: [],
    manufacturingProcess: competitor("Single-side printed with a copperplate paper surface"),
    targetAudiences: [],
    sellingPoints: [],
    surfaces: [
      {
        key: "front",
        label: "Front",
        fieldKeys: ["photo_upload"],
        source: "inferred_from_research",
        verificationStatus: "unverified",
      },
    ],
    approvedClaims: [],
    prohibitedClaims: [],
    prohibitedElements: [],
    researchItemIds: [researchItemId],
    assetAssignments: [],
    updatedAt: "2026-07-31T00:00:00.000Z",
  };
}
