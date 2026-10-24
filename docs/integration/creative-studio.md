# ERP creative studio integration

The ERP now owns the navigation, project selection, model configuration, private
assets and durable task history used by the embedded creative tools. The legacy
Infinite Canvas host remains at its original origin for historical project export.

The current adapter 2.2.0 keeps the pinned v0.20.0 vendor tree unchanged. Its
production personal workspace, per-operation authority, paused generation and
sealed runtime were adopted locally on 2026-10-23; see
[personal Studio](creative-studio-personal.md). The following 2026-10-19 adapter
2.1.2 save-rejection behavior remains part of that boundary.
Zustand persistence may ignore an asynchronous save promise; the ERP storage
adapter observes that promise while preserving its rejection for callers that
await it. Storage still reports failure, retains the open draft and requires an
explicit retry. This does not suppress global errors or manufacture a successful
save. The browser regression covers an actual rejected canvas write, prompt save,
revoked access and late successful media response, plus editor/tool restoration.
Shared runtime imports use existing package exports so Node ESM and Next can both
resolve them. No permission or production gate is relaxed.

The first AI assistance batch adds research-to-brief analysis, order preparation
review and saved production-artwork preflight. See [AI assistance integration](ai-assists.md)
for model setup, evidence, retention, budget controls and verification boundaries.

## Entry points

| ERP page | Purpose |
| --- | --- |
| `/creative-designs/canvas` | Project list and requirements, design/materials, customization, review/delivery tabs |
| `/creative-designs/studio/canvas` | Infinite canvas library and editor |
| `/creative-designs/studio/image` | Image generation and edits |
| `/creative-designs/studio/video` | Video creation |
| `/creative-designs/studio/prompts` | Saved personal prompts, reusable in the editor and image prompt picker |
| `/creative-designs/studio/assets` | Image, video and text assets |
| `/settings/ai` | Encrypted provider credentials and capability-specific models |

The optional `brief` query parameter selects a creative workflow step. The ERP
remembers this selection when moving between tools in the same browser tab.

## Reusable print projects and order design

Creative projects develop reusable print masters before SKU binding. The four tabs
record structured requirements, provide authorized reference selection and real
design-file uploads, configure text/image regions and sample previews, then review
candidates and register an artwork SKU with its source material manifest. Project
search filters by name, fixed/text/photo/mixed mode and review state. Historical
multi-step workflows remain available through “历史创作与工具”.

`POST /v1/canvas-bridge/briefs` accepts shared-contract `requirements`, including
research identities, optional target specification version IDs, audience, occasion,
style, fixed elements, image handling, customization, percentage layout and acceptance.
These are pinned in the immutable workflow snapshot. Edits create a copied new
requirement. Tenant ownership is checked for linked research/specifications.
`GET briefs/:id/thumbnail` returns a private authorized candidate thumbnail. Scoped
studio generation compiles the pinned requirements and target specifications into
the design instructions and attaches authorized project references for image models.

Order-private buyer text/photos are entered only in order preparation. Explicit
dispatch passes the pinned artwork manifest and specification to the order editor;
see [order centers](order-centers.md). The local template executor does not call a
general creative AI provider with private order content.
`unassigned` is a personal workspace. Documents are currently private to the
authenticated member within a tenant and scope; this is not a team coediting
implementation. Each workflow step keeps its own canvas documents. Approved
references from the previous step are attached to the next without copying bytes.

The shared ERP layout lazily creates one editor iframe and verified message
channel when the first creative tool is opened. Other pages do not start an editor
until then. Moving between canvas, image, video, prompts and
assets changes the runtime's internal route through `studio.tool`; it does not
reload the runtime or fetch model configuration again. Each tool remembers its
last internal location, so returning to My Canvas reopens the active canvas.
Entering My Assets refreshes the ERP asset list to include recent uploads and
completed generation results without restarting the editor.
Each tool is loaded as a separate runtime chunk; the canvas library does not
download the canvas editor, image/video workbenches or prompts page until opened.
The app bundle downloads during the verified project handshake. Rendering and
document hydration no longer await `models`: configuration loads in the background
with an explicit status, while generation and model selection stay disabled until
it succeeds. Generation submission also enforces readiness. A failed model read
can be retried without replacing the editor or its draft.

