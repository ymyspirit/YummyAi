import JSZip from "jszip";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { AMAZON_CUSTOM_PARSER_REVISION, parseAmazonCustomArchive } from "./amazon-custom-archive.js";

const expected = { externalOrderId: "SYNTHETIC-ORDER", externalLineId: "SYNTHETIC-LINE" };
const image = () => sharp({ create: { width: 20, height: 10, channels: 3, background: "red" } }).jpeg().toBuffer();
const source = () => ({
  orderId: expected.externalOrderId, orderItemId: expected.externalLineId,
  customizationData: { type: "ProductCustomization", children: [{
    type: "PageContainerCustomization", name: "front", label: "Front", snapshot: { imageName: "preview.jpg" },
    children: [
      { type: "TextContainerCustomization", fontSelection: { name: "Synthetic Font" }, colorSelection: { value: "#123456" }, children: [{ type: "TextCustomization", label: "Engraving", inputValue: "Synthetic & text\nSecond line" }] },
      { type: "OptionCustomization", label: "Size", optionSelection: { name: "Large" } },
      { type: "OptionCustomization", label: "Material", optionSelection: "Cotton" },
      { type: "ImageCustomization", label: "Buyer upload", image: { imageName: "buyer.jpg", buyerFilename: "synthetic-photo.jpg" }, buyerPlacement: { position: { x: 1, y: 2 }, dimension: { width: 12, height: 8 }, scale: { scaleX: 1, scaleY: 1 }, angleOfRotation: 10 } },
    ],
  }] },
  "version3.0": { customizationInfo: { surfaces: [{ name: "Duplicate Legacy", areas: [{ text: "Do not repeat me" }] }] } },
});
async function archive(data: unknown = source(), extras: Record<string, string | Buffer> = {}) {
  const zip = new JSZip();
  zip.file("order.json", JSON.stringify(data));
  zip.file("preview.jpg", await image());
  zip.file("buyer.jpg", await image());
  zip.file("layout.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>untrusted()</script></svg>');
  for (const [name, body] of Object.entries(extras)) zip.file(name, body);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
function centralHeaders(bytes: Buffer): number[] {
  const result: number[] = [];
  for (let index = 0; index < bytes.length - 4; index++) if (bytes.readUInt32LE(index) === 0x02014b50) result.push(index);
  return result;
}

describe("Amazon Custom archive parser", () => {
  it("maps font and color choice nodes and shares their appearance with sibling text without fetching fonts", async () => {
    const data = {
      orderId: expected.externalOrderId, orderItemId: expected.externalLineId,
      customizationData: { type: "PageContainerCustomization", snapshot: { imageName: "preview.jpg" }, children: [{
        type: "TextContainerCustomization", label: "Personalized message", children: [
          { type: "TextCustomization", inputValue: "Synthetic message" },
          { type: "FontCustomization", label: "Font", fontSelection: { family: "Synthetic Script", fontUrl: "https://example.test/unfetched-font.woff" } },
          { type: "ColorCustomization", label: "Color", colorSelection: { colorModel: "RGB", name: "Synthetic Blue", value: "#1234ab" } },
        ],
      }] },
    };
    const result = await parseAmazonCustomArchive(await archive(data), expected);
    expect(AMAZON_CUSTOM_PARSER_REVISION).toBe(2);
    expect(result.document.surfaces[0].fields).toEqual([
      expect.objectContaining({ kind: "text", label: "Personalized message", value: "Synthetic message", font: "Synthetic Script", color: "#1234ab" }),
      expect.objectContaining({ kind: "choice", label: "Font", value: "Synthetic Script", font: "Synthetic Script" }),
      expect.objectContaining({ kind: "choice", label: "Color", value: "Synthetic Blue", color: "#1234ab" }),
    ]);
    expect(result.document.warnings).toEqual([]);
    expect(result.files.some((file) => /\.woff/.test(file.name))).toBe(false);
  });

  it("keeps a font choice without a family name unresolved instead of fetching its URL", async () => {
    const data = { orderId: expected.externalOrderId, orderItemId: expected.externalLineId, customizationData: {
      type: "PageContainerCustomization", snapshot: { imageName: "preview.jpg" }, children: [{ type: "FontCustomization", fontSelection: { fontUrl: "https://example.test/unfetched.woff" } }],
    } };
    const result = await parseAmazonCustomArchive(await archive(data), expected);
    expect(result.document.surfaces[0].fields[0].kind).toBe("unknown");
    expect(result.document.warnings).toContain("部分字体或颜色选择缺少可展示的值，请核对原始数据");
  });

  it("shows an empty known image field without inventing an upload or assuming it was required", async () => {
    const data = { orderId: expected.externalOrderId, orderItemId: expected.externalLineId, customizationData: {
      type: "PageContainerCustomization", snapshot: { imageName: "preview.jpg" }, children: [{ type: "ImageCustomization", label: "Optional image" }],
    } };
    const result = await parseAmazonCustomArchive(await archive(data), expected);
    expect(result.document.surfaces[0].fields[0]).toMatchObject({ kind: "image", label: "Optional image", value: "未提供图片" });
    expect(result.document.surfaces[0].buyerFileKeys).toEqual([]);
    expect(result.document.surfaces[0].previewFileKey).not.toBeNull();
    expect(result.document.warnings).toEqual(["该图片字段未提供上传文件，请核对是否需要图片"]);
  });

  it("extracts nested customization once, inherits text appearance, and uses explicit image references", async () => {
    const result = await parseAmazonCustomArchive(await archive(), expected);
    expect(result.document.surfaces).toHaveLength(1);
    const front = result.document.surfaces[0];
    expect(front.fields).toHaveLength(4);
    expect(front.fields[0]).toMatchObject({ label: "Engraving", value: "Synthetic & text\nSecond line", font: "Synthetic Font", color: "#123456" });
    expect(front.fields[1]).toMatchObject({ kind: "choice", value: "Large" });
    expect(front.fields[2]).toMatchObject({ kind: "choice", value: "Cotton" });
    expect(front.fields[3]).toMatchObject({ kind: "image", value: "synthetic-photo.jpg" });
    expect(front.previewFileKey).toBeTruthy();
    expect(front.buyerFileKeys).toHaveLength(1);
    expect(front.previewFileKey).not.toBe(front.buyerFileKeys[0]);
    const safeImages = result.files.filter((file) => file.role !== "source");
    expect(safeImages).toHaveLength(2);
    for (const file of safeImages) {
      expect(file.mediaType).toBe("image/png");
      expect(file).toMatchObject({ width: 20, height: 10 });
      expect(result.files.find((original) => original.key === file.originalFileKey)).toMatchObject({ role: "source", mediaType: "image/jpeg" });
      expect((await sharp(file.body).metadata()).format).toBe("png");
    }
    expect(result.files.find((file) => file.name === "layout.svg")?.role).toBe("source");
    expect(result.document.raw).toEqual(source());
    expect(result.document.warnings).toEqual([]);
  });

  it("keeps previews distinct across multiple pages", async () => {
    const data = source();
    data.customizationData.children.push({ ...data.customizationData.children[0], label: "Back", snapshot: { imageName: "back.jpg" } });
    const result = await parseAmazonCustomArchive(await archive(data, { "back.jpg": await image() }), expected);
    expect(result.document.surfaces).toHaveLength(2);
    expect(result.document.surfaces[0].previewFileKey).not.toBe(result.document.surfaces[1].previewFileKey);
  });

  it("parses legacy-only JSON without fabricating a preview", async () => {
    const result = await parseAmazonCustomArchive(await archive({ orderId: expected.externalOrderId, orderItemId: expected.externalLineId, "version3.0": { customizationInfo: { surfaces: [{ name: "Front", areas: [{ name: "Text", text: "Synthetic legacy", fontFamily: "Sans", color: "blue" }, { name: "Upload", imageName: "buyer.jpg" }] }] } } }), expected);
    expect(result.document.surfaces[0].fields[0]).toMatchObject({ kind: "text", value: "Synthetic legacy", font: "Sans", color: "blue" });
    expect(result.document.surfaces[0].previewFileKey).toBeNull();
    expect(result.document.surfaces[0].buyerFileKeys).toHaveLength(1);
    expect(result.document.warnings).toContain("部分定制面没有可展示的亚马逊预览");
  });

  it("uses XML when no JSON is present and preserves identifier strings", async () => {
    const zip = new JSZip();
    zip.file("order.xml", '<Order><orderId>SYNTHETIC-ORDER</orderId><orderItemId>SYNTHETIC-LINE</orderItemId><customizationData><type>PageContainerCustomization</type><label>Front</label><children><type>TextCustomization</type><label>Text</label><inputValue>000123</inputValue></children></customizationData></Order>');
    const result = await parseAmazonCustomArchive(await zip.generateAsync({ type: "nodebuffer" }), expected);
    expect(result.document.schemaVersion).toBe("amazon-custom-xml:tree");
    expect(result.document.surfaces[0].fields[0].value).toBe("000123");
  });

  it("decodes predefined and numeric XML entities once without enabling document entities", async () => {
    const zip = new JSZip();
    zip.file("order.xml", '<Order><orderId>SYNTHETIC-ORDER</orderId><orderItemId>SYNTHETIC-LINE</orderItemId><customizationData><type>PageContainerCustomization</type><children><type>TextCustomization</type><inputValue>A &amp; B &lt; C &#x1F496; &amp;amp;</inputValue></children></customizationData></Order>');
    const result = await parseAmazonCustomArchive(await zip.generateAsync({ type: "nodebuffer" }), expected);
    expect(result.document.surfaces[0].fields[0].value).toBe("A & B < C 💖 &amp;");
  });

  it("rejects XML DTDs and entity declarations before parsing", async () => {
    const zip = new JSZip();
    zip.file("order.xml", '<!DOCTYPE Order [<!ENTITY secret SYSTEM "file:///private">]><Order><orderId>&secret;</orderId></Order>');
    await expect(parseAmazonCustomArchive(await zip.generateAsync({ type: "nodebuffer" }), expected)).rejects.toThrow("实体声明");
  });

  it.each([
    { orderId: "WRONG-PRIVATE-ORDER" }, { orderItemId: "WRONG-PRIVATE-LINE" }, { orderItemId: "" },
  ])("requires exact order and line identities without leaking them: %j", async (change) => {
    await expect(parseAmazonCustomArchive(await archive({ ...source(), ...change }), expected)).rejects.toThrow(/定制 ZIP：(订单号或订单行编号与当前订单不匹配|缺少可核对的订单号或订单行编号)$/);
  });

  it("retains unsupported fields and reports missing images without failing useful fields", async () => {
    const data = source();
    const front = data.customizationData.children[0];
    front.snapshot.imageName = "missing.jpg";
    front.children.push({ type: "FutureCustomization", label: "New field" } as typeof front.children[number]);
    const result = await parseAmazonCustomArchive(await archive(data, { "buyer.jpg": Buffer.from("invalid image") }), expected);
    expect(result.document.surfaces[0].fields.some((field) => field.kind === "unknown")).toBe(true);
    expect(result.document.warnings).toContain("缺少定制预览图片");
    expect(result.document.warnings).toContain("图片损坏、尺寸超限或无法生成安全预览");
  });

  it("never renders SVG or fetches a remotely referenced preview", async () => {
    const data = source();
    data.customizationData.children[0].snapshot.imageName = "layout.svg";
    const svg = await parseAmazonCustomArchive(await archive(data), expected);
    expect(svg.document.surfaces[0].previewFileKey).toBeNull();
    expect(svg.document.warnings).toContain("SVG 仅保留为原始文件，未作为安全预览展示");
    data.customizationData.children[0].snapshot.imageName = "https://example.test/private.jpg";
    const remote = await parseAmazonCustomArchive(await archive(data), expected);
    expect(remote.document.surfaces[0].previewFileKey).toBeNull();
    expect(remote.document.warnings).toContain("定制内容引用外部资源，未自动下载");
  });

  it.each(["../escape.txt", "folder/../../escape.txt", "C:/escape.txt", "folder\\escape.txt"])("rejects unsafe raw ZIP path %s before sanitization", async (name) => {
    await expect(parseAmazonCustomArchive(await archive(source(), { [name]: "unsafe" }), expected)).rejects.toThrow("不安全的文件路径");
  });

  it("rejects case-ambiguous entries and nested archives", async () => {
    await expect(parseAmazonCustomArchive(await archive(source(), { "BUYER.JPG": "ambiguous" }), expected)).rejects.toThrow("重名或大小写");
    await expect(parseAmazonCustomArchive(await archive(source(), { "nested.zip": "nested" }), expected)).rejects.toThrow("嵌套");
  });

  it("rejects encrypted entries, CRC corruption, and mismatched local names", async () => {
    const encrypted = await archive();
    const header = centralHeaders(encrypted)[0], local = encrypted.readUInt32LE(header + 42);
    encrypted.writeUInt16LE(encrypted.readUInt16LE(header + 8) | 1, header + 8);
    encrypted.writeUInt16LE(encrypted.readUInt16LE(local + 6) | 1, local + 6);
    await expect(parseAmazonCustomArchive(encrypted, expected)).rejects.toThrow("加密");
    const corrupted = await archive();
    const central = centralHeaders(corrupted)[0], localHeader = corrupted.readUInt32LE(central + 42);
    corrupted.writeUInt32LE(123, central + 16); corrupted.writeUInt32LE(123, localHeader + 14);
    await expect(parseAmazonCustomArchive(corrupted, expected)).rejects.toThrow("校验值");
    const mismatch = await archive();
    mismatch[mismatch.readUInt32LE(centralHeaders(mismatch)[0] + 42) + 30] = 120;
    await expect(parseAmazonCustomArchive(mismatch, expected)).rejects.toThrow("文件头与目录不一致");
  });

  it("enforces size limits from headers and while inflating understated content", async () => {
    await expect(parseAmazonCustomArchive(new Uint8Array(20 * 1024 * 1024 + 1), expected)).rejects.toThrow("20 MiB");
    const oversized = await archive();
    oversized.writeUInt32LE(20 * 1024 * 1024 + 1, centralHeaders(oversized)[0] + 24);
    await expect(parseAmazonCustomArchive(oversized, expected)).rejects.toThrow("单个文件");
    const bomb = await archive(source(), { "padding.txt": "0".repeat(100_000) });
    const header = centralHeaders(bomb).find((offset) => bomb.subarray(offset + 46, offset + 46 + bomb.readUInt16LE(offset + 28)).toString() === "padding.txt")!;
    bomb.writeUInt32LE(10, header + 24); bomb.writeUInt32LE(10, bomb.readUInt32LE(header + 42) + 22);
    await expect(parseAmazonCustomArchive(bomb, expected)).rejects.toThrow("解压大小超限");
  });

  it("rejects excess entry count and malformed archives", async () => {
    const zip = new JSZip();
    for (let index = 0; index < 201; index++) zip.file(`file-${index}.txt`, "");
    await expect(parseAmazonCustomArchive(await zip.generateAsync({ type: "nodebuffer" }), expected)).rejects.toThrow("文件数量");
    await expect(parseAmazonCustomArchive(Buffer.from("not a zip"), expected)).rejects.toThrow("完整的 ZIP");
  });

  it("rejects multiple JSON sources and missing identities", async () => {
    await expect(parseAmazonCustomArchive(await archive(source(), { "second.json": "{}" }), expected)).rejects.toThrow("多个定制数据");
    await expect(parseAmazonCustomArchive(await archive({ customizationData: {} }), expected)).rejects.toThrow("缺少可核对");
  });
});
