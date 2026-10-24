-- Fulfillment reports can omit sales amounts. Keep that absence distinct from
-- a known zero amount, and preserve all existing monetary data unchanged.
ALTER TABLE orders ALTER COLUMN order_total_minor DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN order_currency DROP NOT NULL;
ALTER TABLE order_lines ALTER COLUMN unit_price_minor DROP NOT NULL;
ALTER TABLE order_lines ALTER COLUMN unit_price_currency DROP NOT NULL;
ALTER TABLE amazon_order_report_lines ALTER COLUMN item_total_minor DROP NOT NULL;
ALTER TABLE amazon_order_report_lines ALTER COLUMN currency DROP NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'orders'::regclass AND conname = 'orders_money_pair_check') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_money_pair_check CHECK ((order_total_minor IS NULL) = (order_currency IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'order_lines'::regclass AND conname = 'order_lines_money_pair_check') THEN
    ALTER TABLE order_lines ADD CONSTRAINT order_lines_money_pair_check CHECK ((unit_price_minor IS NULL) = (unit_price_currency IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'amazon_order_report_lines'::regclass AND conname = 'amazon_order_report_lines_money_pair_check') THEN
    ALTER TABLE amazon_order_report_lines ADD CONSTRAINT amazon_order_report_lines_money_pair_check CHECK ((item_total_minor IS NULL) = (currency IS NULL));
  END IF;
END $$;
--> statement-breakpoint
-- Order lines otherwise remain insert-only for the application role. Allow only
-- the two monetary columns to be filled, without permitting known-price edits.
GRANT UPDATE (unit_price_minor, unit_price_currency) ON order_lines TO yummyai_app;
CREATE OR REPLACE FUNCTION protect_known_order_line_money() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.unit_price_minor IS NOT NULL AND
    (NEW.unit_price_minor, NEW.unit_price_currency) IS DISTINCT FROM (OLD.unit_price_minor, OLD.unit_price_currency) THEN
    RAISE EXCEPTION 'Known order line money cannot be replaced';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS order_lines_known_money_guard ON order_lines;
CREATE TRIGGER order_lines_known_money_guard
  BEFORE UPDATE OF unit_price_minor, unit_price_currency ON order_lines
  FOR EACH ROW EXECUTE FUNCTION protect_known_order_line_money();
