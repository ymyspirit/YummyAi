import { describe, expect, it } from "vitest";
import {
  OrderRequirementBasisSchema, OrderRequirementInterpretationSchema, OrderRequirementSourceSchema,
  type OrderRequirementInterpretation, type OrderRequirementSource,
} from "./requirement-interpretation.js";

const id = (value: number) => `019f0000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const basis = () => ({ orderLineId: id(1), revision: 2, projectionVersion: 3, sourceVersionId: id(2),
  draftChecksum: "a".repeat(64), artworkVersionId: id(3), specificationVersionId: id(4),
  printProfileVersionId: id(5), templateVersionId: id(6) });
const source = (sourceFieldKey: string, role: OrderRequirementSource["role"], value: string,
  extra: Partial<OrderRequirementSource> = {}): OrderRequirementSource => ({
  sourceFieldKey, surfaceKey: "front", groupKey: "message-a", origin: "amazon_raw",
  jsonPointer: `/customizationData/children/${sourceFieldKey}`, role, label: sourceFieldKey, value,
  requestedFont: null, colorLabel: null, colorHex: null, targetTextKey: null, ...extra,
});
function interpretation(): OrderRequirementInterpretation {
  const sources = [source("text-a", "text", "Synthetic original message"),
    source("font-a", "font", "Synthetic Font", { requestedFont: "Synthetic Font", targetTextKey: "text-a" }),
    source("color-a", "color", "CustomColor", { colorLabel: "CustomColor", colorHex: "#1234ab", targetTextKey: "text-a" }),
    source("size", "size", "10 inch-Mini Keepsake", { groupKey: "product-options", label: "Size" })];
  return { version: "order-requirements-v1", basis: basis(), instructions: "", sources,
    texts: [{ sourceFieldKey: "text-a", groupKey: "message-a", originalText: "Synthetic original message", needsPrinting: true,
      font: { requested: "Synthetic Font", sourceFieldKey: "font-a" },
      color: { label: "CustomColor", hex: "#1234ab", sourceFieldKey: "color-a" } }],
    notes: [], options: [{ sourceFieldKey: "size", role: "size", label: "Size", value: "10 inch-Mini Keepsake" }],
    coverage: sources.map(row => ({ sourceFieldKey: row.sourceFieldKey, status: "retained",
      targetFieldKey: null, reason: "Synthetic original evidence retained" })), unresolved: [] };
}

describe("immutable order requirement interpretation", () => {
  it("accepts evidence-bound text and the exact source/version/manufacturing basis without adding approval", () => {
    const value = interpretation();
    expect(OrderRequirementInterpretationSchema.parse(value)).toEqual(value);
    expect(OrderRequirementInterpretationSchema.safeParse({ ...value, approved: true }).success).toBe(false);
    expect(OrderRequirementSourceSchema.safeParse({ ...value.sources[0], modelApproved: true }).success).toBe(false);
    expect(OrderRequirementBasisSchema.safeParse({ ...basis(), revision: -1 }).success).toBe(false);
    expect(OrderRequirementBasisSchema.safeParse({ ...basis(), draftChecksum: "not-a-checksum" }).success).toBe(false);
  });

  it.each(["missing", "duplicate", "foreign"] as const)("rejects %s coverage instead of silently dropping or relabeling a raw field", kind => {
    const value = interpretation();
    if (kind === "missing") value.coverage.pop();
    if (kind === "duplicate") value.coverage[1] = { ...value.coverage[0]! };
    if (kind === "foreign") value.coverage[0]!.sourceFieldKey = "another-order-field";
    expect(OrderRequirementInterpretationSchema.safeParse(value).success).toBe(false);
  });

  it("keeps empty original text non-printing and rejects a model rewrite of the original words", () => {
    const empty = interpretation();
    empty.sources[0]!.value = " \n ";
    empty.texts[0]!.originalText = " \n ";
    empty.texts[0]!.needsPrinting = false;
    expect(OrderRequirementInterpretationSchema.safeParse(empty).success).toBe(true);
    empty.texts[0]!.needsPrinting = true;
    expect(OrderRequirementInterpretationSchema.safeParse(empty).success).toBe(false);
    const rewritten = interpretation();
    rewritten.texts[0]!.originalText = "Synthetic model rewritten message";
    expect(OrderRequirementInterpretationSchema.safeParse(rewritten).success).toBe(false);
  });

  it.each(["font", "color"] as const)("rejects %s from another text group even when a real style source exists", role => {
    const value = interpretation(), style = value.sources.find(row => row.role === role)!;
    style.groupKey = "message-b";
    expect(OrderRequirementInterpretationSchema.safeParse(value).success).toBe(false);
    style.groupKey = "message-a";
    style.targetTextKey = "text-b";
    expect(OrderRequirementInterpretationSchema.safeParse(value).success).toBe(false);
  });

  it("retains unknown CustomColor as null and rejects fabricated black or a font absent from its referenced source", () => {
    const unknown = interpretation();
    unknown.sources.find(row => row.role === "color")!.colorHex = null;
    unknown.texts[0]!.color.hex = null;
    expect(OrderRequirementInterpretationSchema.safeParse(unknown).success).toBe(true);
    unknown.texts[0]!.color.hex = "#000000";
    expect(OrderRequirementInterpretationSchema.safeParse(unknown).success).toBe(false);
    const font = interpretation();
    font.texts[0]!.font.requested = "Synthetic invented font";
    expect(OrderRequirementInterpretationSchema.safeParse(font).success).toBe(false);
  });

  it("allows a text node's own explicit inline style while refusing a nonexistent source reference", () => {
    const value = interpretation(), text = value.sources[0]!;
    text.requestedFont = "Synthetic Inline Font";
    text.colorLabel = "Synthetic Blue";
    text.colorHex = "#abcdef";
    value.texts[0]!.font = { requested: text.requestedFont, sourceFieldKey: text.sourceFieldKey };
    value.texts[0]!.color = { label: text.colorLabel, hex: text.colorHex, sourceFieldKey: text.sourceFieldKey };
    expect(OrderRequirementInterpretationSchema.safeParse(value).success).toBe(true);
    value.texts[0]!.font.sourceFieldKey = "not-in-this-original-source";
    expect(OrderRequirementInterpretationSchema.safeParse(value).success).toBe(false);
  });

  it("rejects rewritten notes or options while retaining their exact original values and roles", () => {
    const value = interpretation();
    value.sources.push(source("notes", "notes", "Synthetic preserve the original ears"));
    value.coverage.push({ sourceFieldKey: "notes", status: "retained", targetFieldKey: null, reason: "Keep original note" });
    value.notes.push({ sourceFieldKey: "notes", original: "Synthetic preserve the original ears" });
    expect(OrderRequirementInterpretationSchema.safeParse(value).success).toBe(true);
    const rewrittenNote = structuredClone(value); rewrittenNote.notes[0]!.original = "Synthetic discard the ears";
    expect(OrderRequirementInterpretationSchema.safeParse(rewrittenNote).success).toBe(false);
    for (const patch of [{ value: "24 inch" }, { label: "Model rewritten size" }, { role: "text" as const }]) {
      const changed = structuredClone(value); changed.options[0] = { ...changed.options[0]!, ...patch };
      expect(OrderRequirementInterpretationSchema.safeParse(changed).success).toBe(false);
    }
  });

  it("rejects duplicate interpreted texts, notes and options or unresolved references to another source", () => {
    const value = interpretation();
    for (const changed of [
      { ...value, texts: [...value.texts, value.texts[0]!] },
      { ...value, options: [...value.options, value.options[0]!] },
      { ...value, unresolved: [{ code: "unknown", sourceFieldKeys: ["another-order-field"], message: "Unrelated source" }] },
    ]) expect(OrderRequirementInterpretationSchema.safeParse(changed).success).toBe(false);
    value.sources.push(source("notes", "notes", "Synthetic original note"));
    value.coverage.push({ sourceFieldKey: "notes", status: "retained", targetFieldKey: null, reason: "Keep original note" });
    value.notes = [{ sourceFieldKey: "notes", original: "Synthetic original note" }, { sourceFieldKey: "notes", original: "Synthetic original note" }];
    expect(OrderRequirementInterpretationSchema.safeParse(value).success).toBe(false);
  });
});
