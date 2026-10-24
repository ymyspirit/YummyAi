# Research library to creative projects

Research captures remain immutable public-page evidence. Operators add versioned
research conclusions and media annotations, then select up to 30 sources for a
creative project. The new-project form previews resolved versions and carries a
summary into empty requirement fields. Operators confirm the original direction,
customization mode and optional SPU specification targets before saving.

## API and data

All research reads/writes and linked-project counts use the independent current
permission scopes in [research authority](research-authority.md). Study replay
checks current parent access before returning a prior immutable revision. Scoped
classification does not rewrite tenant aliases or other owners' research.

- `GET /v1/research-items` adds thumbnail, captured price, latest snapshot ID,
  latest study status/theme/version and root creative-project count. `item` and
  `researchStatus=unreviewed|analyzed|parked` are independent filters; capture and
  classification statuses retain their meanings. Full snapshots remain lazy.
- `visibility=active|archived|all` selects the mutable index state (default:
  active). Product-type facets use the same visibility. An explicit `item`
  history link remains readable even if its index entry has been archived.
- `POST /v1/research-items/archive` accepts `{ itemIds, archived }` with research
  write permission. All IDs must belong to the current member's tenant; the
  batch changes atomically and is audited. Restore uses `archived: false`.
  Migration `0074_research_archive` adds only `research_items.archived_at`.
  Archiving does not delete capture/study versions or change creative references.
- `GET /v1/research-items/:id/study?revision=<id>` returns the current or selected
  revision, latest capture ID and visible linked root projects.
- `POST /v1/research-items/:id/study` accepts `requestId`, `snapshotId`,
  `expectedVersion` and structured `content`. Research write permission is
  required. An analyzed conclusion requires a theme and differentiation. Media
  notes reference zero-based indices of included media in that immutable draft.
- `POST /v1/research-items/creative-sources` resolves source selections to
  server-owned references. A selection can pin `snapshotId` and
  `studyRevisionId` (`null` explicitly means no study). Without explicit pins,
  the latest study and its capture are used; otherwise the latest capture.
- The browser uses the authenticated `/api/research/[...path]` proxy for study
  resolution and archive calls. Writes require same origin, bounded JSON and the server
  membership context. Responses are private and uncached.

Migration `0073_research_studies` adds `research_study_revisions`. Rows append
under `withTenant`, forced RLS and the non-owner application role. Unique
tenant/request IDs make retries idempotent; a per-item transaction lock and
expected version detect concurrent edits. Update/delete are forbidden. Audit
events store identifiers rather than study contents. The migration journal time
must remain later than migration 0072, whose timestamp is already in the future.

Creative brief creation accepts `researchSources` alongside
`requirements.researchItemIds`; supplied pins must belong to the selected set.
The research module resolves every source in the same tenant transaction. The
workflow stores `researchReferences` with source, capture and study IDs, dates,
title, thumbnail and conclusion content. Brief reads produce `designInstructions`
including these fixed conclusions and annotations for the designer/Agent.
The Infinite Canvas adapter uses these complete instructions for its text node
and Agent text resource; research references do not create production image nodes.
Recaptures and later revisions do not change an existing brief. Continuation
copies the workflow pins; retries return the original brief. List responses omit
the detailed reference payload to keep navigation light.

## UI paths and boundaries

Thumbnails show an explicit unavailable state with a retry action, including
image failures that finish before hydration. Gallery failures keep media
navigation available, offer retry and disable zoom until the image can load.
The research E2E fixture archives its own synthetic entries immediately and uses
an explicit all-data filter; fixture image URLs must not remain in the daily
research list.

`/research?item=<id>&snapshot=<id>&study=<revision-id|none>` displays a fixed
reference. Historical captures and pinned study links are read-only. The latest
capture can be studied anew; prior text is retained for review, while annotations
are reset when moving to a different capture. Existing drafts remain in the form
when a save conflicts. Refresh/reopen is required to obtain the latest revision
before manually merging conflicting work.

`/creative-designs/canvas?research=<comma-separated-ids>` opens a new requirement
form. A single source may also specify `snapshot` and `study`. Copying a project
preserves its pins. Legacy projects show that they only recorded source IDs;
they are not retrospectively assigned a historical version.

Competitor media remain research references and never become `referenceAssetIds`,
approved artwork or export assets. Observed competitor elements are not copied
into the fixed-elements requirement. Original production assets retain the
existing authorization, review, SPU/specification and export gates. Saving a
research conclusion or creative requirement does not start model generation.
