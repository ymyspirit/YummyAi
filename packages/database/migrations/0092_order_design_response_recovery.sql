-- Existing SQL used PostgreSQL's generated name; the schema uses a named check.
ALTER TABLE order_design_agent_commands DROP CONSTRAINT IF EXISTS order_design_agent_commands_action_check;
ALTER TABLE order_design_agent_commands DROP CONSTRAINT IF EXISTS order_design_commands_action_check;
ALTER TABLE order_design_agent_commands ADD CONSTRAINT order_design_commands_action_check
  CHECK (action IN ('resume', 'takeover', 'restore_response'));
