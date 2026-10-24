-- AI assists settle a reservation after confirmed usage or release it before submission.
-- Identity, request, pricing provenance, and creation time remain immutable.
CREATE FUNCTION protect_ai_budget_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'state' - 'amount_usd') IS DISTINCT FROM
     (to_jsonb(OLD) - 'state' - 'amount_usd') THEN
    RAISE EXCEPTION 'AI budget ledger identity and provenance are immutable' USING ERRCODE = '23514';
  END IF;

  -- Replaying the same settlement or release is an idempotent no-op.
  IF NEW.state = OLD.state AND NEW.amount_usd = OLD.amount_usd THEN
    RETURN NEW;
  END IF;

  IF OLD.state <> 'reserved' OR NEW.state NOT IN ('committed', 'released') THEN
    RAISE EXCEPTION 'AI budget ledger only permits a reservation to be settled or released' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'released' AND NEW.amount_usd IS DISTINCT FROM OLD.amount_usd THEN
    RAISE EXCEPTION 'Releasing an AI budget reservation must retain its original amount' USING ERRCODE = '23514';
  END IF;
  -- The existing nonnegative amount check also applies to confirmed actual cost.
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ai_budget_settlement_guard BEFORE UPDATE ON ai_budget_ledger
FOR EACH ROW EXECUTE FUNCTION protect_ai_budget_settlement();
--> statement-breakpoint
GRANT UPDATE (state, amount_usd) ON ai_budget_ledger TO yummyai_app;
