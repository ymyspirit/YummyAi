import { createHash } from "node:crypto";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  OrderRequirementInterpretationSchema, OrderRequirementSourceSchema, orderRequirementDraftInput,
  type OrderRequirementBasis, type OrderRequirementSource,
} from "@yummyai/contracts/order/requirement-interpretation";
import { OrderWorkDraftSchema, type OrderWorkDraft } from "@yummyai/contracts/order/workspace";
import { parseAmazonCustomArchive, type AmazonCustomDocument } from "./amazon-custom-archive.js";
import { extractAmazonRequirementSources, interpretOrderRequirements } from "./order-requirements.js";

type Node = Record<string, unknown>;
const id = (value: number) => `019f0000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const font = (family: string): Node => ({ type: "FontCustomization", label: "Font", fontSelection: { family } });
const color = (name: string, hex?: string): Node => ({ type: "ColorCustomization", label: "Font Color",
  colorSelection: { colorModel: "RGB", name, ...(hex ? { value: hex } : {}) } });
const text = (value: string): Node => ({ type: "TextCustomization", label: "Custom your text", inputValue: value });
const group = (label: string, children: Node[]): Node => ({ type: "TextContainerCustomization", label, children });
const option = (label: string, value: string): Node => ({ type: "OptionCustomization", label, optionSelection: { name: value } });

async function parsed(children: Node[]) {
  const raw = { orderId: "SYNTHETIC-REQUIREMENTS", orderItemId: "SYNTHETIC-LINE",
    customizationData: { type: "PageContainerCustomization", label: "Front", children } };
  const zip = new JSZip();
  zip.file("order.json", JSON.stringify(raw));
  const result = await parseAmazonCustomArchive(await zip.generateAsync({ type: "nodebuffer" }), {
    externalOrderId: raw.orderId, externalLineId: raw.orderItemId,
  });
  expect(result.document.raw).toEqual(raw);
  return result.document;
}
function draftFor(document: AmazonCustomDocument): OrderWorkDraft {
  return OrderWorkDraftSchema.parse({ artworkVersionId: id(10), specificationVersionId: id(11),
    printProfileVersionId: id(12), designExecutor: "agent",
    fields: document.surfaces.flatMap(surface => surface.fields), images: [], instructions: "",
    customerApprovalRequired: false, dueAt: null });
}
function basisFor(draft: OrderWorkDraft): OrderRequirementBasis {
  return { orderLineId: id(1), revision: 1, projectionVersion: 2,
    sourceVersionId: id(2), draftChecksum: createHash("sha256").update(orderRequirementDraftInput(draft)).digest("hex"),
    artworkVersionId: id(10), specificationVersionId: id(11), printProfileVersionId: id(12), templateVersionId: id(13) };
}
function project(document: AmazonCustomDocument) {
  const draft = draftFor(document), beforeDocument = structuredClone(document), beforeDraft = structuredClone(draft);
  const sources = extractAmazonRequirementSources(document), beforeSources = structuredClone(sources);
  const basis = basisFor(draft);
  const result = interpretOrderRequirements({ basis, sources, draft });
  const interpretation = OrderRequirementInterpretationSchema.parse(result.interpretation);
  expect(interpretation.basis).toEqual(basis);
  expect(interpretation.sources).toEqual(sources);
  expect(interpretation.coverage.map(row => row.sourceFieldKey).sort())
    .toEqual(sources.map(row => row.sourceFieldKey).sort());
  expect(new Set(interpretation.coverage.map(row => row.sourceFieldKey)).size).toBe(sources.length);
  for (const source of sources) {
    OrderRequirementSourceSchema.parse(source);
    if (source.origin === "amazon_raw") expect(pointer(document.raw, source.jsonPointer)).not.toBeUndefined();
  }
  expect(document).toEqual(beforeDocument);
  expect(draft).toEqual(beforeDraft);
  expect(sources).toEqual(beforeSources);
  return { ...result, interpretation, sources };
}
function pointer(raw: unknown, value: string): unknown {
  if (!value) return raw;
  expect(value.startsWith("/")).toBe(true);
  return value.slice(1).split("/").map(part => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((node, key) => node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined, raw);
}
function onlySource(sources: OrderRequirementSource[], role: OrderRequirementSource["role"], value?: string) {
  const found = sources.filter(source => source.role === role && (value === undefined || source.value === value));
  expect(found).toHaveLength(1);
  return found[0]!;
}

describe("Amazon requirement projection from immutable raw groups", () => {
  it("keeps canonical operator crop, side, image and notes controls out of printable text while retaining real custom text", async () => {
    const document = await parsed([]), sources = extractAmazonRequirementSources(document);
    const draft = OrderWorkDraftSchema.parse({ ...draftFor(document), fields: [
      { key: "crop_scope", label: "裁切范围", kind: "text", value: "Only Face" },
      { key: "print_sides", label: "印刷面数", kind: "text", value: "double_sided" },
      { key: "buyer_photo", label: "顾客原图", kind: "image", value: "synthetic-original.png" },
      { key: "customer_notes", label: "顾客特殊要求", kind: "text", value: "Keep the synthetic ears" },
      { key: "operator.message", label: "Synthetic operator message", kind: "text", value: "Synthetic Alpha" },
    ] });
    const before = structuredClone(draft), sourceBefore = structuredClone(sources), basis = basisFor(draft);
    const result = interpretOrderRequirements({ basis, sources, draft });
    expect(result.interpretation.basis).toEqual(basis);
    for (const [key, role] of [["crop_scope", "crop"], ["print_sides", "side"],
      ["buyer_photo", "image"], ["customer_notes", "notes"], ["operator.message", "text"]] as const) {
      expect(result.interpretation.sources.find(source => source.sourceFieldKey === key))
        .toMatchObject({ sourceFieldKey: key, origin: "operator", role,
          value: before.fields.find(field => field.key === key)!.value });
    }
    expect(result.interpretation.texts).toEqual([{ sourceFieldKey: "operator.message", groupKey: "operator:operator.message",
      originalText: "Synthetic Alpha", needsPrinting: true,
      font: { requested: null, sourceFieldKey: null }, color: { label: null, hex: null, sourceFieldKey: null } }]);
    expect(result.interpretation.notes).toEqual([{ sourceFieldKey: "customer_notes", original: "Keep the synthetic ears" }]);
    expect(result.interpretation.options).toEqual([
      { sourceFieldKey: "crop_scope", role: "crop", label: "裁切范围", value: "Only Face" },
      { sourceFieldKey: "print_sides", role: "side", label: "印刷面数", value: "double_sided" },
    ]);
    expect(result.interpretation.coverage.map(row => row.sourceFieldKey).sort()).toEqual(before.fields.map(field => field.key).sort());
    expect(result.normalizedDraft.fields).toEqual(before.fields.map(field => ({ ...field, sourceKey: field.key })));
    expect(draft).toEqual(before);
    expect(sources).toEqual(sourceBefore);
  });

  it("binds a nonempty message only to the font and actual hex in its real TextContainer group", async () => {
    const result = project(await parsed([group("Message A", [text("Synthetic Alpha"),
      font("Synthetic Script"), color("CustomColor", "#12ab34")])]));
    const message = onlySource(result.sources, "text", "Synthetic Alpha");
    const requestedFont = onlySource(result.sources, "font"), requestedColor = onlySource(result.sources, "color");
    expect(requestedFont.groupKey).toBe(message.groupKey);
    expect(requestedColor.groupKey).toBe(message.groupKey);
    expect(requestedFont.targetTextKey).toBe(message.sourceFieldKey);
    expect(requestedColor.targetTextKey).toBe(message.sourceFieldKey);
    expect(requestedFont.requestedFont).toBe("Synthetic Script");
    expect(requestedColor).toMatchObject({ colorLabel: "CustomColor", colorHex: "#12ab34" });
    expect(result.interpretation.texts).toEqual([expect.objectContaining({ sourceFieldKey: message.sourceFieldKey,
      originalText: "Synthetic Alpha", needsPrinting: true,
      font: { requested: "Synthetic Script", sourceFieldKey: requestedFont.sourceFieldKey },
      color: { label: "CustomColor", hex: "#12ab34", sourceFieldKey: requestedColor.sourceFieldKey } })]);
    expect(result.sources.filter(source => source.origin === "amazon_raw")).toHaveLength(3);
  });

  it("keeps an empty message non-printing even when real font and black selector metadata exist", async () => {
    const result = project(await parsed([group("Empty message", [text(""), font("Luckiest Guy"), color("CustomColor", "#000000")])]));
    expect(result.interpretation.texts).toHaveLength(1);
    expect(result.interpretation.texts[0]).toMatchObject({ originalText: "", needsPrinting: false });
    expect(result.interpretation.texts.filter(message => message.needsPrinting)).toEqual([]);
    expect(result.sources.filter(source => source.role === "text").map(source => source.value)).toEqual([""]);
    expect(onlySource(result.sources, "font").value).toBe("Luckiest Guy");
    expect(onlySource(result.sources, "color").colorHex).toBe("#000000");
    expect(result.sources).toHaveLength(3);
  });

  it("never shares font or color between two text groups that reuse the same labels", async () => {
    const result = project(await parsed([
      group("Message A", [text("Synthetic Alpha"), font("Synthetic Serif"), color("First color", "#123456")]),
      group("Message B", [text("Synthetic Beta"), font("Synthetic Script"), color("Second color", "#abcdef")]),
    ]));
    const alpha = onlySource(result.sources, "text", "Synthetic Alpha"), beta = onlySource(result.sources, "text", "Synthetic Beta");
    expect(alpha.groupKey).not.toBe(beta.groupKey);
    for (const [source, family, hex] of [[alpha, "Synthetic Serif", "#123456"], [beta, "Synthetic Script", "#abcdef"]] as const) {
      const message = result.interpretation.texts.find(value => value.sourceFieldKey === source.sourceFieldKey)!;
      expect(message.font.requested).toBe(family);
      expect(message.color.hex).toBe(hex);
      for (const ref of [message.font.sourceFieldKey, message.color.sourceFieldKey]) {
        const style = result.sources.find(value => value.sourceFieldKey === ref)!;
        expect(style.groupKey).toBe(source.groupKey);
        expect(style.targetTextKey).toBe(source.sourceFieldKey);
      }
    }
    expect(result.sources).toHaveLength(6);
  });

  it("does not spread page-level style onto an unstyled group, an image, or auxiliary production options", async () => {
    const result = project(await parsed([font("Page-level metadata"), color("Page-level color", "#010203"),
      group("Unstyled message", [text("Synthetic independent message")]),
      option("Size", "10 inch-Mini Keepsake"), option("Style", "Double-Sided Print — Same Photo on Back"),
      option("HD Enhancement", "Yes"), { type: "ImageCustomization", label: "Upload One Clear Photo" }]));
    const message = result.interpretation.texts.find(value => value.originalText === "Synthetic independent message")!;
    expect(message.font).toEqual({ requested: null, sourceFieldKey: null });
    expect(message.color).toEqual({ label: null, hex: null, sourceFieldKey: null });
    for (const [label, role] of [["Size", "size"], ["Style", "side"], ["HD Enhancement", "enhancement"], ["Upload One Clear Photo", "image"]] as const) {
      const source = result.sources.find(value => value.label === label)!;
      expect(source).toBeDefined();
      expect(source.role).toBe(role);
      expect(source.targetTextKey).toBeNull();
      expect(source.requestedFont).toBeNull();
      expect(source.colorHex).toBeNull();
      expect(result.interpretation.coverage.find(value => value.sourceFieldKey === source.sourceFieldKey)).toBeDefined();
    }
    expect(result.sources).toHaveLength(7);
  });

  it("preserves an unresolved CustomColor label without inventing a black actual color for a nonempty message", async () => {
    const result = project(await parsed([group("Unknown actual color", [text("Synthetic colored message"),
      font("Synthetic Font"), color("CustomColor")])]));
    const requestedColor = onlySource(result.sources, "color");
    expect(requestedColor.colorLabel).toBe("CustomColor");
    expect(requestedColor.colorHex).toBeNull();
    const message = result.interpretation.texts[0]!;
    expect(message.originalText).toBe("Synthetic colored message");
    expect(message.color.hex).toBeNull();
    expect(result.interpretation.unresolved.some(issue => issue.sourceFieldKeys.includes(requestedColor.sourceFieldKey))).toBe(true);
    expect(result.sources.every(source => source.colorHex !== "#000000")).toBe(true);
  });

  it("retains legacy values but never guesses which text owns a sibling style without the raw group", () => {
    const document: AmazonCustomDocument = { schemaVersion: "synthetic-legacy-without-group", warnings: [], raw: {},
      surfaces: [{ key: "legacy-front", label: "Front", previewFileKey: null, buyerFileKeys: [], fields: [
        { key: "legacy-a", label: "Custom your text", kind: "text", value: "Synthetic Alpha" },
        { key: "legacy-style", label: "Font", kind: "choice", value: "Synthetic unknown owner", font: "Synthetic unknown owner", color: "#000000" },
        { key: "legacy-b", label: "Custom your text", kind: "text", value: "Synthetic Beta" },
      ] }] };
    const result = project(document);
    expect(result.sources).toHaveLength(3);
    expect(result.sources.every(source => source.origin === "legacy_unresolved")).toBe(true);
    expect(result.sources.map(source => source.value).sort()).toEqual(["Synthetic Alpha", "Synthetic Beta", "Synthetic unknown owner"].sort());
    for (const message of result.interpretation.texts) {
      expect(message.font).toEqual({ requested: null, sourceFieldKey: null });
      expect(message.color).toEqual({ label: null, hex: null, sourceFieldKey: null });
    }
    expect(result.interpretation.texts.map(message => message.originalText).sort()).toEqual(["Synthetic Alpha", "Synthetic Beta"]);
    expect(result.interpretation.unresolved.length).toBeGreaterThan(0);
  });

  it("prefers the actual font family for sibling, own inline, and scoped container selections without styling a nested group", async () => {
    const document = await parsed([
      group("Sibling font", [text("Synthetic sibling message"), { type: "FontCustomization", label: "Font",
        fontSelection: { family: "Synthetic Actual Family", name: "Synthetic display label" } }]),
      group("Own inline font", [{ ...text("Synthetic inline message"),
        fontSelection: { family: "Synthetic Inline Family", name: "Synthetic inline display label" } }]),
      { ...group("Container inline style", [text("Synthetic container message"),
        group("Nested unstyled message", [text("Synthetic nested message")])]),
      fontSelection: { family: "Synthetic Container Family", name: "Synthetic container display label" },
      colorSelection: { name: "CustomColor", value: "#345678" } },
    ]);
    const result = project(document);
    const sibling = result.interpretation.texts.find(value => value.originalText === "Synthetic sibling message")!;
    expect(sibling.font.requested).toBe("Synthetic Actual Family");
    expect(result.sources.find(value => value.sourceFieldKey === sibling.font.sourceFieldKey)?.role).toBe("font");
    const inline = result.interpretation.texts.find(value => value.originalText === "Synthetic inline message")!;
    expect(inline.font).toEqual({ requested: "Synthetic Inline Family", sourceFieldKey: inline.sourceFieldKey });
    expect(result.sources.find(value => value.sourceFieldKey === inline.sourceFieldKey)?.requestedFont).toBe("Synthetic Inline Family");
    const container = result.interpretation.texts.find(value => value.originalText === "Synthetic container message")!;
    expect(container.font).toEqual({ requested: "Synthetic Container Family", sourceFieldKey: container.sourceFieldKey });
    expect(container.color).toEqual({ label: "CustomColor", hex: "#345678", sourceFieldKey: container.sourceFieldKey });
    const containerSource = result.sources.find(value => value.sourceFieldKey === container.sourceFieldKey)!;
    expect(containerSource.fontJsonPointer).toBe("/customizationData/children/2/fontSelection");
    expect(containerSource.colorJsonPointer).toBe("/customizationData/children/2/colorSelection");
    expect(pointer(document.raw, containerSource.fontJsonPointer!))
      .toEqual({ family: "Synthetic Container Family", name: "Synthetic container display label" });
    expect(pointer(document.raw, containerSource.colorJsonPointer!)).toEqual({ name: "CustomColor", value: "#345678" });
    const nested = result.interpretation.texts.find(value => value.originalText === "Synthetic nested message")!;
    expect(nested.groupKey).not.toBe(container.groupKey);
    expect(nested.font).toEqual({ requested: null, sourceFieldKey: null });
    expect(nested.color).toEqual({ label: null, hex: null, sourceFieldKey: null });
    expect(result.interpretation.texts.every(value => !value.font.requested?.includes("display label"))).toBe(true);
  });

  it("applies an explicit operator styleOverride to its one original text while preserving the other group and raw styles", async () => {
    const document = await parsed([
      group("Message A", [text("Synthetic Alpha"), font("Synthetic Serif"), color("First color", "#123456")]),
      group("Message B", [text("Synthetic Beta"), font("Synthetic Script"), color("Second color", "#abcdef")]),
    ]);
    const original = structuredClone(document), sources = extractAmazonRequirementSources(document), beforeSources = structuredClone(sources);
    const alpha = onlySource(sources, "text", "Synthetic Alpha"), beta = onlySource(sources, "text", "Synthetic Beta");
    const baselineDraft = draftFor(document);
    const baseline = interpretOrderRequirements({ basis: basisFor(baselineDraft), sources, draft: baselineDraft });
    const draft = structuredClone(baselineDraft);
    draft.fields.find(value => value.key === alpha.sourceFieldKey)!.styleOverride = {
      source: "operator", font: "Synthetic Operator Font", colorHex: "#2468ac",
    };
    const beforeDraft = structuredClone(draft);
    const result = interpretOrderRequirements({ basis: basisFor(draft), sources, draft });
    OrderRequirementInterpretationSchema.parse(result.interpretation);
    const interpretedAlpha = result.interpretation.texts.find(value => value.sourceFieldKey === alpha.sourceFieldKey)!;
    expect(interpretedAlpha).toMatchObject({ originalText: "Synthetic Alpha", groupKey: alpha.groupKey,
      font: { requested: "Synthetic Operator Font", sourceFieldKey: alpha.sourceFieldKey },
      color: { label: "#2468ac", hex: "#2468ac", sourceFieldKey: alpha.sourceFieldKey } });
    expect(result.interpretation.sources.find(value => value.sourceFieldKey === alpha.sourceFieldKey)).toMatchObject({
      origin: "operator", requestedFont: "Synthetic Operator Font", colorHex: "#2468ac", groupKey: alpha.groupKey,
    });
    expect(result.interpretation.texts.find(value => value.sourceFieldKey === beta.sourceFieldKey))
      .toEqual(baseline.interpretation.texts.find(value => value.sourceFieldKey === beta.sourceFieldKey));
    expect(result.normalizedDraft.fields.find(value => value.sourceKey === alpha.sourceFieldKey)).toMatchObject({
      value: "Synthetic Alpha", font: "Synthetic Operator Font", color: "#2468ac", styleOverride: beforeDraft.fields.find(value => value.key === alpha.sourceFieldKey)!.styleOverride,
    });
    for (const source of beforeSources.filter(value => value.role === "font" || value.role === "color"))
      expect(result.interpretation.sources.find(value => value.sourceFieldKey === source.sourceFieldKey)).toEqual(source);
    expect(OrderWorkDraftSchema.safeParse({ ...draft, fields: draft.fields.map(value => value.key === alpha.sourceFieldKey
      ? { ...value, styleOverride: { ...value.styleOverride, source: "model" } } : value) }).success).toBe(false);
    expect(document).toEqual(original);
    expect(sources).toEqual(beforeSources);
    expect(draft).toEqual(beforeDraft);
  });

  it("keeps a canonical key and sourceKey anchored to the same original text group through repeated interpretation", async () => {
    const document = await parsed([
      group("Message A", [text("Synthetic Alpha"), font("Synthetic Serif"), color("First color", "#123456")]),
      group("Message B", [text("Synthetic Beta"), font("Synthetic Script"), color("Second color", "#abcdef")]),
    ]);
    const sources = extractAmazonRequirementSources(document), originalSources = structuredClone(sources);
    const alpha = onlySource(sources, "text", "Synthetic Alpha"), beta = onlySource(sources, "text", "Synthetic Beta");
    const draft = draftFor(document);
    draft.fields = draft.fields.map(field => field.key === alpha.sourceFieldKey
      ? { ...field, key: "front_message", label: "Front message", sourceKey: alpha.sourceFieldKey } : field);
    const beforeDraft = structuredClone(draft);
    const fields = [{ key: "front_message", label: "Front message", type: "short_text", required: true,
      status: "mapped" as const, sourceKeys: ["front_message"], imageCount: 0 }];
    const result = interpretOrderRequirements({ basis: basisFor(draft), sources, draft, fields });
    const message = result.interpretation.texts.find(value => value.sourceFieldKey === alpha.sourceFieldKey)!;
    expect(message).toMatchObject({ originalText: "Synthetic Alpha", groupKey: alpha.groupKey,
      font: { requested: "Synthetic Serif" }, color: { hex: "#123456" } });
    expect(result.interpretation.sources).toEqual(originalSources);
    expect(result.interpretation.sources).toHaveLength(6);
    expect(result.interpretation.coverage.find(value => value.sourceFieldKey === alpha.sourceFieldKey))
      .toMatchObject({ status: "matched", targetFieldKey: "front_message" });
    expect(result.normalizedDraft.fields.find(value => value.key === "front_message"))
      .toMatchObject({ sourceKey: alpha.sourceFieldKey, value: "Synthetic Alpha", font: "Synthetic Serif", color: "#123456" });
    const repeated = interpretOrderRequirements({ basis: basisFor(result.normalizedDraft), sources,
      draft: result.normalizedDraft, fields });
    expect(repeated.interpretation.texts).toEqual(result.interpretation.texts);
    expect(repeated.interpretation.sources).toEqual(originalSources);
    expect(repeated.interpretation.texts.find(value => value.sourceFieldKey === beta.sourceFieldKey)?.groupKey).toBe(beta.groupKey);
    expect(repeated.normalizedDraft).toEqual(result.normalizedDraft);
    expect(draft).toEqual(beforeDraft);
  });

  it("requires resolution of conflicting real inline and sibling styles only when that group's original text is nonempty", async () => {
    for (const originalText of ["Synthetic conflicting text", ""]) {
      const result = project(await parsed([{ ...group("Real conflicting styles", [text(originalText),
        font("Synthetic Child Font"), color("Child color", "#445566")]),
      fontSelection: { family: "Synthetic Container Font" }, colorSelection: { name: "Container color", value: "#112233" } }]));
      const message = result.interpretation.texts[0]!;
      expect(message).toMatchObject({ originalText, needsPrinting: !!originalText,
        font: { requested: "Synthetic Container Font" }, color: { hex: "#112233" } });
      const codes = result.interpretation.unresolved.map(row => row.code);
      if (originalText) {
        expect(codes).toEqual(expect.arrayContaining(["font_group_conflict", "color_group_conflict"]));
        for (const issue of result.interpretation.unresolved) expect(issue.sourceFieldKeys).toContain(message.sourceFieldKey);
      } else {
        expect(codes).not.toContain("font_group_conflict"); expect(codes).not.toContain("color_group_conflict");
      }
      expect(onlySource(result.sources, "font").requestedFont).toBe("Synthetic Child Font");
      expect(onlySource(result.sources, "color").colorHex).toBe("#445566");
    }
  });
});
