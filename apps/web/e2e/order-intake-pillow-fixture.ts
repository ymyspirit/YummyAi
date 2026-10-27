import { createHash } from "node:crypto";
import JSZip from "jszip";
import { expect } from "@playwright/test";
import {
  createEntityId,
  type AmazonReportBatchView,
  type AmazonReportWorkspaceView,
  type MarketplaceAccountView,
} from "@yummyai/contracts";
import { AmazonReportDetailViewSchema } from "@yummyai/contracts/order/report";
import {
  OrderWorkDetailViewSchema,
  type OrderWorkDraft,
} from "@yummyai/contracts/order/workspace";
import type { ArtworkView, DevelopmentOptions, SpecificationView } from "@yummyai/contracts/catalog/development";
import { requireDisposableIntegrationEnvironment } from "../../../tools/testing/require-disposable-integration.mjs";
import { syntheticSpecificationFacts } from "../../../tools/testing/specification-fixtures.js";
import { apiFetch } from "../src/server-api";
import { centerApi, createCenterProfile, createCenterSpu } from "./order-centers-fixture";
import { syntheticProductionPng } from "./production-editor-fixture";

/** Only the parent runner owns removal of this fixture's database and private bucket. */
export async function orderIntakePillowFixture(specialRequirements: boolean) {
  requireDisposableIntegrationEnvironment();
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(
    new URL(process.env.DATABASE_URL!).pathname,
  )?.[1];
  if (!nonce || process.env.WEB_AUTH_MODE !== "personal")
    throw new Error("Personal disposable pillow intake fixture required");

  const suffix = createEntityId();
  const externalId = "SYNTHETIC-PILLOW-INTAKE-" + suffix;
  const profile = await createCenterProfile(
    "shaped_pillow", "INTAKE-" + suffix.slice(-8), false, undefined,
    { longestSideInches: 10 },
  );
  // false above returns before the shared fixture's production render/Worker path.
  expect(profile.manufacturingSource).toBeNull();
  const catalog = await centerApi<DevelopmentOptions>("product-development/options");
  const existingSpus = catalog.spus.filter(item => item.code === "CUSTOM-SHAPED-PILLOW");
  expect(existingSpus.length).toBeLessThanOrEqual(1);
  const spu = existingSpus[0] ?? await createCenterSpu("CUSTOM-SHAPED-PILLOW");
  const existing = catalog.specifications
    .filter(item => item.spuId === spu.id && item.code === "SIZE-10IN")
    .sort((left, right) => right.version - left.version)[0];
  const { specification } = await centerApi<{ specification: SpecificationView }>(
    "product-development/specifications",
    {
      spuId: spu.id, code: "SIZE-10IN", name: "Synthetic intake 10 inch",
      attributes: { size: "10 inch" },
      facts: syntheticSpecificationFacts({
        material: "Synthetic pillow fixture fabric",
        structure: "Synthetic two-panel direct-sewn fixture without gusset",
      }),
      processProfileVersionId: profile.versionId,
      expectedVersion: existing?.version ?? 0, idempotencyKey: createEntityId(),
    },
  );
  expect(specification.version).toBe((existing?.version ?? 0) + 1);
  if (existing) {
    expect(specification.id).toBe(existing.id);
    expect(specification.versionId).not.toBe(existing.versionId);
  }
  const { artwork } = await centerApi<{ artwork: ArtworkView }>(
    "product-development/artworks",
    {
      code: "INTAKE-PHOTO-" + suffix, name: "Synthetic buyer-photo intake",
      mode: "customer_image", expectedVersion: 0, idempotencyKey: createEntityId(),
      instructions: "Synthetic intake only No generation, dispatch or factory release",
      customization: {
        version: 1,
        fields: [
          {
            key: "buyer_photo", label: "顾客原图", type: "image", required: true,
            validation: { maxFiles: 1, maxBytes: 1000000, allowedMediaTypes: ["image/png"] },
          },
          {
            key: "crop_scope", label: "裁切范围", type: "short_text", required: true,
            validation: { maxLength: 120 },
          },
          {
            key: "print_sides", label: "印刷面数", type: "single_choice", required: true,
            options: [
              { label: "单面印刷", value: "single_sided" },
              { label: "双面印刷", value: "double_sided" },
            ],
          },
          {
            key: "customer_notes", label: "顾客特殊要求", type: "long_text", required: false,
            validation: { maxLength: 1000 },
          },
        ],
      },
    },
  );
  const account = await centerApi<MarketplaceAccountView>("marketplace-accounts", {
    platform: "amazon", displayName: externalId, region: "NA",
    marketplaceIds: ["ATVPDKIKX0DER"], authorizationMode: "amazon_private",
    requestedScopes: [],
  });
  const itemId = "PILLOW-ITEM-" + suffix;
  const batch = await centerApi<AmazonReportBatchView>("orders/reports/import", {
    accountId: account.id, marketplaceId: "ATVPDKIKX0DER",
    fileName: "synthetic-pillow-intake.txt",
    content: [
      "order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price",
      [externalId, itemId, new Date().toISOString(), "SYNTHETIC-INTAKE-10",
        "Synthetic custom shaped photo pillow", "1", "USD", "20.00"].join("\t"),
    ].join("\n"),
  });
  const imported = await centerApi<AmazonReportWorkspaceView>(
    "orders/reports/workspace?batchId=" + batch.id,
  );
  expect(imported.lines).toHaveLength(1);
  const line = imported.lines[0]!;
  const initialSource = AmazonReportDetailViewSchema.parse(
    await centerApi("orders/reports/lines/" + line.id),
  );
  const bytes = syntheticProductionPng();
  const buyerSha256 = createHash("sha256").update(bytes).digest("hex");
  const rawOptions: Array<[string, string]> = [
    ["Pillow Shape", "Only Face"],
    ["Size (Most customers choose 12/16/18/24 inch)", "10 inch-Mini Keepsake"],
    ["Style", "Double-Sided Print — Same Photo on Back"],
    ...(specialRequirements ? [
      ["Font", "Luckiest Guy"],
      ["Font Color", "CustomColor"],
      ["Order Notes for Seller", "Keep the entire synthetic head and ears"],
    ] satisfies Array<[string, string]> : []),
  ];
  const zip = new JSZip();
  zip.file("order.json", JSON.stringify({
    orderId: externalId, orderItemId: itemId,
    customizationData: {
      type: "PageContainerCustomization",
      snapshot: { imageName: "preview.png" },
      children: [
        {
          type: "ImageCustomization", label: "Upload One Clear Photo",
          image: { imageName: "buyer.png", buyerFilename: "synthetic-pillow-buyer.png" },
        },
        ...rawOptions.map(([label, name]) => ({
          type: "OptionCustomization", label, optionSelection: { name },
        })),
      ],
    },
  }));
  zip.file("buyer.png", bytes);
  zip.file("preview.png", bytes);
  const original = AmazonReportDetailViewSchema.parse(
    await centerApi("orders/reports/lines/" + line.id + "/upload", {
      expectedVersionId: initialSource.versionId,
      fileName: "synthetic-pillow-original.zip",
      contentBase64: await zip.generateAsync({ type: "base64" }),
    }),
  );
  const buyerFiles = original.files.filter(file => file.role === "buyer_image");
  expect(buyerFiles).toHaveLength(1);
  const buyer = buyerFiles[0]!;
  const sourceBefore = structuredClone({
    versionId: original.versionId, surfaces: original.surfaces, files: original.files,
  });
  let detail = OrderWorkDetailViewSchema.parse(
    await centerApi("order-centers/lines/" + line.orderLineId),
  );
  expect(detail.draft.designExecutor).toBe("agent");
  expect(detail.draft.images.map(({ origin, key }) => ({ origin, key })))
    .toEqual([{ origin: "report", key: buyer.key }]);
  const imageFields = artwork.customization.fields.filter(field => field.type === "image");
  expect(imageFields).toHaveLength(1);
  // Fix the exact synthetic catalog version through the native owner. The report's
  // real-format Size must still match it and remain in the saved draft and source.
  // This explicit fixture basis change also selects its one image field. It does
  // not rely on clicking an already-selected checkbox to remap the old usage.
  const basisDraft: OrderWorkDraft = {
    ...detail.draft,
    specificationVersionId: specification.versionId,
    artworkVersionId: artwork.versionId,
    printProfileVersionId: profile.versionId,
    images: detail.draft.images.map(image => ({ ...image, usage: imageFields[0]!.key })),
  };
  detail = OrderWorkDetailViewSchema.parse(
    await centerApi("order-centers/lines/" + line.orderLineId + "/draft", {
      expectedRevision: detail.line.revision, expectedSourceVersionId: original.versionId,
      draft: basisDraft, status: "needs_information",
      reason: "Synthetic fixture fixes product basis only; buyer fields stay raw",
      idempotencyKey: createEntityId(),
    }),
  );
  expect(detail.draft.designExecutor).toBe("agent");
  expect(detail.draft.images).toEqual([
    { origin: "report", key: buyer.key, usage: imageFields[0]!.key },
  ]);

  const readDetail = async () => OrderWorkDetailViewSchema.parse(
    await centerApi("order-centers/lines/" + line.orderLineId),
  );
  const assertOriginalPreserved = async () => {
    const actual = AmazonReportDetailViewSchema.parse(
      await centerApi("orders/reports/lines/" + line.id),
    );
    expect({
      versionId: actual.versionId, surfaces: actual.surfaces, files: actual.files,
    }).toEqual(sourceBefore);
    const response = await apiFetch(
      process.env.API_BASE_URL + "/v1/orders/reports/lines/" + line.id + "/files/"
      + encodeURIComponent(buyer.originalFileKey ?? buyer.key) + "?versionId=" + original.versionId,
    );
    expect(response.ok).toBe(true);
    expect(createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex"))
      .toBe(buyerSha256);
  };
  await assertOriginalPreserved();
  return {
    nonce, externalId, lineId: line.orderLineId, reportLineId: line.id,
    accountId: account.id, batchId: batch.id, buyer, buyerSha256, sourceVersionId: original.versionId,
    profileVersionId: profile.versionId, specificationVersionId: specification.versionId,
    artworkVersionId: artwork.versionId, initial: detail, rawOptions,
    url: "/orders?" + new URLSearchParams({
      accountId: account.id, q: externalId, line: line.orderLineId,
    }),
    readDetail, assertOriginalPreserved,
  };
}

export type OrderIntakePillowFixture = Awaited<ReturnType<typeof orderIntakePillowFixture>>;
