-- Preserve existing whole-number facts. Unconstrained numeric and CHECK refuse
-- unsupported precision instead of rounding it before validation.
ALTER TABLE inventory_movements
 ALTER COLUMN quantity_delta TYPE numeric USING quantity_delta::numeric;
ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_exact_quantity_check CHECK((quantity_delta BETWEEN -2147483647 AND 2147483647 AND scale(quantity_delta) <= 9 AND (unit NOT IN ('each','pair','set') OR trunc(quantity_delta) = quantity_delta)));
ALTER TABLE inventory_balances
 ALTER COLUMN physical_quantity TYPE numeric USING physical_quantity::numeric,
 ALTER COLUMN reserved_quantity TYPE numeric USING reserved_quantity::numeric,
 ALTER COLUMN in_transit_quantity TYPE numeric USING in_transit_quantity::numeric,
 ALTER COLUMN provider_quantity TYPE numeric USING provider_quantity::numeric,
 ALTER COLUMN virtual_quantity TYPE numeric USING virtual_quantity::numeric;
ALTER TABLE inventory_balances ADD CONSTRAINT inventory_balances_exact_quantity_check CHECK((physical_quantity BETWEEN -2147483647 AND 2147483647 AND scale(physical_quantity) <= 9 AND (unit NOT IN ('each','pair','set') OR trunc(physical_quantity) = physical_quantity)) AND (reserved_quantity BETWEEN -2147483647 AND 2147483647 AND scale(reserved_quantity) <= 9 AND (unit NOT IN ('each','pair','set') OR trunc(reserved_quantity) = reserved_quantity)) AND (in_transit_quantity BETWEEN -2147483647 AND 2147483647 AND scale(in_transit_quantity) <= 9 AND (unit NOT IN ('each','pair','set') OR trunc(in_transit_quantity) = in_transit_quantity)) AND (provider_quantity BETWEEN -2147483647 AND 2147483647 AND scale(provider_quantity) <= 9 AND (unit NOT IN ('each','pair','set') OR trunc(provider_quantity) = provider_quantity)) AND (virtual_quantity BETWEEN -2147483647 AND 2147483647 AND scale(virtual_quantity) <= 9 AND (unit NOT IN ('each','pair','set') OR trunc(virtual_quantity) = virtual_quantity)));
ALTER TABLE inventory_reservations
 ALTER COLUMN quantity TYPE numeric USING quantity::numeric;
ALTER TABLE inventory_reservations ADD CONSTRAINT inventory_reservations_exact_quantity_check CHECK((quantity BETWEEN -2147483647 AND 2147483647 AND scale(quantity) <= 9 AND (unit NOT IN ('each','pair','set') OR trunc(quantity) = quantity)));
ALTER TABLE inventory_transfers
 ALTER COLUMN quantity TYPE numeric USING quantity::numeric;
ALTER TABLE inventory_transfers ADD CONSTRAINT inventory_transfers_exact_quantity_check CHECK((quantity BETWEEN -2147483647 AND 2147483647 AND scale(quantity) <= 9 AND (unit NOT IN ('each','pair','set') OR trunc(quantity) = quantity)));
ALTER TABLE inventory_replenishment_suggestions
 ALTER COLUMN available_quantity TYPE numeric USING available_quantity::numeric,
 ALTER COLUMN in_transit_quantity TYPE numeric USING in_transit_quantity::numeric;
ALTER TABLE inventory_replenishment_suggestions ADD CONSTRAINT inventory_replenishment_suggestions_exact_quantity_check CHECK(
 (available_quantity BETWEEN -999999999999999999999999999999 AND 999999999999999999999999999999 AND scale(available_quantity) <= 9) AND
 (in_transit_quantity BETWEEN -999999999999999999999999999999 AND 999999999999999999999999999999 AND scale(in_transit_quantity) <= 9));
