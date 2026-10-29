import type { OrderWorkListItem } from "@yummyai/contracts/order/workspace";

/** Refresh selected rows on this page without dropping other pages or churning an unchanged selection. */
export function reconcileOrderProductSelection(current: Map<string, OrderWorkListItem>, items: readonly OrderWorkListItem[]) {
  let next: Map<string, OrderWorkListItem> | undefined;
  for (const [id, item] of current) {
    const fresh = items.find(row => row.id === id);
    if (fresh && fresh !== item) {
      next ??= new Map(current);
      next.set(id, fresh);
    }
  }
  return next ?? current;
}
