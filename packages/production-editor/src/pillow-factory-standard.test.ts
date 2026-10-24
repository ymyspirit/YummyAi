import { SHAPED_PILLOW_FACTORY_STANDARD, type ShapedPillowDocument } from "@yummyai/contracts/pod/production-editor";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { getProductionLayout } from "./geometry.js";
import { applyPillowFactoryStandard, createDefaultProductionDocument, productionExportDefaults } from "./products.js";
import { preflightProductionDocument, renderProductionDocument } from "./renderer.js";

const mm = (px: number) => px * 25.4 / 150;
const assetId = "019f7600-0000-7000-8000-000000000001";
const options = { format: "jpeg", background: "white", purpose: "production" } as const;
function document(): ShapedPillowDocument {
  const value = createDefaultProductionDocument("shaped_pillow") as ShapedPillowDocument;
  return { ...value, spec: { ...value.spec, widthMm: mm(1900), heightMm: mm(1900), declaredLongestMm: 254,
    sizeBasis: "artwork", minimumNeckBasis: "finished", barcodeTab: { ...value.spec.barcodeTab, centerXMm: mm(950) } },
    contour: [{ xMm: 0, yMm: 0, smooth: false }, { xMm: mm(1900), yMm: 0, smooth: false }, { xMm: mm(1900), yMm: mm(1900), smooth: false }, { xMm: 0, yMm: mm(1900), smooth: false }],
    layers: [{ id: "photo", name: "Synthetic", kind: "image", assetId, assetVersion: 1, widthMm: 254, heightMm: 254,
      xMm: mm(200), yMm: mm(200), rotationDeg: 0, flipX: false, flipY: false, opacity: 1, visible: true, locked: false }],
    confirmations: { physicalSize: true, whiteBorderRule: true, narrowParts: true, barcodeTab: true, backText: true, visualReview: true } };
}
const resolvers = { resolveAsset: async () => ({ bytes: await sharp({ create: { width: 1500, height: 1500, channels: 3, background: "#406080" } }).png().toBuffer() }), resolveFont: async () => { throw new Error("No fonts in fixture"); } };

describe("PS tutorial pillow factory standard", () => {
  it("keeps independently bound front/back prints in a complete checked JPG",async()=>{
    const value=document();value.spec.sideMode="double";const front=value.layers[0]!;if(front.kind!=="image")throw new Error("Missing fixture image");
    value.layers=[{...front,surface:"front"},{...front,id:"back-photo",name:"Independent back",assetId:createEntityId(),surface:"back"}];
    const output=await renderProductionDocument(value,options,{resolveAsset:async(id)=>({bytes:await sharp({create:{width:1500,height:1500,channels:3,background:id===front.assetId?"#cc1111":"#1111cc"}}).png().toBuffer()}),resolveFont:resolvers.resolveFont});
    const meta=await sharp(output.bytes).metadata();expect(meta).toMatchObject({format:"jpeg",width:4012,height:2206,density:150,space:"srgb",channels:3});expect(meta.icc?.length).toBeGreaterThan(0);expect(output.preflight.productionReady).toBe(true);
    const layout=getProductionLayout(value),scale=150/25.4,y=Math.round((layout.marginMm+value.spec.heightMm/2)*scale);
    const sample=async(x:number)=>sharp(output.bytes).extract({left:Math.round(x*scale),top:y,width:1,height:1}).raw().toBuffer();
    const a=await sample(layout.marginMm+value.spec.widthMm/2),b=await sample(layout.backOffsetMm+layout.marginMm+value.spec.widthMm/2);
    expect(a[0]!>a[2]!+100).toBe(true);expect(b[2]!>b[0]!+100).toBe(true);
  });
  it("exports actual JPG bytes with verified 150 DPI, RGB, ICC and white sheet margins", async () => {
    const value = document();
    const result = await renderProductionDocument(value, options, resolvers);
    const info = await sharp(result.bytes).metadata();
    expect(result.mediaType).toBe("image/jpeg");
    expect([...result.bytes.subarray(0, 3)]).toEqual([255, 216, 255]);
    expect(info).toMatchObject({ format: "jpeg", width: 4012, height: 2206, density: 150, space: "srgb", channels: 3, hasAlpha: false });
    expect(info.icc?.length).toBeGreaterThan(0);
    const corner = await sharp(result.bytes).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    expect([...corner]).toEqual([255, 255, 255]);
    expect(getProductionLayout(value)).toMatchObject({ widthPx: info.width, heightPx: info.height });
    expect(result.preflight.productionReady).toBe(true);
  });

  it("refuses PNG, TIFF and transparent factory delivery while retaining PNG internal previews", async () => {
    for (const format of ["png", "tiff"] as const) {
      const check = await preflightProductionDocument(document(), { ...options, format }, resolvers);
      expect(check.issues).toContainEqual(expect.objectContaining({ code: "factory_jpg_required", severity: "error" }));
    }
    const check = await preflightProductionDocument(document(), { ...options, background: "transparent" }, resolvers);
    expect(check.issues).toContainEqual(expect.objectContaining({ code: "factory_white_background" }));
    const preview = await renderProductionDocument(document(), { ...options, purpose: "preview", format: "png" }, resolvers);
    expect((await sharp(preview.bytes).metadata()).format).toBe("png");
  });

  it.each([
    ["barcode", "factory_barcode_dimensions"], ["gap", "factory_sheet_spacing"],
    ["margin", "factory_sheet_spacing"], ["border", "factory_white_border"], ["size", "factory_size_basis"],
  ])("blocks a factory draft with mismatched %s", async (field, code) => {
    const value = document();
    if (field === "barcode") value.spec.barcodeTab = { ...value.spec.barcodeTab, widthMm: mm(500), heightMm: mm(180) };
    if (field === "gap") value.spec.panelGapMm = mm(99);
    if (field === "margin") value.spec.sheetMarginMm = mm(49);
    if (field === "border") value.spec.whiteBorderMm = mm(199);
    if (field === "size") value.spec.sizeBasis = "finished";
    expect((await preflightProductionDocument(value, options, resolvers)).issues).toContainEqual(expect.objectContaining({ code, severity: "error" }));
  });

  it("applies the new standard explicitly without editing images, contours or the source version", () => {
    const old = document();
    delete old.spec.factoryStandardId;
    old.spec.barcodeTab.widthMm = mm(500);
    old.spec.barcodeTab.heightMm = mm(180);
    const original = structuredClone(old);
    const next = applyPillowFactoryStandard(old);
    expect(old).toEqual(original);
    expect(next.layers).toEqual(original.layers);
    expect(next.contour).toEqual(original.contour);
    expect(next.spec).toMatchObject({ factoryStandardId: SHAPED_PILLOW_FACTORY_STANDARD.id, barcodeTab: { widthMm: mm(600), heightMm: mm(200) } });
    expect(Object.values(next.confirmations).every(value => !value)).toBe(true);
    expect(productionExportDefaults(next)).toEqual({ format: "jpeg", background: "white" });
    expect(productionExportDefaults(createDefaultProductionDocument("tire_cover"))).toEqual({ format: "png", background: "transparent" });
  });
});
