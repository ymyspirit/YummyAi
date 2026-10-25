// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShapedPillowDocument } from "@yummyai/contracts/pod/production-editor";
import { preflightProductionDocument } from "@yummyai/production-editor";
import { PillowPreparationPanel } from "./pillow-preparation-panel";
import { createProductionDocument, invalidateProductionEdit, PILLOW_SIZES_IN } from "./production-editor-model";

let root: Root | null = null;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host);
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null; host.remove(); vi.unstubAllGlobals();
});
function pillow(): ShapedPillowDocument {
  const document = createProductionDocument("shaped_pillow");
  if (document.productType !== "shaped_pillow") throw new Error("wrong fixture");
  return document;
}
async function mount(source: ShapedPillowDocument) {
  let current = source;
  const changed = vi.fn<(document: ShapedPillowDocument) => void>();
  function Harness() {
    const [document, setDocument] = useState(source); current = document;
    return <PillowPreparationPanel document={document} canTrace={false} traceHint="Synthetic fixture only" onTrace={vi.fn()}
      onChange={next => {
        changed(next);
        // The real workspace uses this existing invalidation boundary.
        const invalidated = invalidateProductionEdit(document, next);
        if (invalidated.productType !== "shaped_pillow") throw new Error("wrong result");
        setDocument(invalidated);
      }} />;
  }
  root = createRoot(host); await act(async () => root!.render(<Harness />));
  return { current: () => current, changed };
}
async function clickSize(inches: number) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('[aria-label="抱枕订单规格"] button')]
    .find(item => item.textContent?.replace(/\s/g, "") === `${inches}in`);
  if (!button) throw new Error("size button missing");
  await act(async () => button.click());
  return button;
}

describe("pillow size preset interaction", () => {
  it.each(PILLOW_SIZES_IN)("keeps the pinned factory artwork basis when the actual %i in button is clicked", async inches => {
    const source = pillow(); source.spec.sizeBasis = "finished";
    const original = structuredClone(source), view = await mount(source);
    expect(view.changed).not.toHaveBeenCalled();
    const button = await clickSize(inches), after = view.current();
    expect(view.changed).toHaveBeenCalledOnce();
    expect(after.spec).toMatchObject({ factoryStandardId: "ps-pillow-2026-09-17", sizeBasis: "artwork", declaredLongestMm: inches * 25.4 });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(after.layers).toBe(source.layers); expect(after.contour).toBe(source.contour);
    expect(source).toEqual(original);
  });

  it("sets 16 in to 406.4 mm, leaves other factory gates intact, and clears prior confirmations through the real edit invalidation", async () => {
    const source = pillow(); source.spec.sizeBasis = "finished"; source.spec.declaredLongestMm = 254;
    source.confirmations = { physicalSize: true, whiteBorderRule: true, narrowParts: true, barcodeTab: true, backText: true, visualReview: true };
    const original = structuredClone(source), view = await mount(source);
    const resolvers = { resolveAsset: vi.fn(async () => { throw new Error("No synthetic assets are needed"); }),
      resolveFont: vi.fn(async () => { throw new Error("No synthetic fonts are needed"); }) };
    const before = await preflightProductionDocument(source, { purpose: "preview", format: "jpeg", background: "white" }, resolvers);
    expect(before.issues.some(issue => issue.code === "factory_size_basis")).toBe(true);
    await clickSize(16);
    const after = view.current();
    expect(after.spec.declaredLongestMm).toBe(406.4); expect(after.spec.sizeBasis).toBe("artwork");
    expect(Object.values(after.confirmations).every(value => value === false)).toBe(true);
    const checked = await preflightProductionDocument(after, { purpose: "preview", format: "jpeg", background: "white" }, resolvers);
    expect(checked.issues.some(issue => issue.code === "factory_size_basis")).toBe(false);
    expect(checked.issues.some(issue => issue.code === "narrow_parts_unconfirmed")).toBe(true);
    expect(resolvers.resolveAsset).not.toHaveBeenCalled(); expect(resolvers.resolveFont).not.toHaveBeenCalled();
    expect(source).toEqual(original);
  });

  it.each(["unconfirmed", "artwork", "cut_contour", "finished"] as const)("preserves a legacy %s basis when a size button is clicked", async basis => {
    const source = pillow(); source.spec.factoryStandardId = undefined; source.spec.sizeBasis = basis;
    const original = structuredClone(source), view = await mount(source);
    await clickSize(16);
    expect(view.current().spec).toMatchObject({ sizeBasis: basis, declaredLongestMm: 406.4 });
    expect(view.current().spec.factoryStandardId).toBeUndefined(); expect(source).toEqual(original);
  });

  it("does not rewrite a loaded current-standard document until the user explicitly selects a size", async () => {
    const source = pillow(); source.spec.sizeBasis = "finished"; source.spec.declaredLongestMm = 406.4;
    const original = structuredClone(source), view = await mount(source);
    expect(view.changed).not.toHaveBeenCalled(); expect(view.current()).toEqual(original); expect(source).toEqual(original);
  });
});
