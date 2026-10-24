-- Preserve all original integer values. An unconstrained numeric checks the
-- supplied precision before any implicit scale rounding can change the fact.
ALTER TABLE inventory_procurement_receipt_lines
 ALTER COLUMN received_quantity TYPE numeric USING received_quantity::numeric,
 ALTER COLUMN rejected_quantity TYPE numeric USING rejected_quantity::numeric;
ALTER TABLE inventory_procurement_receipt_lines
 ADD CONSTRAINT inventory_receipt_received_exact_check CHECK(
  received_quantity BETWEEN -2147483647 AND 2147483647 AND scale(received_quantity)<=9
  AND (unit NOT IN ('each','pair','set') OR trunc(received_quantity)=received_quantity)),
 ADD CONSTRAINT inventory_receipt_rejected_exact_check CHECK(
  rejected_quantity BETWEEN -2147483647 AND 2147483647 AND scale(rejected_quantity)<=9
  AND (unit NOT IN ('each','pair','set') OR trunc(rejected_quantity)=rejected_quantity));
