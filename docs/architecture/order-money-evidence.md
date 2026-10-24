# Order money evidence

Amazon fulfillment reports can describe an order without providing sales amounts
or a currency. The normalized order and public order view represent an unknown
`orderTotal` or `unitPrice` as `null`. A known zero is still a money object with an
explicit currency; no import path may infer zero or USD from an absent value.

The corresponding order, order-line, and report-line database columns are nullable
as pairs. A check constraint rejects a monetary amount without its currency, or a
currency without its amount. Migration `0091_order_unknown_money` preserves
existing values and does not rewrite historical source snapshots.

Manual report reconciliation follows these rules:

- Reimporting an existing line without money keeps its already known core price.
- A later price can fill a previously unknown unit price only when external line
  identity, quantity, and SKU still agree. It never rewrites a known core price.
- Any newly observed line makes the previous order total incomplete, even if
  the new line has a price. Clear both aggregate fields until report reconciliation
  can establish a complete total from compatible source evidence for every line.
- A report containing no new lines must not erase an already known total merely
  because the current file omits prices. Current report evidence and accumulated
  core order facts have different purposes.

Application updates to order lines are restricted to the two money columns under
forced tenant RLS. A database trigger prevents replacement or removal of already
known line money; identity, quantity, and SKU retain their insert-only boundary.

An authorized platform sync can also fill an unknown matching line price when
the incoming and stored currencies agree. It may fill an unknown order total
only with the current Amazon/Etsy adapter's complete line inventory, matching
line identity, SKU and quantity, and prices compatible with any preserved facts.
A partial or generic normalized payload can fill a verified line fact but cannot
establish an order total. Known core money is not replaced by this recovery path.