`GET /v1/canvas-bridge/projects` supplies only `id`, `name` and nullable `stepIndex`
for the studio project selector (latest 200, same tenant and DesignRead boundary).
The full `briefs` list remains available for project management. Asset store
hydration and catalogue synchronization load metadata only. Visible image cards
request `asset.preview` with `namespace: image_files` and the storage key; the API
authorizes the current member, scope, tenant and authorized asset domain before
returning a WebP at most 320 by 240 pixels. The runtime bounds its preview cache to
64 images. Videos show a placeholder until opened. Insertion, details, downloads
and exports resolve original files through the existing versioned private storage
path. Thumbnail bytes never replace original files or production artwork.
Runtime-originated tool changes carry the parent tool that initiated them;
outdated route notifications cannot undo a newer ERP tool selection. Origin,
Window and channel verification still apply to every message.

Leaving for orders, inventory, research or settings hides this editor without
unmounting it. Returning to the same project reveals the existing canvas and form
drafts immediately. `studio.refresh` updates model choices and new assets in the
background, preserving valid model selections and other editor settings. Hidden
editors cannot trigger ERP navigation or intercept another module's links; record
panel polling pauses while hidden. Save replies continue to be handled.

Changing the project/scope creates a fresh iframe and channel to isolate in-memory
documents and pending RPC replies. Refreshing or leaving the ERP shell ends the
editor session. In the visible editor, pending or failed saves continue to block
link navigation and project selection until the existing save/retry flow finishes.
Unsaved work retains its tab-close protection even while the editor is hidden.

Loaded editors also recheck current read access through the existing read-only
`state.keys` RPC every 30 seconds, on focus/visibility changes and when returning
to the editor. This check continues while an initialized editor is hidden.
An explicit scope authorization failure or missing scope clears the iframe,
record panels, preview Blob URLs, selected scope and session selection. Read
generations and iframe lifetimes fence late successful responses so they cannot
restore private content after denial or a project change. Transient probe failures
preserve the open draft and show a recoverable access status; a single missing
asset remains a local diagnostic. Access probes never submit generation, save or
review operations. After access is restored, the user explicitly rechecks access
and opens the original saved version.

The latest-project selector is a bounded projection, not an authorization source.
When an original project URL is absent from those latest 200 summaries, the studio
reads that exact project through its existing authorized owner and keeps its
original scope. A missing or forbidden project is surfaced; it is never silently
replaced by the unassigned workspace. Changing scope invalidates older reads.
The disposable browser and integration evidence, including legacy canvas recovery,
is recorded in [canvas session delivery](../project-control/CANVAS_SESSION_DELIVERY_20261017.md).

Temporary API outages no longer strand the editor behind a connection button.
Project reads and the read-only `state.get`, `state.keys`, `models`, `assets`, `asset.preview` and
`generations` RPCs retry with a 1/2/4/8/15-second backoff, capped at 15 seconds.
Each read attempt times out after 20 seconds; changing scope cancels that scope's
requests. Browser online/focus events wake a pending retry. The save bar reports
read recovery separately from pending or failed writes. A pending hydration never
becomes an empty document, and recovery does not reload an initialized iframe.

The runtime repeats its initial ready message until the verified parent replies;
the parent deduplicates initialization. A failed iframe load is retried only before
initialization, when there is no editor draft. Recovery notifications keep the
original read RPC alive during longer outages. Exact Window, origin and channel
checks remain in force throughout.

Authorization, missing-record and revision-conflict errors are surfaced instead
of retried. Document/file saves, removals, generation submissions and review
actions are not automatically replayed: a missing response can mean the operation
was committed. Failed saves retain their in-memory draft, navigation protection,
backup and explicit retry controls. Existing revision checks still prevent a
retry from overwriting a newer server version.

