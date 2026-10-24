# Rule center and order design snapshots

The tenant business rule center is at **知识中心 → 规则中心** (`/settings/rules`),
alongside the native operating knowledge workbench. They share a business
navigation group and retain their independent lifecycle and execution semantics.
Development instructions stay in `CLAUDE.md` / `AGENTS.md`. Business rule text
cannot grant tool access, choose a provider, change budgets, execute code or
approve production.

## Sources and capabilities

The entry page is a business directory: global production requirements, daily
operations, product types, and a searchable tenant SPU list. Newly created SPUs
appear without UI code changes. A product's view includes global requirements,
type rules derived from its current specification process profiles, and its
own supplementary requirements. Unknown types are not guessed; multiple current
types are shown together, while actual order dispatch still resolves its pinned
template type. An unbound SPU can store manual requirements before a production
pipeline exists. This does not imply support for automatically making every new
product.

Four categories cover general practice, manufacturing, AI workflow and
acceptance. Scope is all products, a product type, or a tenant-owned SPU. Rules
distinguish order design from daily operations; test cleanup is not a production
requirement and is excluded from design snapshots.

Existing process profiles, specification versions and template automation
recipes remain authoritative. The center links to their maintenance pages.
Factory parameters read the shared `SHAPED_PILLOW_FACTORY_STANDARD` contract;
there is no second editable numeric specification. Orders separately pin their
exact template version, sources and recipe.

Execution labels describe capabilities, not an individual order passing QA.
Trusted built-in bindings may be automatic. New text rules are always manual.
Legacy `super_resolution` and `subject_measurement` bindings remain explicitly
unavailable; they are not reinterpreted after new code is installed. The separate
`pillow_pipeline_v1` binding applies only to explicitly reviewed
`pillow-subject-v1-2026-09-19` recipes. Its new identity is registered as a draft
and requires explicit publication. A new task using a legacy recipe records
this conditional capability as manual, and old task snapshots remain intact.
Manual requirements are displayed to the operator and
included in diagnostics, never interpreted as code or new model instructions.

## Version lifecycle and persistence

Migration `0089_business_rules.sql` adds `business_rules` (identity, optimistic
revision, latest/active pointers), `business_rule_versions` (immutable
definitions, evidence, change reasons and idempotent save keys), and
`business_rule_events` (immutable create/revise/publish/disable history).
All use forced RLS and `withTenant()`. SPU references have tenant-scoped FKs.
Database triggers and application grants protect history from updates/deletes.

Save creates a draft. Publish activates the latest version for future tasks.
Saving another draft leaves the prior published version active. Disable stops
future bindings, preserving history and hard manufacturing preflight checks.
Stale revisions fail instead of overwriting another operator. Manual text,
including built-in manual checks, supports versioned revision. Automatic and
unavailable bindings remain code-owned; a text edit cannot confer or change an
automatic capability. Process parameters must be changed in their versioned
process/template. The list exposes direct edit/configuration actions; saving
opens the new draft for review and explicit activation. History and disable
actions are secondary disclosures. Configuration links return to the rule.

Initialization is an explicit, authenticated, repeatable action. It adds missing
confirmed baseline identities and never overwrites or reactivates existing
rules. The new `system:pillow-pipeline-v1-2026-09-19` identity remains an unpublished
draft until an operator explicitly publishes it; initialization does not activate
the new pipeline or update templates. GET requests have no seeding side effects.
No hard-delete endpoint exists.

## API and permissions

The Web BFF `/api/rules/[...path]` has a path allowlist, same-origin JSON writes,
a 64 KiB body limit and private/no-store responses.

| API route | Permission | Purpose |
| --- | --- | --- |
| `GET /v1/rules/workspace` | `workflow:read` | Rules, latest/active versions, SPU choices and capability state |
| `GET /v1/rules/:id/history` | `workflow:read` | Immutable versions and change events |
| `POST /v1/rules/create` | `workflow:manage` | Unpublished manual rule |
| `POST /v1/rules/:id/revise` | `workflow:manage` | New manual rule version |
| `POST /v1/rules/:id/publish` | `workflow:approve` | Activate latest version |
| `POST /v1/rules/:id/disable` | `workflow:approve` | Stop new task bindings |
| `POST /v1/rules/initialize` | `workflow:manage` and `workflow:approve` | Register confirmed baseline once |

## Task execution and traceability

`prepareOrderDesignSnapshot` resolves matching published definitions into
`ruleSnapshot` with capture time and full version contents. Registration seals
this snapshot in the encrypted run input, covered by its checksum. Resumes use
this copy; later publication never changes an existing run.

At registration, trusted bindings check faithful enhancement for buyer images
and the pillow factory-standard identity. Conflicts enter `needs_attention`
with diagnostics and never enqueue paid work. The executor checks again before
preparing inputs. Actual resolution/geometry checks remain in production
preflight/export. Manual and unavailable requirements remain in diagnostics
after preflight.

**无人设计 → 本任务使用的规则** shows pinned text and links to the exact version.
Legacy runs explicitly have no rule-center snapshot and are not backfilled with
today's requirements. Existing template/file history is unchanged. Technical
preflight, operator approval, factory acceptance and release remain separate.

## Validation and cleanup

The shaped-pillow six-item audit policy `pillow-review-2026-09-20-v1` records the
user-confirmed minimum neck basis (distance between opposing production cut
lines) independently of historical Rule Center snapshots. It reads the pinned
snapshot and factory version; legacy tasks explicitly remain without a snapshot.
New audit evidence can satisfy the six technical/manual preflight gates but
does not mark arbitrary prose rules executable, rewrite old confirmations, or
replace operator approval. See the custom-pillow workflow and AI-assist guide.

```powershell
node --env-file=.env --import ./apps/api/node_modules/tsx/dist/loader.mjs tools/scripts/run-order-daily-acceptance.mts --suite=rules-integration
node --env-file=.env --import ./apps/api/node_modules/tsx/dist/loader.mjs tools/scripts/run-order-daily-acceptance.mts --suite=rules
```

The browser suite uses actual API/Web/database paths with no demo records or
model calls. Stop this worktree's development API and Web before the browser
suite, then restore them using the local-development commands. The runner drops
and verifies its disposable database, bucket and Redis instance in `finally`,
recording cleanup under `tmp/order-daily-e2e-*.json`. Immutable synthetic history
never enters the business database.
