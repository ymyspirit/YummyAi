import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AssistOrderFieldBindingSchema, type AssistOrderFieldBinding } from "@yummyai/contracts/ai/assist";
import { OrderWorkDraftSchema, type OrderWorkDetail } from "@yummyai/contracts/order/workspace";
import { OrderRequirementSourceSchema } from "@yummyai/contracts/order/requirement-interpretation";
import { adoptOrderFieldBindings } from "./assist-adoption";
import { sameAssistInput } from "./assist-client";

const id = (n: number) => `019f0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const evidenceId = (key: string) => "order-field:" + createHash("sha256").update(JSON.stringify(key)).digest("hex");
function fixture() {
  const source = (sourceFieldKey: string, groupKey: string, value: string) => OrderRequirementSourceSchema.parse({
    sourceFieldKey, groupKey, value, surfaceKey: "front", origin: "amazon_raw", jsonPointer: "/synthetic/" + sourceFieldKey,
    role: "text", label: "Custom your text", requestedFont: null, colorLabel: null, colorHex: null, targetTextKey: sourceFieldKey,
  });
  const alpha = source("raw-a", "group-a", "Synthetic Alpha"), beta = source("raw-b", "group-b", "Synthetic Beta");
  const font = OrderRequirementSourceSchema.parse({ ...alpha, sourceFieldKey: "font-a", role: "font", value: "Original Font",
    requestedFont: "Original Font", targetTextKey: alpha.sourceFieldKey });
  const color = OrderRequirementSourceSchema.parse({ ...alpha, sourceFieldKey: "color-a", role: "color", value: "CustomColor",
    colorLabel: "CustomColor", colorHex: null, targetTextKey: alpha.sourceFieldKey });
  const sources = [alpha, beta, font, color];
  const draft = OrderWorkDraftSchema.parse({ artworkVersionId: id(2), specificationVersionId: id(3), printProfileVersionId: id(4),
    designExecutor: "agent", fields: [alpha, beta, font, color].map(row => ({ key: row.sourceFieldKey, label: row.label,
      kind: row.role === "text" ? "text" : "choice", value: row.value })),
    images: [{ origin: "report", key: "original-image", usage: "buyer_photo" }], instructions: "Keep original synthetic notes",
    customerApprovalRequired: false, dueAt: null });
  const detail = { catalog: { artworks: [{ id: id(2), customization: { version: 1, fields: [
    { key: "front_message", label: "Front", type: "short_text" }, { key: "back_message", label: "Back", type: "short_text" },
  ] } }] } } as unknown as OrderWorkDetail;
  const binding = (sourceFieldKey: string, targetFieldKey: string | null, role: AssistOrderFieldBinding["role"] = "text") =>
    AssistOrderFieldBindingSchema.parse({ sourceFieldKey, targetFieldKey, role, confidence: 0.95, reason: "Synthetic original source classification",
      evidence: [{ sourceId: evidenceId(sourceFieldKey), detail: "Same immutable source row" }] });
  return { draft, detail, sources, binding, evidence: sources.map(row => evidenceId(row.sourceFieldKey)), alpha, beta };
}

describe("evidence-bound order field adoption", () => {
  it("classifies original text rows without generating buyer values, fonts, colors, executor, images or manufacturing pins", async () => {
    const f = fixture(), before = structuredClone(f.draft);
    const result = await adoptOrderFieldBindings(f.draft, f.detail, [f.binding("raw-a", "front_message"),
      f.binding("raw-b", "back_message"), f.binding("font-a", "front_message", "font"),
      f.binding("color-a", "front_message", "color")], f.sources, f.evidence);
    expect(result.applied).toBe(2);
    expect(result.unresolved).toEqual([]);
    expect(result.draft.fields[0]).toEqual({ ...before.fields[0], key: "front_message", label: "Front", sourceKey: "raw-a" });
    expect(result.draft.fields[1]).toEqual({ ...before.fields[1], key: "back_message", label: "Back", sourceKey: "raw-b" });
    expect(result.draft.fields.slice(2)).toEqual(before.fields.slice(2));
    expect(result.draft.fields.every(row => row.styleOverride === undefined)).toBe(true);
    expect({ ...result.draft, fields: before.fields }).toEqual(before);
    expect(f.draft).toEqual(before);
  });

  it("rejects a cross-group font or color suggestion rather than printing the selector or inventing a style override", async () => {
    const f = fixture(), before = structuredClone(f.draft);
    for (const role of ["font", "color"] as const) await expect(adoptOrderFieldBindings(f.draft, f.detail,
      [f.binding("raw-a", "front_message"), f.binding("raw-b", "back_message"),
        f.binding(role + "-a", "back_message", role)], f.sources, f.evidence)).rejects.toThrow("不能跨文字组");
    expect(f.draft).toEqual(before);
  });

  it("requires the actual current source evidence and refuses foreign, missing, duplicate or ambiguous targets atomically", async () => {
    const f = fixture(), before = structuredClone(f.draft), valid = f.binding("raw-a", "front_message");
    for (const bindings of [
      [{ ...valid, sourceFieldKey: "another-order-source" }],
      [{ ...valid, evidence: [{ sourceId: evidenceId("raw-b"), detail: "Wrong source" }] }],
      [valid, valid],
      [valid, f.binding("raw-b", "front_message")],
      [{ ...valid, targetFieldKey: "another-artwork-field" }],
    ]) await expect(adoptOrderFieldBindings(f.draft, f.detail, bindings, f.sources, f.evidence)).rejects.toThrow();
    await expect(adoptOrderFieldBindings(f.draft, f.detail, [valid], f.sources, [])).rejects.toThrow("原字段依据");
    expect(f.draft).toEqual(before);
  });

  it("retains the complete text and operator style below 0.85 confidence while still rejecting invalid source evidence", async () => {
    const f = fixture();
    const draft = OrderWorkDraftSchema.parse({ ...f.draft, fields: f.draft.fields.map((row, index) => index ? row : { ...row,
      font: "Synthetic Operator Font", color: "#2468ac",
      styleOverride: { source: "operator", font: "Synthetic Operator Font", colorHex: "#2468ac" },
    }) });
    const before = structuredClone(draft), low = { ...f.binding("raw-a", "front_message"), confidence: 0.849 };
    const result = await adoptOrderFieldBindings(draft, f.detail, [low], f.sources, f.evidence);
    expect(result.applied).toBe(0);
    expect(result.draft).toEqual(before);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]).toContain(f.alpha.label);
    expect(result.unresolved[0]).toContain("核对");
    for (const invalid of [
      { ...low, sourceFieldKey: "another-order-source" },
      { ...low, evidence: [{ sourceId: evidenceId("raw-b"), detail: "Another source cannot explain this suggestion" }] },
    ]) await expect(adoptOrderFieldBindings(draft, f.detail, [invalid], f.sources, f.evidence)).rejects.toThrow("原字段依据");
    const boundary = await adoptOrderFieldBindings(draft, f.detail, [{ ...low, confidence: 0.85 }], f.sources, f.evidence);
    expect(boundary.applied).toBe(1);
    expect(boundary.draft.fields[0]).toEqual({ ...before.fields[0], key: "front_message", label: "Front", sourceKey: "raw-a" });
    expect(boundary.draft.fields.slice(1)).toEqual(before.fields.slice(1));
    expect(draft).toEqual(before);
  });

  it("retains an unresolved source and existing target instead of overwriting a newer operator input", async () => {
    const f = fixture();
    const current = { ...f.draft, fields: [...f.draft.fields, { key: "front_message", label: "Front", kind: "text" as const,
      value: "Synthetic newer operator text" }] };
    const result = await adoptOrderFieldBindings(current, f.detail, [f.binding("raw-a", "front_message"),
      f.binding("raw-b", null)], f.sources, f.evidence);
    expect(result.applied).toBe(0);
    expect(result.unresolved).toHaveLength(2);
    expect(result.draft).toEqual(current);
  });

  it("adopts a dirty operator field only from its current checked sources while keeping the new original value", async () => {
    const f = fixture(), operator = OrderRequirementSourceSchema.parse({ ...f.alpha, sourceFieldKey: "new-operator",
      groupKey: "operator:new-operator", origin: "operator", value: "Synthetic newly typed original text", targetTextKey: null });
    const current = { ...f.draft, fields: [...f.draft.fields, { key: operator.sourceFieldKey, kind: "text" as const,
      label: "Synthetic newly typed text", value: operator.value }] };
    const binding = f.binding(operator.sourceFieldKey, "front_message");
    await expect(adoptOrderFieldBindings(current, f.detail, [binding], f.sources,
      [...f.evidence, evidenceId(operator.sourceFieldKey)])).rejects.toThrow("原字段依据");
    const result = await adoptOrderFieldBindings(current, f.detail, [binding], [...f.sources, operator],
      [...f.evidence, evidenceId(operator.sourceFieldKey)]);
    expect(result.applied).toBe(1);
    expect(result.draft.fields.at(-1)).toMatchObject({ key: "front_message", sourceKey: operator.sourceFieldKey, value: operator.value });
    expect(result.draft.fields.slice(0, -1)).toEqual(current.fields.slice(0, -1));
    expect(current.fields.at(-1)!.key).toBe(operator.sourceFieldKey);
  });

  it("marks analysis for an older dirty draft stale after any text or style edit while preserving the immutable source identity", () => {
    const f = fixture();
    const input = { kind: "order_review" as const, orderLineId: id(1), expectedRevision: 2, expectedSourceVersionId: id(5), draft: f.draft };
    const request = { ...input, modelId: id(6), requestId: id(7) };
    expect(sameAssistInput(request, input)).toBe(true);
    for (const patch of [
      { ...f.draft, instructions: "Changed synthetic instruction" },
      { ...f.draft, fields: f.draft.fields.map((row, index) => index ? row : { ...row, value: "Changed synthetic text" }) },
      { ...f.draft, fields: f.draft.fields.map((row, index) => index ? row : { ...row,
        styleOverride: { source: "operator" as const, colorHex: "#123456" } }) },
    ]) expect(sameAssistInput(request, { ...input, draft: patch })).toBe(false);
    expect(AssistOrderFieldBindingSchema.safeParse({ ...f.binding("raw-a", "front_message"), value: "Invented text" }).success).toBe(false);
    expect(AssistOrderFieldBindingSchema.safeParse({ ...f.binding("raw-a", "front_message"),
      styleOverride: { source: "operator", colorHex: "#000000" } }).success).toBe(false);
  });
});