In local development, API watch restarts can briefly return HTTP 502 even while
the editor static server remains available. The read recovery handles this gap;
it is not an ERP login or a requirement to reconnect on each visit. Normal status
is “自动保存已开启”.

## Local runtime

Use Node 24.17.x and pnpm 11.10.x. `pnpm start:local` and the Web dev launcher build
and start the development runtime. `pnpm studio:dev` starts it separately. The default is
`http://127.0.0.1:4176`; `CANVAS_STUDIO_URL` can select another loopback HTTP origin
for the Web launcher or standalone command. The one-click launcher uses port 4176.
Do not use the same origin as the ERP: the separate origin isolates editor code.

`packages/canvas-runtime` builds the pinned MIT-licensed Infinite Canvas v0.20.0
source through explicit adapters. The iframe exposes only the tool content. The
ERP sidebar, breadcrumbs, theme, project selection and settings remain outside it.
There are no provider keys in iframe URLs, browser storage or model list responses.

The static server uses a CSP that restricts programmatic connections to its own
origin, blob URLs and data URLs. Provider requests go through ERP services. The
browser message receiver checks the exact iframe Window, origin and a random
channel ID, validates every operation and replaces any supplied scope with the
scope selected by the ERP. The runtime does not receive the BFF's local identity.

For an adopted daily ERP, use `pnpm docker:up` and `pnpm daily:start` instead of
development launchers. The production personal service is a sealed standalone
artifact in the same Docker project, served by the isolated `studio-runtime` and
loopback-only `studio-runtime-entry`; `pnpm studio:start` starts only an adopted
pin. Version 2 deployment records use a deployment ID separate from the bundle ID.
Its current workspace/invoke authority, paused generation and immutable
runtime boundary are specified in [personal Studio](creative-studio-personal.md).

## API and persistence

`POST /v1/creative-studio/rpc` uses the shared `StudioRpcSchema` contract. The Web
proxy is `/api/creative-studio/rpc`. It rejects cross-origin mutations, bounds
request bodies and uses the existing authenticated server API client. This BFF
is local development only; production returns 403 until it uses real user OIDC
sessions. Never expose local service credentials as a production login.

The production personal path uses `/workspace` and `/invoke` rather than enabling
this legacy RPC route. Model configuration has its own personal permission gate.
The original services and versioned storage remain the persistence owners.

Migration `0068_creative_studio_integration` creates:

- `creative_studio_entries`: member/scope/namespace/key records with optimistic revisions.
- `creative_studio_revisions`: immutable document/file-reference history.
- `creative_studio_generations`: immutable inputs, pinned references and mutable task status.

All three tables force tenant RLS, and application access uses `withTenant()`.
The API additionally filters documents and tasks by the authenticated member.
The database rejects entry identity changes, nonsequential revisions, generation
input changes and historical revision mutation. Editor strings use a JSONB
envelope so driver parsing cannot change their storage type.

Canvas graphs and asset/prompt metadata use document records. Image/video logs use
separate namespaces. Media bytes use the existing private authorized asset domain,
are scanned and bounded to 20 MiB, and are referenced from documents by stable
keys. Uploads and AI outputs start unverified. References must already be approved
and originate from owned, licensed or AI-generated assets; competitor and customer
asset sources are excluded from general creative generation. A tool's garbage
collection cannot erase files used by another tool. Explicit removal soft-deletes
the entry and preserves its revision history and immutable stored bytes.

The ERP save bar shows outstanding writes and failure. On revision conflict, the
current page cannot overwrite the newer server revision. Export a canvas ZIP from
the open draft, then reopen and reconcile it. Failed initial hydration cannot save
an empty replacement. Prompts and assets can also be exported with their native
asset tools. Server revisions are retained for recovery; a revision browsing and
restore UI is not yet provided.

## Model configuration and generation

