# Production editor local verification — 2026-09-08

This records local feature verification for `/pod-workbench/production-editor`.
It is not a release-candidate declaration or factory acceptance. The working tree
also contains the preceding Amazon report import implementation and other existing
workspace material.

## Verified behavior

- Two product documents and interfaces: shaped pillows and circular tire covers.
- Authenticated project creation, private source upload, original-file preservation,
  reduced previews, immutable versions, conflict detection, review and worker output.
- Manual smooth contours and joined bottom barcode tabs, white sewing margin,
  single/double back panels, correctly oriented separate text, and curved lettering.
- Output PNG/JPEG/TIFF, embedded sRGB, physical resolution metadata and transparent
  PNG/TIFF boundaries. JPEG explicitly uses an opaque background.
- A real synthetic 7913 × 7913 PNG render at 300 PPI, with opaque center and
  transparent corners. No customer artwork is used as a committed test fixture.
- Browser workflow uses real API authentication, ClamAV, private object storage,
  PostgreSQL, Redis and the production-render Worker. It uploads a synthetic image,
  drags it on Fabric, adds curved text, saves/reviews, downloads PNG and decodes the
  result to verify 283 × 283 pixels at 72 PPI for a 100 mm test document and its alpha.
- Pillow browser checks preserve edited contour nodes and keep output blocked
  while barcode dimensions and manufacturing confirmations are absent.
- Desktop 1440 px and mobile 390 px checks have no document-level horizontal overflow.
- Browser and Node font-entry compatibility is verified through the actual API and
  worker path, beyond Vitest's module transformation.

## Checks

| Check | Result |
| --- | --- |
| Database migration 0064 + Drizzle schema check | Passed |
| `pnpm typecheck` | All 14 package tasks passed |
| `pnpm test` | All 13 package tasks passed, plus rule/tool checks |
| `pnpm build` | Web production build and extension build passed |
| Production editor API/worker integration | 14 tests passed |
| `pnpm test:e2e production-editor` | 2 real browser tests passed |
| Final `pnpm test:e2e production-editor amazon-report` | All 3 browser tests passed after final UI fixes |
| `pnpm exec eslint apps packages tools --max-warnings=0` | Passed |
| Full `pnpm test:integration` | 401 passed, 1 existing date-window failure |
| Full `pnpm lint` | Existing artifact-generator lint errors remain outside feature scope |

The unrelated integration failure is
`apps/api/src/supplier-performance/supplier-performance.integration.test.ts`:
its fixed July–September 1 window / September 2 cutoff excludes newly created
September 8 evidence. It expects `complete / 9900` but receives `incomplete / null`.
That fixture and unrelated artifact generators were not changed.

## Remaining operational inputs

The factory must supply/confirm actual measurement boundaries, barcode tab width
and height, sewing allowance applicability and the narrow-part measurement basis.
The editor preserves these as explicit parameters and confirmations. Existing
flattened artwork cannot be recovered into original photo/text layers; artists use
source files or manually prepared cutouts. No orders have been sent to a factory,
and no Amazon publishing or shipment-state writeback is performed here.
