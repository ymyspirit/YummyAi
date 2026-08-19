# Deployment runbook

## Release inputs

- Immutable application commit and image digests
- reviewed environment configuration from `.env.example`
- PostgreSQL migration plan and current backup evidence
- Keycloak realm/client configuration
- private S3 bucket with versioning and lifecycle policy
- private ClamAV/`clamd` service with persisted, refreshed signature database
- OTLP endpoint and alert routing

## Sequence

1. Confirm CI passes lint, typecheck, unit, integration, E2E, build, and secret scanning.
   The successful workflow uploads `release-candidate-<commit SHA>` containing the Chrome/Edge extension ZIPs and `release-candidate-manifest.json`. Verify every ZIP checksum against that manifest before distribution.
2. Run `tools/scripts/backup.ps1` and retain the generated checksums outside the host.
3. Deploy infrastructure changes, then run database migrations with the migration credential.
4. Deploy API/worker before web when contracts are backward compatible. Keep old workers draining while new workers start.
5. Run `/`, OIDC login, tenant isolation, capture, AI budget, authorized-file, Listing review, and export checksum smoke checks.
6. Enable traffic gradually. Watch HTTP error rate, job failure rate, queue latency (including `publication-reconciliation`), PostgreSQL saturation, and OTLP collector health.

## Required environment safety