Channel-management verification (2026-09-14): 29 configuration/removal/studio
integration cases passed; all seven configuration browser scenarios passed
(six in the initial run, the mobile filter scenario after making its options
fully accessible). Scope typechecks, ESLint, project rules and the Web production
build passed. Real in-app-browser inspection verified the empty-channel removal
dialog and cancellation; existing user channels were retained. Test deletion
used isolated synthetic tenant records and HTTP fixtures, without provider calls.

`/settings/ai` now embeds the pinned upstream `ChannelEditorDrawer`,
`ModelSelectModal` and `ModelPicker`. The settings surface has a separate verified
message channel from the persistent creative editor. Its receiver accepts only
`ConfigurationRpcSchema`; it cannot load documents or submit generation. ERP
adaptations live in `configuration-adapter.ts` and `src/settings-*`, leaving vendor
files unchanged. The first supported protocol is OpenAI, including compatible
channels. Gemini, audio and arbitrary provider scripts are outside this adapter.

`POST /v1/ai/configuration`, proxied at `/api/creative-studio/configuration`, requires
`model:configure`. Its operations are `configuration.get`, `channel.discover`,
`channel.save`, `channel.status`, `channel.remove`, `model.remove` and `defaults.save`. Tenant context is obtained
from authenticated membership. Mutations use tenant transactions and revision
checks; channel/model changes commit together. Discovery uses the supplied draft
key, or a saved channel's encrypted key without returning it to the browser. A
changed draft endpoint requires its own key or an explicit channel save before a
stored credential can be used. No generation or automatic retry occurs during
discovery or configuration saves. New credentials exist transiently in the entry
form and its request, never in browser persistence or returned configuration.

