import { describe, expect, it } from "vitest";

import {
  inspectPersonalizationTemplateSource,
  TemplateSourceParseError,
} from "./personalization-template-source-parser.js";

describe("personalization template source parser", () => {
  it("reads PNG canvas, physical resolution, alpha, and proposes a reviewable image slot", () => {
    const parsed = inspectPersonalizationTemplateSource(pngFixture(1200, 800, 300), "png");

    expect(parsed.canvas).toEqual({
      width: 1200,
      height: 800,
      dpi: 300,
      colorMode: "rgb",
      background: "transparent",
    });
    expect(parsed.slots).toMatchObject([{
      stableKey: "customer.image",
      kind: "image",
      replaceable: true,
      confidencePermille: 500,
    }]);
    expect(parsed.warnings.map((warning) => warning.code)).toContain("PNG_LAYER_SEMANTICS_UNAVAILABLE");
  });

  it("reads PSD layer records, Unicode names, and the four-group section divider convention", () => {
    const parsed = inspectPersonalizationTemplateSource(psdFixture(), "psd");

    expect(parsed.canvas).toEqual({ width: 3000, height: 2000, dpi: 300, colorMode: "rgb" });
    expect(parsed.slots).toHaveLength(1);
    expect(parsed.slots[0]).toMatchObject({
      name: "顾客照片",
      kind: "image",
      psdGroup: "image",
      sourceLayerPath: ["image", "顾客照片"],
      geometry: { x: 100, y: 200, width: 1400, height: 1600 },
      replaceable: true,
      confidencePermille: 950,
    });
  });

  it("rejects truncated or falsely labelled PSD input with a stable parser code", () => {
    expect(() => inspectPersonalizationTemplateSource(new Uint8Array([0, 1, 2, 3]), "psd"))
      .toThrowError(TemplateSourceParseError);
    try {
      inspectPersonalizationTemplateSource(new Uint8Array([0, 1, 2, 3]), "psd");
    } catch (error) {
      expect(error).toMatchObject({ code: "PSD_SIGNATURE_INVALID" });
    }
  });
});

function pngFixture(width: number, height: number, dpi: number) {
  const writer = new Writer();
  writer.bytes([137, 80, 78, 71, 13, 10, 26, 10]);
  writer.u32(13).ascii("IHDR").u32(width).u32(height).u8(8).u8(6).u8(0).u8(0).u8(0).u32(0);
  const pixelsPerMeter = Math.round(dpi / 0.0254);
  writer.u32(9).ascii("pHYs").u32(pixelsPerMeter).u32(pixelsPerMeter).u8(1).u32(0);
  writer.u32(0).ascii("IEND").u32(0);
  return writer.build();
}

function psdFixture() {
  const resources = new Writer()
    .ascii("8BIM").u16(1005).u8(0).u8(0)
    .u32(16).u32(300 * 65_536).u32(0).u32(0).u32(0)
    .build();
  const records = new Writer()
    .bytes(layerRecord({ name: "image", sectionType: 1, top: 0, left: 0, bottom: 2000, right: 3000 }))
    .bytes(layerRecord({ name: "顾客照片", top: 200, left: 100, bottom: 1800, right: 1500 }))
    .bytes(layerRecord({ name: "group-end", sectionType: 3, top: 0, left: 0, bottom: 0, right: 0 }))
    .build();
  const layerInfo = new Writer().i16(3).bytes(records).build();
  const layerMask = new Writer().u32(layerInfo.byteLength).bytes(layerInfo).build();
  return new Writer()
    .ascii("8BPS").u16(1).zeros(6).u16(4).u32(2000).u32(3000).u16(8).u16(3)
    .u32(0)
    .u32(resources.byteLength).bytes(resources)
    .u32(layerMask.byteLength).bytes(layerMask)
    .build();
}

function layerRecord(input: {
  name: string;
  sectionType?: number;
  top: number;
  left: number;
  bottom: number;
  right: number;
}) {
  const extra = new Writer().u32(0).u32(0);
  const latinName = Array.from(input.name).every((character) => character.charCodeAt(0) <= 127) ? input.name : "layer";
  extra.u8(latinName.length).ascii(latinName).pad(4);
  const unicode = new Writer().u32(input.name.length);
  for (const character of input.name) unicode.u16(character.charCodeAt(0));
  const unicodeBytes = unicode.build();
  extra.ascii("8BIM").ascii("luni").u32(unicodeBytes.byteLength).bytes(unicodeBytes).pad(2);
  if (input.sectionType !== undefined) {
    extra.ascii("8BIM").ascii("lsct").u32(4).u32(input.sectionType);
  }
  const extraBytes = extra.build();
  return new Writer()
    .i32(input.top).i32(input.left).i32(input.bottom).i32(input.right)
    .u16(0).ascii("8BIM").ascii("norm").u8(255).u8(0).u8(0).u8(0)
    .u32(extraBytes.byteLength).bytes(extraBytes)
    .build();
}

class Writer {
  private values: number[] = [];

  u8(value: number) { this.values.push(value & 0xff); return this; }
  u16(value: number) { this.values.push((value >>> 8) & 0xff, value & 0xff); return this; }
  i16(value: number) { return this.u16(value & 0xffff); }
  u32(value: number) { this.values.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff); return this; }
  i32(value: number) { return this.u32(value >>> 0); }
  ascii(value: string) { for (const character of value) this.u8(character.charCodeAt(0)); return this; }
  bytes(value: Uint8Array | number[]) { this.values.push(...value); return this; }
  zeros(count: number) { this.values.push(...Array.from({ length: count }, () => 0)); return this; }
  pad(alignment: number) { while (this.values.length % alignment) this.values.push(0); return this; }
  build() { return Uint8Array.from(this.values); }
}
