# Workflow command safety and remaining execution work

Updated: 2026-10-16. B26/B09 command invariants; the current consumer and owner
contracts are described in [workflow execution](workflow-node-execution.md).

Workflow commands lock the run before checking its expected revision, then commit
node changes, one event and the run revision in the same tenant transaction.
The final compare-and-set must update a row; otherwise the transaction rolls back.
Two commands with one expected revision cannot both succeed or overwrite each
other's node projection. A stale command returns HTTP 409.

An `approval_gate` accepts explicit `approve`/`reject` decisions. Generic `complete`
returns HTTP 400 and cannot bypass `workflow:approve`. Approval still requires that
permission and any node-specific permission. Rejected commands leave the run,
revision and approval history unchanged. Historical completed-note edits remain
available through their existing command.

Run `pnpm test:e2e:order-daily --suite=workflow-integration`. The synthetic workflow
tests require the disposable runner. It removes the entire fixture DB/bucket/Redis,
including immutable test event history. The two new regression cases failed against
the prior implementation and passed after this repair.

Internal actions now require their actual owner result; generic `complete` returns
400. Current product scope is checked for run reads, lists and commands. Duplicate
start requests serialize on the tenant/definition/product identity. Block/unblock
preserves pinned input; cancel/reopen/reject fence outstanding attempts. Explicit
retry parameters create a new fixed attempt rather than mutating the prior input.

The standard Worker now consumes `workflow-node` through shared catalog/POD owner
services and fenced completion. Run the disposable
`--suite=workflow-execution-integration` for these paths. Full operator UI, external
provider recovery and complete B26 acceptance remain open.