The server queries the channel's `/models`, validates and deduplicates IDs, and
returns a timestamped catalogue. This follows the [OpenAI list models contract](https://developers.openai.com/api/reference/resources/models/methods/list).
Listed IDs are not verified capabilities. Upstream name-based suggestions remain
editable; manual model entry works when a channel does not expose a catalogue.
Timeouts, credentials, permissions, rate limits and malformed responses have
explicit diagnostics without exposing provider response bodies. Responses are
bounded to 2 MB and 10,000 entries; a saved channel accepts up to 200 models.

Existing `/v1/ai/model-configs` and single-model endpoints remain available.
The settings surface separates **渠道管理**, **模型管理** and **默认模型**.
Channel rows show connection metadata and counts; the model tab supports channel,
capability and name/ID filtering, including dedicated analysis models on disabled
channels. The advanced analysis pricing form appears only on the model tab.
The parent accepts a validated `settings.view` notification from its existing
origin/source/channel-checked frame to control that visibility; hidden pricing
drafts remain mounted and keep their navigation guard.

`channel.remove` requires the current `id` and `revision`. Its page-rendered
confirmation lists both creative and dedicated analysis models, including those
belonging to a disabled channel. Queued/running task snapshots across tenant
members block removal, even if the original model route is already disabled.
Active business or multi-provider routes also block removal and are named in the
response. All related routes participate in the revision token.
Under the shared configuration advisory lock, removal disables owned routes,
clears this user's affected defaults and replaces the provider credential with an
empty tombstone. The provider receives status `deleted` and disappears from both
configuration APIs. Legacy update, discovery and model-add endpoints cannot
revive it. Historical task/model snapshots and generated files remain intact.
Other users' private defaults are not rewritten through RLS; unavailable IDs are
rejected by task creation and shown as unavailable in their default picker.
Migration `0081_model_channel_removal.sql` extends the status constraint and makes
channel-name uniqueness apply only to retained configurations. A newly added
channel may reuse a deleted name, with fresh channel and creative-model IDs.

Routes keep their IDs and existing target options during channel edits. Removed
models are disabled, and selecting them again restores the original route ID.
Every creative and analysis model has a visible delete action with confirmation.
`model.remove` accepts `channelId`, `modelId` and the channel's current `revision`;
the revision includes analysis routes as well as creative routes. Direct removal
and removal through channel editing reject queued/running studio or assistant
tasks, including other members' tasks in the same tenant. Task creation and model
configuration share the same tenant advisory lock to serialize that check.
Removal retains model records, encrypted analysis results, job snapshots and
generated assets, and excludes the route from all new-task model pickers. A shared
text route is removed from both text creation and business analysis. Removing a
dedicated analysis route does not remove a separate text route with the same model
name. Re-adding a removed analysis label restores its ID with the newly entered
pricing. Neither removal nor re-adding calls the provider.
Channel edits leave historical multi-target and dedicated analysis routes untouched. A legacy
channel containing same-name models for different capabilities is rejected by
the bulk editor until an explicit compatibility conversion is provided; its
existing routes continue working. No legacy browser credentials are imported.

Migration `0078_model_preferences` adds defaults keyed by tenant and member, with
forced RLS on both identities. Image/video/text defaults apply when an editor has
no valid selection; refresh preserves an existing valid choice and its draft.
Analysis defaults prioritize the member's selected configured analysis model.
Changing a route's capability does not transfer its old default to the new
capability. Removal clears the acting member's references and increments their
preferences revision. Other members' preferences remain owner-isolated by RLS;
an unavailable selection is shown explicitly and cannot be used for a new task.
Disabling a channel retains stored preferences for correction or later re-enabling.
Analysis pricing and limits remain in the expandable ERP form below the shared
configuration surface. Existing batch-design/mockup processor settings are separate.

`MODEL_CREDENTIAL_ENCRYPTION_KEY` is a base64url 32-byte encryption key. API and
Worker must use the same value. Local development can derive this dedicated
`yummyai:model-config` encryption domain from the existing local OIDC client secret.
Back up the encryption configuration together with the database. Never put actual
keys into documentation, source control, logs or model request snapshots.

The `studio-generation` BullMQ queue has one submission attempt. Requests have a
stable request ID, inputs are immutable, and each member can have at most four
queued/running tasks. The Worker rechecks reference rights/version/checksum,
decrypts provider credentials, calls the provider, scans returned files, and saves
results privately before marking the task complete. Client navigation does not
cancel queued jobs. A interrupted request without a known provider task ID is
reported as interrupted rather than billed again. A known video task can resume
polling without another create call. Errors persist safe codes, never provider
response bodies or credentials. Channel billing remains authoritative; no price
or budget reservation is fabricated by this adapter.

Supported protocol subset:

| Capability | Protocol |
| --- | --- |
| Images | OpenAI-compatible `/images/generations` and multipart `/images/edits`; one result per submitted job; `b64_json` response required |
| Video | OpenAI-compatible `/videos`, `/videos/{id}`, `/videos/{id}/content`; text and at most one image reference; private MP4 output |
| Text | `/chat/completions`, text-only input and nonstreaming final response |

This does not imply that every model or vendor supports the same sizes, quality,
duration, or background parameters. Choose models documented by the configured
provider. Audio generation and video/audio reference inputs are not integrated.
Public prompt-source scripts and provider scripts are not active in this runtime.
The integrated prompt library stores the user's own text assets.

The image endpoint contract was checked against the [OpenAI image model reference](https://developers.openai.com/api/docs/models/gpt-image-2).
The video adapter follows the [video create/retrieve contract](https://developers.openai.com/api/reference/typescript/resources/videos/methods/create).
As checked on 2026-09-12, that reference announces the Sora API shutdown for
2026-09-24; this integration does not preconfigure or recommend a Sora model.
Availability and compatibility of other configured providers must be verified.

Completed project images are submitted idempotently into the existing pending
candidate review when their result is retrieved. They reuse the same private asset
record. If the step cannot receive another candidate (including its four-result
limit), the file stays saved and the UI explains the review failure. A user must
approve the candidate before production handoff. Videos remain creative assets;
they are not treated as reviewed production artwork or marketplace publications.

## Historical project migration

1. Open the preserved legacy host at its existing browser origin (default 4175).
2. Export the required canvases to ZIP, including media.
3. In ERP, choose the target project/step, open My Canvas and import the ZIP.
4. Wait for ERP saving to finish, refresh, and verify titles, nodes, connections
   and media. New uploads require rights review before use as generation references.
5. Keep the legacy copy and ZIP until recovery has been checked.

No automatic deletion or credential migration is performed. Browser-origin data
from the old host remains intact. Old plugin-based review transfer remains under
the project's legacy migration details as a fallback.

## Verification

The studio integration test covers real PostgreSQL RLS/private storage, exact
document round trips, concurrent revisions, member/tenant separation, credential
rejection, upload validation, reference review, immutable inputs, durable worker
results and duplicate review retrieval. Provider gateway tests own synthetic
responses and verify request shapes and no billing retries. Browser tests cover
real ERP routes, iframe saving/reload, prompt reuse, failed hydration, responsive
layout and cross-origin rejection without calling a paid model.

Local validation on 2026-09-12 (Node 24.17.0, pnpm 11.10.0):

- Full `pnpm test`, `pnpm typecheck` and `pnpm build` passed.
- API integration: 5 studio cases and 9 existing canvas bridge cases passed.
- Browser regression: 6 studio cases and 18 navigation/legacy bridge cases passed.
  Canvas coverage creates text and a synthetic PNG, refreshes, reopens the canvas,
  and verifies both nodes plus the image's decoded width. Image/video workbenches
  are checked at desktop and 390 px widths.
- ESLint passed outside the pre-existing, untouched `docs/project-map` directory.
  Root lint still reports its existing `scripts/generate-inventory.mjs:137`
  undefined `console`; this integration does not modify that directory.
- Paid provider calls, production OIDC sessions and automatic legacy-data migration
  were not exercised. This is local integration evidence, not a release candidate.

Connection reuse verification on 2026-09-12:

- All 8 creative-studio browser cases passed. Switching through all five tools
  and browser back/forward keeps the same iframe, loads its document once and
  requests models once. Returning to the active canvas preserves its text/image
  nodes; refresh still restores saved data. New asset thumbnails decode without
  another page load.
- Returning from orders, inventory and research keeps the same iframe and open
  canvas. An unsaved image prompt survives settings/inventory navigation, and the
  model picker updates in the existing editor after returning. Synthetic late
  frame messages neither change the hidden editor's parent route nor block other
  modules' links. Cold visits to non-studio pages create no iframe. Desktop and
  mobile evidence is saved under `output/studio-module-session/`.
- A delayed-save case verifies that navigation waits for persistence, then reuses
  the editor. Selecting another project creates a new channel and hides the first
  project's content; returning restores the original saved prompt.
- Shared navigation regression covered 19 cases: 18 passed in the combined run;
  the search-dialog focus case timed out on its initial opening and passed in an
  isolated rerun. No navigation implementation was changed for that retry.
- 68 navigation/bridge unit tests, 5 creative-studio integration tests, Web/runtime
  typechecks, scoped ESLint, rule checks and both builds passed. Desktop and 390 px
  browser screenshots were inspected. Existing paid-provider/OIDC limits above
  still apply.

OpenAI configuration verification on 2026-09-14:

- The current upstream release check returned v0.18.0, matching the pinned
  runtime. All 183 vendor checksums match the reviewed official commit tree.
  [Upgrade procedures](../operations/creative-studio-upgrades.md) cover candidate
  comparison, lock recording, compatibility checks and rollback.
- 31 API integration cases passed across model configuration, existing provider
  CRUD, creative storage/generation and AI assistants. The new adapter has 10
  tenant-backed cases, including saved-key discovery, atomic edits, unchanged
  route IDs, personal defaults, stale revisions and historical-route preservation.
- All 14 creative-studio browser cases passed. Configuration fixtures render the
  actual ERP page and upstream drawer/picker; only HTTP configuration responses
  are synthetic. No user channels or paid provider endpoints are changed by these
  fixtures. Desktop and 390 px screenshots were visually checked.
- Root lint, five affected package typechecks, Web and runtime builds, 13 catalogue
  unit tests, 5 runtime tests, 3 rule tests and 9 tool tests passed. Logs are under
  `tmp/studio-config-*`; browser artifacts are in `apps/web/test-results/`.
- The expanded assistant regression exposed a retention timestamp mismatch.
  Expiry now uses the same database clock as creation, maintaining the existing
  24-hour/30-day limits without weakening the assertion; all 10 assistant cases
  passed afterward.
- Backup/restore of PostgreSQL and 1,485 private objects passed in temporary
  verification resources. Paid OpenAI generation and production user OIDC remain
  unverified. This work is local integration, not a release candidate or an
  automatic upstream upgrade.

Model removal verification on 2026-09-14:

- 34 tenant-backed integration cases passed across configuration/removal, AI
  assistants and creative storage/generation. Five removal cases cover permissions,
  cross-tenant access, channel ownership, revisions, personal defaults, other
  members' queued/running jobs, preserved completed results and re-adding models.
- Four configuration browser cases passed, including deletion confirmation and
  cancellation, server conflicts, refresh persistence, analysis/default refresh
  and 390 px layout. They use synthetic HTTP responses and no live provider calls.
  Screenshots are in `tmp/model-removal-evidence/`.
- Root lint, all 16 package typechecks, rule checks, five canvas runtime unit
  tests and the Web production build passed. The configuration runtime was rebuilt
  for the browser tests. Existing tenant credentials and configured models were
  not changed during verification.

Embedded-browser confirmation correction on 2026-09-14:

- A live click in the in-app browser exposed the analysis deletion's dependency
  on a native JavaScript confirmation. The earlier Playwright dialog handlers
  accepted that confirmation programmatically and did not verify a visible page
  control. Analysis deletion now uses a page-rendered modal with explicit confirm,
  cancel, progress and error states; missing channel metadata also reports a reason.
- Two regression cases run with `window.confirm` deliberately unavailable. They
  cover visible confirmation, cancel/Escape, restored keyboard focus, shared-text
  impact, blocked deletion, pending-request controls, successful removal, defaults
  and refresh persistence at desktop/390 px widths. Both pass, alongside Web
  typecheck and scoped ESLint. The actual in-app page's confirmation and cancel
  interaction were also verified visually.

Integrated runtime update on 2026-10-13:

- Official Infinite Canvas v0.20.0 is pinned at
  `3a6b64b602ad062b29fac66902ed18a7ef5fd9dc` with ERP adapter 2.1.0.
  All 184 vendor files are unchanged from the official source. The separate
  legacy bridge host retains its own baseline.
- New derived image previews use an in-memory cache. Original files remain in
  the authorized ERP storage domain and are exported at their original size.
  Document and configuration protocols remain at version 1.
- The phone layout collapses the elements panel by default, overlays it when
  opened and keeps bottom actions in a scrollable strip. Desktop panel state is
  preserved when switching between widths.
- Twenty isolated browser cases and 18 tenant-backed integration cases passed.
  Historical v0.18 text, connections, prompts, generation history and original
  image bytes survived edit, reload and export. Model configuration, error
  retention, member/tenant isolation and mobile layouts were covered.
- Backup and isolated restore passed before upgrading. See
  [upgrade and rollback evidence](../operations/creative-studio-upgrades.md).
  These checks use synthetic fixtures and do not call paid generation providers.


## Durable original generation and recovery · 2026-10-19

New Studio image/text/video operations use the shared [creative execution owner](creative-execution.md), with current membership/object checks, pinned model routing, the original budget/submission, encrypted response and atomic asset/entry adoption. Known video IDs resume with GET only; unknown submissions do not POST again. Real process interruption, local storage and scanning have synthetic-provider evidence. Normal migration 0129, current-authority execution views, manual reconciliation and real-provider quality remain separate work.
