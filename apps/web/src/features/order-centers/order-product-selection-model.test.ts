import { describe, expect, it } from "vitest";
import type { OrderWorkListItem } from "@yummyai/contracts/order/workspace";
import { reconcileOrderProductSelection } from "./order-product-selection-model";

const row = (id: string, revision = 0) => ({ id, revision, projectionVersion: revision }) as OrderWorkListItem;

describe("order product selection refresh", () => {
  it("keeps an empty selection stable through repeated saved-order and empty-page refreshes", () => {
    const empty = new Map<string, OrderWorkListItem>();
    let current = empty;
    for (let refresh = 0; refresh < 100; refresh++) {
      current = reconcileOrderProductSelection(current, refresh % 2 ? [] : [row("saved-empty-images", 1)]);
      expect(current).toBe(empty);
    }
  });

  it("does not dispatch a new selection for unchanged rows or another page", () => {
    const first = row("selected"), otherPage = row("other-page"), selected = new Map([[first.id, first], [otherPage.id, otherPage]]);
    expect(reconcileOrderProductSelection(selected, [first, row("unselected")])).toBe(selected);
    expect(reconcileOrderProductSelection(selected, [])).toBe(selected);
    expect(reconcileOrderProductSelection(selected, [row("unselected")])).toBe(selected);
  });

  it("refreshes the current row while preserving other-page selection and its original order", () => {
    const first = row("first"), second = row("second"), selected = new Map([[first.id, first], [second.id, second]]);
    const fresh = row("first", 1);
    const next = reconcileOrderProductSelection(selected, [fresh]);
    expect([...next]).toEqual([[first.id, fresh], [second.id, second]]);
    expect(next).not.toBe(selected);
    expect(selected.get(first.id)).toBe(first);
    expect(next.get(second.id)).toBe(second);
    expect(reconcileOrderProductSelection(next, [fresh])).toBe(next);
  });
});
