# ADR-015: Split canvas batch design from controlled mockup rendering

## Status

Accepted.

## Context

Canvas artwork ideation can precede SKU creation, while marketplace mockups need
a reviewed formal design, a fixed SKU print specification, and repeatable scene
geometry. Combining both phases would let speculative candidates leak into
Listing assets and would couple AI generation retries to deterministic PSD slot
rendering.

## Decision

YummyAI exposes two tenant-scoped workbenches and persistence chains. Creative
batches generate immutable, model-attributed candidates; each selected candidate
creates its own creative family and adapts only after selection. A single review
covers the master and every required aspect. SKU promotion is a controlled
service operation that first validates all requested bindings, then creates the
formal approved design task/version and complete lineage in one tenant
transaction.

The creative phase is a top-level product surface at `/creative-designs`, separate
from the POD production navigation. `/pod-workbench/mockup-batches` remains the
downstream canvas mockup surface, and the former batch-design URL is a compatibility
redirect. This is a UI and workflow boundary only: both phases continue to share
the authoritative version, asset, permission, audit, and tenant services.

The ERP navigation groups the creative batch workspace, the general POD artwork
toolbox, design review, and mockup batches under `创意设计`; catalog, workflow,
and Listing operations remain under `商品`. Existing route and API paths stay
stable so this information-architecture move does not fork authoritative data or
break saved links.

Mockup batches accept only those approved formal design versions. Template PSDs
are compiled into immutable raster components plus a perspective manifest. The
compiler accepts only PSD v1, RGB 8-bit, the three controlled root groups, and
one embedded raster smart object per scene. It compares a placeholder rerender
with the saved PSD composite and requires SSIM 0.99 before explicit reviewer
confirmation. Runtime rendering uses Sharp and an argument-array ImageMagick 7
process in an isolated temporary directory with resource limits.

Each batch is capped at 50 items. Mockup slots are independent attempts so a
failure never removes another successful output. Listing binding is an explicit
per-item transaction against a caller-selected Listing version and slot map; it
does not create or publish a Listing.

## Consequences

- Creative and render queues scale and retry independently.
- Creative ideation can be operated without entering the POD production center;
  approved formal designs remain the explicit handoff contract to mockup rendering.
- Approved/versioned input snapshots, AI regions, checksums, costs, model data,
  specification versions, template versions, and asset lineage remain auditable.
- Research, competitor, and order-private assets cannot enter creative or mockup
  production paths.
- Photoshop rendering parity is intentionally limited to compiled controlled
  templates; unsupported effects, linked resources, text replacement, scripts,
  PSB, or over-limit sources fail closed.
- Both features remain off until their processor/renderer gates are explicitly
  enabled, and mockup UI additionally requires an approved template pack.
