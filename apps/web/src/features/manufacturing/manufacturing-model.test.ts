import { describe, expect, it } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { blankManufacturingDraft, blankMaterial, blankOperation, contentFromDraft, draftContentKey, draftFromVersion, quantityFraction, quantityText } from "./manufacturing-model";
function ready() {
  const draft = blankManufacturingDraft(createEntityId(), createEntityId());
  Object.assign(draft, { code: "TEXTILE", name: "Synthetic textile", outputQuantity: "2", outputUnit: "each", basisVersion: 1 });
  const operation = { ...blankOperation(), code: "CUT", name: "Cut", processCode: "cut", responsibility: "factory" as const };
  const material = { ...blankMaterial(), code: "FABRIC", name: "Fabric", stockItemId: createEntityId(), unit: "meter" as const, quantityUnit: "meter" as const,
    quantity: "1.5", lossPercent: "10.05", lossBasis: "add_to_net" as const, responsibility: "merchant" as const, operationKey: operation.key };
  draft.operations = [operation]; draft.materials = [material]; return draft;
}
describe("manufacturing input and retained source", () => {
  it("converts decimal and fractional input exactly and preserves invalid text for correction", () => {
    expect(quantityFraction("0.125")).toEqual({ numerator: 1, denominator: 8 });
    expect(quantityFraction("1/3")).toEqual({ numerator: 1, denominator: 3 });
    expect(quantityText(1, 4)).toBe("0.25"); expect(quantityText(1, 3)).toBe("1/3");
    expect(() => quantityFraction("1e3")).toThrow(); expect(() => quantityFraction("0/2")).toThrow();
    const draft = ready(); draft.materials[0]!.quantity = "1/";
    expect(() => contentFromDraft(draft)).toThrow(); expect(draft.materials[0]!.quantity).toBe("1/");
  });
  it("keeps unknown values distinct from zero and retains the selected loss basis", () => {
    const draft = ready(); draft.materials[0]!.quantity = ""; draft.materials[0]!.lossPercent = ""; draft.materials[0]!.responsibility = "unknown";
    expect(contentFromDraft(draft).materials[0]).toMatchObject({ quantityNumerator: null, quantityDenominator: null, lossBps: null, responsibility: "unknown" });
    draft.materials[0]!.lossPercent = "0";
    expect(contentFromDraft(draft).materials[0]!.lossBps).toBe(0);
    draft.materials[0]!.lossPercent = "10.05";
    expect(contentFromDraft(draft).materials[0]!.lossBps).toBe(1005);
  });
  it("requires a fresh quantity after a changed unit without discarding the original input", () => {
    const draft = ready(); draft.materials[0]!.unit = "gram";
    expect(() => contentFromDraft(draft)).toThrow("原数值未自动换算");
    expect(draft.materials[0]!.quantity).toBe("1.5");
    draft.materials[0]!.quantityUnit = "gram";
    expect(contentFromDraft(draft).materials[0]!.unit).toBe("gram");
  });
  it("keeps material references attached through an operation rename and uses stable semantic dirty checks", () => {
    const draft = ready(); draft.operations[0]!.code = "CUT_NEW";
    const content = contentFromDraft(draft);
    expect(content.materials[0]!.operationCode).toBe("CUT_NEW");
    const version = { recipeId: createEntityId(), versionId: createEntityId(), versionNumber: 1, spuId: createEntityId(), specificationId: draft.specificationId,
      code: draft.code, content, review: null, createdAt: new Date().toISOString() };
    expect(draftContentKey(draftFromVersion(version))).toBe(draftContentKey(draftFromVersion(version)));
  });
});
