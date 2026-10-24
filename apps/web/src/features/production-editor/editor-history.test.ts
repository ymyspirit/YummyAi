import { describe, expect, it } from "vitest";

import { commitEditorHistory, createEditorHistory, editorViewport, redoEditorHistory, safeEditorFileName, undoEditorHistory } from "./editor-history";

describe("production editor history", () => {
  it("restores transforms and starts a fresh branch after undo then edit", () => {
    const start = createEditorHistory({ layers: [{ xMm: 10, rotation: 0 }] });
    const moved = commitEditorHistory(start, { layers: [{ xMm: 45, rotation: 20 }] });
    const undone = undoEditorHistory(moved);
    expect(undone.present).toEqual(start.present);
    expect(redoEditorHistory(undone).present).toEqual(moved.present);
    const branched = commitEditorHistory(undone, { layers: [{ xMm: 20, rotation: -10 }] });
    expect(branched.future).toEqual([]);
    expect(redoEditorHistory(branched)).toBe(branched);
  });

  it("does not create undo noise for an unchanged document or retain mutable input references", () => {
    const value = { layers: [{ label: "Artwork" }] };
    const start = createEditorHistory(value);
    value.layers[0]!.label = "Changed outside editor";
    expect(start.present.layers[0]!.label).toBe("Artwork");
    expect(commitEditorHistory(start, { layers: [{ label: "Artwork" }] })).toBe(start);
    expect(undoEditorHistory(start)).toBe(start);
  });

  it("bounds memory and keeps millimeter-sized projects independent from preview pixel count", () => {
    let history = createEditorHistory({ value: 0 });
    for (let index = 1; index <= 80; index += 1) history = commitEditorHistory(history, { value: index });
    expect(history.past).toHaveLength(60);
    const large = editorViewport(670, 670, 8000);
    expect(large.width).toBe(1400);
    expect(large.height).toBeLessThanOrEqual(900);
    expect(large.left).toBeGreaterThan(0);
    expect(large.top).toBeGreaterThan(0);
    expect(editorViewport(670, 670, 290).width).toBe(290);
    expect(safeEditorFileName('../name:print.png')).toBe('.._name_print.png');
  });
});
