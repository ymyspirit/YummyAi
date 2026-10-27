import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OrderWorkDraftSchema, type OrderWorkDetail } from "@yummyai/contracts/order/workspace";
import { OrderRequirementSourceSchema, orderRequirementDraftInput, type OrderRequirementInterpretation } from "@yummyai/contracts/order/requirement-interpretation";
import { orderRequirementContextCurrent, orderRequirementField, orderRequirementTextGroups,
  orderRequirementAdoptionSources, orderRequirementWithStyle, orderRequirementWithText } from "./order-requirements-model";
import { orderIntakeSnapshot } from "./order-work-input-model";
import { orderReviewLineState, type OrderReviewCheckState } from "./order-review-model";

const id = (n: number) => `019f0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
  const source = (key: string, groupKey: string, value: string) => OrderRequirementSourceSchema.parse({
    sourceFieldKey: key, groupKey, value, surfaceKey: "front", origin: "amazon_raw", jsonPointer: "/synthetic/" + key,
    role: "text", label: "Custom your text", requestedFont: null, colorLabel: null, colorHex: null, targetTextKey: key,
  });
  const alpha = source("raw-a", "group-a", "Synthetic Alpha"), beta = source("raw-b", "group-b", "");
  const sources = [alpha, beta, OrderRequirementSourceSchema.parse({ ...alpha, sourceFieldKey: "font-a", role: "font",
    value: "Synthetic Family", requestedFont: "Synthetic Family", targetTextKey: alpha.sourceFieldKey }),
  OrderRequirementSourceSchema.parse({ ...alpha, sourceFieldKey: "color-a", role: "color",
    value: "CustomColor", colorLabel: "CustomColor", targetTextKey: alpha.sourceFieldKey }),
  OrderRequirementSourceSchema.parse({ ...beta, sourceFieldKey: "color-b", role: "color",
    value: "Black", colorLabel: "Black", colorHex: "#000000", targetTextKey: beta.sourceFieldKey })];
  const draft = OrderWorkDraftSchema.parse({ artworkVersionId: id(2), specificationVersionId: id(3), printProfileVersionId: id(4),
    designExecutor: "agent", fields: [
      { key: "front_message", sourceKey: alpha.sourceFieldKey, label: "Front", kind: "text", value: alpha.value },
      { key: "back_message", sourceKey: beta.sourceFieldKey, label: "Back", kind: "text", value: beta.value },
    ], images: [{ key: "synthetic-original", origin: "report", usage: "buyer_photo" }],
    instructions: "Keep the original synthetic requirements", customerApprovalRequired: false, dueAt: null });
  return { alpha, beta, sources, draft };
}

describe("source-backed order requirement editing", () => {
  it("shows only actual same-group styles and keeps an empty message nonprinting without inventing a CustomColor value", () => {
    const f = fixture(), groups = orderRequirementTextGroups(f.sources, f.draft);
    expect(groups[0]).toMatchObject({ text: "Synthetic Alpha", needsPrinting: true, font: "Synthetic Family",
      colorLabel: "CustomColor", colorHex: null });
    expect(groups[1]).toMatchObject({ text: "", needsPrinting: false, font: null });
    expect(groups[0]!.colorHex).not.toBe("#000000");
  });

  it("changes one source-backed canonical text without changing another group, originals, image or pinned basis", () => {
    const f = fixture(), original = structuredClone(f.draft);
    const next = orderRequirementWithText(f.draft, f.alpha, "Synthetic edited Alpha");
    expect(next.fields[0]).toEqual({ ...f.draft.fields[0], value: "Synthetic edited Alpha" });
    expect(next.fields[1]).toEqual(f.draft.fields[1]);
    expect({ ...next, fields: original.fields }).toEqual(original);
    expect(f.draft).toEqual(original);
    expect(f.alpha.value).toBe("Synthetic Alpha");
  });

  it("requires an explicit valid operator style edit and applies it to just one nonempty text group", () => {
    const f = fixture(), before = structuredClone(f.draft);
    const next = orderRequirementWithStyle(f.draft, f.alpha.sourceFieldKey, "Synthetic Manual Font", "#2468ac");
    expect(next.fields[0]).toMatchObject({ value: "Synthetic Alpha", sourceKey: f.alpha.sourceFieldKey,
      styleOverride: { source: "operator", font: "Synthetic Manual Font", colorHex: "#2468ac" } });
    expect(next.fields[1]).toEqual(before.fields[1]);
    expect(orderRequirementTextGroups(f.sources, next)[0]).toMatchObject({ font: "Synthetic Manual Font", colorHex: "#2468ac" });
    expect(() => orderRequirementWithStyle(f.draft, f.beta.sourceFieldKey, "Synthetic Font", "#000000")).toThrow("先填写");
    expect(() => orderRequirementWithStyle(f.draft, f.alpha.sourceFieldKey, "", "CustomColor")).toThrow("真实");
    expect(f.draft).toEqual(before);
    expect(f.sources.find(row => row.sourceFieldKey === "color-a")!.colorHex).toBeNull();
  });

  it("refuses duplicate or removed source rows instead of applying a text or style edit to an arbitrary group", () => {
    const f = fixture();
    const ambiguous = { ...f.draft, fields: [...f.draft.fields, { ...f.draft.fields[0]!, key: "duplicate" }] };
    expect(orderRequirementField(ambiguous, f.alpha.sourceFieldKey)).toBeNull();
    expect(orderRequirementWithText(ambiguous, f.alpha, "Do not apply")).toBe(ambiguous);
    expect(() => orderRequirementWithStyle(ambiguous, f.alpha.sourceFieldKey, "Font", "#123456")).toThrow();
  });

  it("rejects grouping from a different line, revision, source, projection or fixed manufacturing basis", () => {
    const f = fixture();
    const detail = { line: { id: id(1), revision: 2, projectionVersion: 3 }, report: { versionId: id(5) },
      profile: { versionId: id(4), sourceVersionId: id(6) } } as unknown as OrderWorkDetail;
    const interpretation = { basis: { orderLineId: id(1), revision: 2, projectionVersion: 3, sourceVersionId: id(5),
      artworkVersionId: id(2), specificationVersionId: id(3), printProfileVersionId: id(4), templateVersionId: id(6) } } as OrderRequirementInterpretation;
    expect(orderRequirementContextCurrent(interpretation, detail, f.draft)).toBe(true);
    for (const patch of [{ orderLineId: id(99) }, { revision: 1 }, { projectionVersion: 2 }, { sourceVersionId: null },
      { artworkVersionId: null }, { specificationVersionId: null }, { printProfileVersionId: null }, { templateVersionId: id(99) }])
      expect(orderRequirementContextCurrent({ ...interpretation, basis: { ...interpretation.basis, ...patch } }, detail, f.draft)).toBe(false);
  });

  it("uses only the exact current check for unsaved operator sources and fails closed on a mismatched input checksum", async () => {
    const f = fixture(), operator = OrderRequirementSourceSchema.parse({ ...f.alpha, sourceFieldKey: "new-operator", origin: "operator",
      groupKey: "operator:new-operator", value: "Synthetic dirty original text", targetTextKey: null });
    const draft = { ...f.draft, fields: [...f.draft.fields, { key: operator.sourceFieldKey, label: "New original text",
      value: operator.value, kind: "text" as const }] };
    const detail = { line: { id: id(1), revision: 2, projectionVersion: 3, held: false, sourceChanged: false,
      archivedAt: null, preparation: "pending_review" }, report: { versionId: id(5) }, requirementSources: f.sources,
      profile: { versionId: id(4), sourceVersionId: id(6) } } as unknown as OrderWorkDetail;
    const requirements = { basis: { orderLineId: id(1), revision: 2, projectionVersion: 3, sourceVersionId: id(5),
      artworkVersionId: id(2), specificationVersionId: id(3), printProfileVersionId: id(4), templateVersionId: id(6),
      draftChecksum: createHash("sha256").update(orderRequirementDraftInput(draft)).digest("hex") },
      sources: [...f.sources, operator] } as OrderRequirementInterpretation;
    const state: OrderReviewCheckState = { orderLineId: id(1), input: orderIntakeSnapshot(detail, draft).input,
      projectionVersion: 3, lineState: orderReviewLineState(detail), status: "ready", error: null,
      check: { orderLineId: id(1), revision: 2, sourceVersionId: id(5), ready: true, basis: "manual", package: null,
        fields: [], issues: [], notes: [], normalizedDraft: draft, requirements } };
    expect(await orderRequirementAdoptionSources(detail, draft, state, [operator.sourceFieldKey])).toBe(requirements.sources);
    await expect(orderRequirementAdoptionSources(detail, draft, null, [operator.sourceFieldKey])).rejects.toThrow("新增字段");
    await expect(orderRequirementAdoptionSources(detail, draft, { ...state, check: { ...state.check!, requirements: {
      ...requirements, basis: { ...requirements.basis, draftChecksum: "0".repeat(64) },
    } } }, [f.alpha.sourceFieldKey])).rejects.toThrow("摘要不一致");
    expect(detail.requirementSources).toEqual(f.sources);
    expect(operator.value).toBe("Synthetic dirty original text");
  });
});