- `DEBUG` and all `*_DEMO_MODE` flags must be false/unset.
- Secrets come from the deployment secret manager, never images or GitHub logs.
- `DATABASE_URL` for the app uses `yummyai_app`; migration/backup credentials are separate.
- `MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY`, `ORDER_PII_ENCRYPTION_KEY`, and `INTEGRATION_SECRET_ENCRYPTION_KEY` are distinct 32-byte secrets with independent rotation scopes. API and Worker receive the same integration and order-PII keys; only purpose-bound order-personalization jobs may decrypt order PII in Worker memory.
- `ORDER_PII_RETENTION_DAYS` is reviewed against the tenant retention policy before order ingestion is enabled.
- Order rendering is enabled only when `POD_ORDER_PROCESSOR_URL`, `POD_ORDER_PROCESSOR_API_KEY`, `POD_ORDER_PROCESSOR_DEPLOYMENT_ID`, and a reviewed `POD_ORDER_ENABLED_TOOLS` allowlist are all present. The only accepted tool values are `image_composite`, `group_photo`, `pet_outfit`, `fulfillment_composite`, and `vector_fulfillment`. These values are independent from ordinary `POD_PROCESSOR_*` credentials. Enable `vector_fulfillment` only for a deployment that accepts approved SVG template sources, never retains order content, strips executable/external SVG references, and returns the strict path, font, hole, line-width, bridge-width, bounds, raster-embedding, repair, viewBox, and per-output evidence required by the Worker.
- Enable ordinary `product_video` only for a reviewed deployment that returns one H.264 MP4 with verifiable `ftyp`, duration/FPS/dimensions, complete pinned-input ordinals, playback and blank/corrupt-frame checks, subtitle safe-area evidence, and AAC/none audio metadata. Licensed soundtracks require a fixed license reference and rights attestation; processor logs and traces must exclude image bytes, prompts, license references, and result bodies.
- Enable `pattern_crop` and `print_extract` only for a deployment that returns strict per-input file mappings. Crop results must include normalized in-bounds source rectangles and contiguous crop indices without generative inference. Print extraction must return one file per input and expose every restored rectangle identically in technical metadata and review evidence with an explicit AI mark; do not enable a deployment that can suppress, blur, or rewrite this provenance.
- Enable `background_remove`, `super_resolution`, `outpaint`, `crop_compress`, `vectorize`, or `authorized_watermark_remove` only for a reviewed deployment that returns exactly one file and one strict quality record per pinned input. Require exact format, dimensions, DPI, color and alpha metadata; super-resolution must return the pinned 2×/4× dimensions and a marked full-image AI enhancement region, while outpaint and authorized watermark removal must return identical marked rectangles in file metadata and review evidence. Vector deployments must return path-count/closure evidence and self-contained SVG/EPS; Worker rejection of scripts, external references, `javascript:`, DOCTYPE, ENTITY, remote resources, partial output, or tool-key drift must remain enabled. Watermark removal additionally requires an approved authorized-domain asset and explicit rights attestation before any processor call.
- Enable a print-design tool only when the deployment returns the exact requested PNG count, a final-prompt SHA-256, complete pinned-input ordinals, per-file dimensions/alpha/AI provenance, prompt and content safety, text-review evidence, and a reproducibility seed for generative tools. `licensed_brand_fusion` requires a fixed license reference, `series_design` requires the pinned batch prompts, `canvas_extend` requires identical generated rectangles in metadata and review evidence, and seamless tools require direction-appropriate seam checks plus a tile preview. `seamless_stitch` is deterministic and must not return a seed or AI mark. Exclude prompts, license references, source bytes and result bodies from logs and traces.
- Enable `product_suite`, `title_draft`, `virtual_try_on`, or `background_replace` only for a deployment that reconciles every requested index as a successful file or isolated suite-slot failure and returns complete pinned-input coverage. Require product identity, print position, approved-fact, content-safety and text-review evidence on every image; title files must be small UTF-8 text whose bytes, SHA-256, character count, byte count, facts, keyword sources and platform-rule version agree. Try-on requires a fixed model-license reference and per-file verification. Background replacement requires identical marked rectangles in metadata and evidence plus `backgroundOnlyChanged`. Only product suites may return partial output. Exclude facts, keywords, prompts, license references, source bytes and result bodies from logs and traces.
- Enable `rights_risk_scan` only for a reviewed evidence provider with documented trademark/TRO/copyright/web source terms, refresh cadence, availability reporting, retention and model governance. The deployment must return one small JSON report per pinned input plus exact source versions, checked/valid-until timestamps, rule/model versions, per-hit evidence references and a fixed non-legal-opinion disclaimer. Unavailable sources must produce `unknown`, never `low`; visual similarity must remain a separate field. Verify Worker transitions high/unknown tasks to `blocked`, rejects partial or mismatched reports, writes versioned assessments, rejects/downgrades the source asset rights state, and that export rechecks high/unknown/expired reports. Exclude query images, search terms and evidence bodies from logs and traces.
- The order processor is a PII subprocessor: approve its data-processing terms, region, retention, deletion, incident response, and no-training policy before enablement. Restrict egress to its reviewed HTTPS endpoint, rotate the dedicated credential independently, and ensure request/response bodies are excluded from logs and traces.
- Legacy customer files created before the `order` asset domain must be copied through the controlled order-promotion path so the object prefix, domain, checksum, source reference, and audit evidence agree. Do not update only the database domain in place.
- S3 buckets are private and CORS is limited to deployed origins.
- Signed URLs expire in at most 600 seconds.
- `CLAMAV_HOST` resolves only on the private worker network; TCP `3310` is never Internet-facing, and the deployed scanner image is pinned to a reviewed supported release/digest.
- Worker memory and restart policy accommodate ClamAV signature reloads; a scanner outage fails closed and alerts on the customization-file scan queue.
- Webhook egress is restricted to approved HTTPS destinations with DNS/IP egress controls; loopback HTTP is development-only. Monitor retry and dead-letter counts without logging request bodies, tokens, or signing secrets.

## Rollback

Roll back application images first. Database migrations are forward-only by default; restore to a new database when data rollback is required, validate it, then switch connection configuration. Do not run destructive down migrations against the only production copy.

## Acceptance evidence

Attach CI URL, commit SHA, release-candidate manifest/checksums, migration version, backup manifest/checksum, browser extension versions, smoke-test results, PII retention/anonymization evidence when orders are enabled, ClamAV engine/signature evidence plus clean/infected fixture results, forecast/projection rebuild evidence, signed Webhook retry/dead-letter/replay evidence, and the approver to the release record. The CI manifest is deliberately marked `code-verification-only` and `not-recorded-by-ci` for authorized-provider acceptance; it cannot replace the live marketplace gates or authorize a tag.
