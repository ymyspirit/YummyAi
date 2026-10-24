import { describe, expect, it } from "vitest";
import { ConflictException } from "@nestjs/common";
import { CustomizationSchema, type ProductionEditorDocument } from "@yummyai/contracts";
import { ArtworkLayoutSchema } from "@yummyai/contracts/catalog/artwork";
import { OrderWorkDraftSchema } from "@yummyai/contracts/order/workspace";
import { assertAutomaticArtwork, composeOrderArtwork } from "./order-artwork-layout.js";
import { isPhotoOnlyPillowArtwork, orderPillowPhotoPlan } from "./order-pillow-plan.js";

const customization = CustomizationSchema.parse({
  version: 1,
  fields: [
    {
      key: "name",
      label: "姓名",
      type: "short_text",
      required: true,
      validation: { maxLength: 20 },
    },
    {
      key: "photo",
      label: "照片",
      type: "image",
      required: true,
      validation: { allowedMediaTypes: ["image/png"], maxFiles: 1, maxBytes: 100000 },
    },
  ],
});
const layout = ArtworkLayoutSchema.parse([
  { fieldKey: "name", xPercent: 10, yPercent: 75, widthPercent: 80, heightPercent: 15 },
  { fieldKey: "photo", xPercent: 10, yPercent: 10, widthPercent: 80, heightPercent: 60 },
]);
const draft = () =>
  OrderWorkDraftSchema.parse({
    printProfileVersionId: null,
    fields: [{ key: "name", label: "姓名", kind: "text", value: "Alice" }],
    images: [{ origin: "upload", key: "photo-original", usage: "photo" }],
    instructions: "",
    customerApprovalRequired: false,
    dueAt: null,
    designExecutor: "agent",
  });
const document = (): ProductionEditorDocument => ({
  schemaVersion: 1,
  name: "Private order",
  productType: "tire_cover",
  spec: { diameterMm: 100, dpi: 150, safeInsetMm: 2, opening: null },
  contour: [],
  layers: [],
  confirmations: {
    physicalSize: true,
    visualReview: true,
    whiteBorderRule: true,
    narrowParts: true,
    barcodeTab: true,
    backText: true,
  },
});

describe("private order template layout", () => {
  const pillowCustomization = CustomizationSchema.parse({ version: 1, fields: [
    { key: "buyer_photo", label: "顾客原图", type: "image", required: true, validation: { allowedMediaTypes: ["image/png"], maxFiles: 1, maxBytes: 1000000 } },
    { key: "crop_scope", label: "裁切范围", type: "short_text", required: true },
    { key: "print_sides", label: "印刷面数", type: "single_choice", required: true, options: [{ label: "单面", value: "single_sided" }, { label: "双面", value: "double_sided" }] },
    { key: "customer_notes", label: "顾客特殊要求", type: "long_text", required: false },
  ] });
  function pillowDraft() {
    return OrderWorkDraftSchema.parse({ ...draft(), fields: [
      { key: "crop_scope", label: "裁切范围", kind: "text", value: "Only Face" },
      { key: "print_sides", label: "印刷面数", kind: "choice", value: "double_sided" },
    ], images: [{ origin: "report", key: "display-2", usage: "buyer_photo" }] });
  }
  it("treats standard pillow controls as production parameters without printing them", async () => {
    const source: ProductionEditorDocument = { ...document(), productType: "shaped_pillow", spec: { widthMm: 375, heightMm: 375, dpi: 150, declaredLongestMm: 304.8, sideMode: "single", sizeBasis: "finished", whiteBorderMm: 33.8667, cutLineMm: 1.016, minimumNeckMm: 50, minimumNeckBasis: "finished", panelGapMm: 16.9333, sheetMarginMm: 8.4667, barcodeTab: { widthMm: 84.6667, heightMm: 30.48, centerXMm: 187.5 } } };
    const input = pillowDraft();
    const result = await composeOrderArtwork(source, [], pillowCustomization, input, [{ usage: "buyer_photo", id: "private-photo", version: 1, width: 1000, height: 1500 }], true);
    expect(result.productType === "shaped_pillow" && result.spec.sideMode).toBe("double");
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0]).toMatchObject({ kind: "image", assetId: "private-photo", heightMm: 304.8 });
    expect(result.layers[0]?.kind === "image" && result.layers[0].widthMm).toBeCloseTo(203.2);
    expect(result.confirmations.visualReview).toBe(false);
    expect(result.confirmations.physicalSize).toBe(false);
    expect(source.layers).toHaveLength(0);
    expect(input.fields[0]?.value).toBe("Only Face");
  });
  it("does not extend photo-only pillow execution to other products or unsupported instructions", () => {
    expect(() => assertAutomaticArtwork(pillowCustomization, [], pillowDraft(), "tire_cover", true)).toThrow();
    expect(() => assertAutomaticArtwork(pillowCustomization, [], pillowDraft(), "shaped_pillow")).toThrow();
    expect(isPhotoOnlyPillowArtwork({mode:"customer_image",assetId:null,materials:[{role:"reference"}]})).toBe(true);
    expect(isPhotoOnlyPillowArtwork({mode:"mixed",assetId:null,materials:[]})).toBe(false);
    expect(isPhotoOnlyPillowArtwork({mode:"customer_image",assetId:"fixed-master",materials:[]})).toBe(false);
    expect(isPhotoOnlyPillowArtwork({mode:"customer_image",assetId:null,materials:[{role:"background"}]})).toBe(false);
    for (const key of ["crop_scope", "print_sides", "customer_notes", "unexpected"]) {
      const input = pillowDraft();
      input.fields = [...input.fields.filter((f) => f.key !== key), { key, label: key, kind: "text", value: "Unsupported request" }];
      expect(() => assertAutomaticArtwork(pillowCustomization, [], input, "shaped_pillow", true)).toThrow();
    }
    const ambiguous = pillowDraft();
    ambiguous.fields.push({ ...ambiguous.fields[0]! });
    expect(() => assertAutomaticArtwork(pillowCustomization, [], ambiguous, "shaped_pillow", true)).toThrow("不唯一");
  });
  it.each(["Half Body", "half_body", "half-body", "半身", "上半身"])("recognizes explicit half-body controls without silently promoting them to whole body: %s", crop => {
    const input = pillowDraft(); input.fields[0]!.value = crop;
    expect(orderPillowPhotoPlan("shaped_pillow", pillowCustomization, [], input)).toEqual({ subject: "half_body", sideMode: "double" });
    expect(input.fields[0]!.value).toBe(crop);
  });
  it("leaves mixed or free-form half-body requests for review", () => {
    for (const crop of ["Half Body or Whole Body", "half", "Half Body, add missing legs"]) {
      const input = pillowDraft(); input.fields[0]!.value = crop;
      expect(() => orderPillowPhotoPlan("shaped_pillow", pillowCustomization, [], input)).toThrow("无法唯一识别");
    }
  });
  it("preserves leading and trailing buyer characters and rejects free-form instructions", async () => {
    const input = draft(); input.fields[0]!.value = "  Alice  ";
    const output = await composeOrderArtwork(document(), layout, customization, input, [{ usage: "photo", id: "private-image", version: 1, width: 400, height: 200 }]);
    expect(output.layers.find((l) => l.id === "custom_name")).toMatchObject({ text: "  Alice  " });
    input.instructions = "Remove the background";
    expect(() => assertAutomaticArtwork(customization, layout, input)).toThrow("美工");
  });
  it("places the exact buyer text and fits the mapped photo without stretching or approving", async () => {
    const source = document();
    const result = await composeOrderArtwork(source, layout, customization, draft(), [
      { usage: "photo", id: "private-image", version: 1, width: 400, height: 200 },
    ]);
    expect(result.layers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "custom_name", kind: "text", text: "Alice" }),
        expect.objectContaining({
          id: "custom_photo",
          kind: "image",
          assetId: "private-image",
          xMm: 10,
          yMm: 20,
          widthMm: 80,
          heightMm: 40,
        }),
      ]),
    );
    expect(result.confirmations.visualReview).toBe(false);
    expect(source.layers).toHaveLength(0);
    expect(result.layers.find((l) => l.id === "custom_name")!.xMm).toBeGreaterThan(10);
  });
  it("requires explicit image usage and rejects ambiguous mapping", () => {
    const input = draft();
    input.images[0]!.usage = "unmatched";
    expect(() => assertAutomaticArtwork(customization, layout, input)).toThrow("未绑定印花字段");
    input.images.push({ ...input.images[0]!, key: "second", usage: "photo" });
    input.images[0]!.usage = "照片";
    expect(() => assertAutomaticArtwork(customization, layout, input)).toThrow("不唯一");
  });
  it("fails explicitly for missing regions, multiline text, requested fonts and rule-driven fields", () => {
    expect(() => assertAutomaticArtwork(customization, [], draft())).toThrow(ConflictException);
    expect(() => assertAutomaticArtwork(customization, [], draft())).toThrow("区域");
    for (const change of [{ value: "Alice\nBob" }, { font: "Custom font" }, { color: "Red" }]) {
      const input = draft();
      Object.assign(input.fields[0]!, change);
      expect(() => assertAutomaticArtwork(customization, layout, input)).toThrow();
    }
    const conditional = structuredClone(customization);
    conditional.fields[0]!.visibleWhen = { fieldKey: "photo", operator: "not_empty" };
    expect(() => assertAutomaticArtwork(conditional, layout, draft())).toThrow("美工");
  });
});
