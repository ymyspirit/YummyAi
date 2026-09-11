# Production artwork editor

The production editor at `/pod-workbench/production-editor` handles two distinct
product types: `shaped_pillow` (异形抱枕) and `tire_cover` (定制备胎罩). An order report
that has been reviewed can open the editor through **制作生产图**. The POD production
artwork tab also provides separate entries for both products.

The standalone editor keeps the selected `projectId` and, for a historical copy,
`versionId` in its URL. Reloading resumes that saved document. Saving a new version
or selecting another project clears the historical-version parameter; deleting a
project clears both identifiers. Embedded order and creative workflows keep their
own URLs and navigation context. Unsaved artwork still requires an explicit save.

## Product specifications

Documents use millimetres for geometry and a separate output DPI. Draft settings
are not supplier approvals. Save the exact specification and confirmation state
in each immutable version.

- Shaped pillows have a manually editable, closed contour, a white sewing margin,
  an external black cutting line, a bottom blank barcode tab and a paired back
  panel. The supplier's supplied example uses 150 DPI, a 200 px white margin and
  a 6 px black line. At 150 DPI these are approximately 33.8667 mm and 1.016 mm.
  Applicability to other sizes, the longest-side measurement boundary, the barcode
  dimensions and the basis for the minimum 50 mm narrow-part requirement remain
  explicit confirmations. Single-sided printing creates a mirrored blank back
  contour; double-sided printing mirrors artwork while keeping separate text
  readable. Text baked into a photograph requires manual handling and review.
- Tire covers use a circular image region, transparent exterior, movable artwork,
  straight or curved text and optional explicitly measured openings. The supplied
  reference was 7913 × 7913 px, approximately 300 DPI and 670 mm across. This is a
  reference configuration, not a universal mapping from tyre sizes. Pillow rules
  are not applied to this product.

The existing flattened PNG examples are reference outputs, not recoverable layered
designs. Designers supply source images, fonts and contour data. The editor does
not claim automatic photographic retouching or automatic factory approval.

## Pillow preparation workflow

### Customer requirements and cutout tools

The current reviewed Amazon Custom options remain visible inside the editor.
Only explicit size/style mappings populate pillow parameters: `Only Face` means
the complete head, `Single-sided Printing` means a blank mirrored back, and the
eight supported inch sizes set the declared longest side. Unknown/conflicting
values stay visible for manual confirmation. Existing artwork is not silently
rescaled. Project-only links load and verify the project's pinned source too.

Select an image layer and open **抠图与修边** in the same workspace. A box plus
positive/negative points gives SAM 2.1 a region to segment. **套索保留**, erase,
restore, brush softness, undo/redo, zoom, original comparison and checker/white/
black backgrounds work without an automatic model. Applying the cutout creates a
new private PNG at the EXIF-oriented original dimensions, changes only that image
layer's asset reference, invalidates review confirmations and leaves the original
asset untouched. Saving creates another immutable document version.

Editable recipes (automatic PNG mask plus bounded normalized brush/polygon
operations) are stored in encrypted asset metadata with the original asset ID.
Reopening a derived cutout retrieves that original, so restore strokes can recover
previously removed pixels. Browser preview and backend output share the mask SVG
builder; the backend replays operations at original resolution. Original RGB and
existing transparency are preserved. SAM's binary mask is an initial selection.
The separate **毛发边缘细化** step uses the original photo and current edited mask
to calculate fractional alpha with local ViTMatte. A narrow/wide boundary band can
refine the whole edge; **毛发修复** brush marks refine only the painted regions,
including long whiskers outside the initial box. Unmarked mask pixels stay fixed.
Inference uses lossless EXIF-oriented pixels, at most 2048 pixels per side, in
overlapping 768px tiles to bound CPU memory. This is not full-resolution matting
for larger originals. Color pixels are not generated or altered. **清理半透明残影**
optionally remaps low alpha continuously, keeps solid interiors, and is an
undoable recipe operation; excessive cleanup can erase faint hair. Black/white
background comparison and human inspection remain necessary.
Images above 40 million pixels are rejected by cutout endpoints, while existing
upload/export limits remain unchanged. Empty and invalid masks are rejected.

Authenticated routes under `/v1/production-editor/projects/:id/images/:imageId`:

- `GET /cutout`: original image view, saved recipe, local engine availability.
- `POST /segment`: expected current document version, normalized box and points;
  returns a grayscale PNG mask, and never publishes a new asset.
- `POST /refine`: expected current document version, current recipe, boundary
  radius (0.001–0.05 of the shorter image side), and up to 80 brush marks/8000
  total points. Returns a grayscale alpha mask; no asset or version is saved.
  The same source/version/expiry authorization is checked before and after
  inference. The derived source must be resolved with `GET /cutout` first.
- `POST /cutout`: expected version, output name and recipe; creates the derived
  private asset. Call with the original ID returned by `GET /cutout`.

Existing tenant/RLS checks, permissions, source-version validation, virus scanning,
encryption and order-data expiry apply to derived images and recipes. The local
web proxy exposes these operations without adding a navigation page.

Install the optional local model on Windows/Python 3.13:

```powershell
pwsh -NoProfile -File tools/scripts/setup-segmentation.ps1
pwsh -NoProfile -File tools/scripts/setup-matting.ps1
```

The script pins the upstream SAM 2 revision and checkpoint SHA-256, installs into
ignored `output/segmentation`, and runs a synthetic prediction before writing the
`.ready` marker. `-Runtime cu128` selects the larger CUDA wheel; CPU is the default.
No upstream source is modified. The optional SAM CUDA extension is disabled.
`PRODUCTION_SEGMENTATION_PYTHON` and `PRODUCTION_SEGMENTATION_CHECKPOINT` override
the default executable/checkpoint paths; put the checked `.ready` marker beside
the checkpoint (replace `.pt` with `.ready`). Run `tools/segmentation/check.py`
with that Python/checkpoint before enabling it.

At runtime the API sends only the selected image's reduced pixels and selection
through a local subprocess's stdin. It does not send customer images to an external
provider, open a listening port or write temporary customer images. Only one local
prediction runs at a time; a 95-second timeout and bounded output apply. Keep this
local MVP on one API process; a multi-instance deployment needs a shared job queue
and concurrency limit before scaling. A missing/busy model returns an explicit
error while manual tools remain available. Dependency/checkpoint downloads require
internet during installation, not during image processing.

The matting installer reuses this Python/PyTorch environment and pins Transformers
4.57.6 plus the [official ViTMatte small model](https://huggingface.co/hustvl/vitmatte-small-composition-1k)
at revision `6a58ad7646403c1df626fbd746900aec7361ea1d`. Its safetensors SHA-256 is
`bda9289db1bb6762d978b42d1c62ae3f34daf7497171a347a1d09657efd788cb`.
The model card declares Apache-2.0; the upstream implementation declares MIT.
`check-matting.py` verifies synthetic strands, fractional alpha and known pixels
before creating a separate readiness marker. Runtime inference explicitly uses
local files, safetensors, offline mode and disabled telemetry. It has its own
single-process concurrency guard, a 95-second timeout and 2 MB mask limit. Keep
one API instance for this local deployment. Unavailable or failed inference leaves
the designer's current recipe and repair marks intact; a retry is explicit.

Regression checks cover the full edited trimap, fractional alpha, residue cleanup,
original RGB, tenant/asset/version isolation, failure preservation and saved
recipes. The refinement E2E runs the real local model when installed and tests
the disabled-engine/manual-tool path otherwise; one explicitly owned 503 fault
checks retry handling. No customer artwork is checked into fixtures.

Primary implementation references: [SAM 2](https://github.com/facebookresearch/sam2)
and its [installation guidance](https://github.com/facebookresearch/sam2/blob/main/INSTALL.md).

### Size and outline preparation

The shaped-pillow workspace offers the supplied **10, 12, 14, 16, 18, 20, 22 and
24 inch** order sizes. Selecting a size records the declared finished longest side
in millimetres; it does not silently resize an existing drawing or confirm factory
measurements. **按规格生成抱枕轮廓** is a separate, undoable operation: it scales the
selected image's visible alpha bounding box to the declared longest side, scales
other artwork uniformly to preserve composition, and constructs a new body contour
outside the image using the current white-border setting. This follows the supplied
diagram's subject-layout example; physical sewn dimensions still require review.
**按当前图案尺寸生成** keeps the current artwork scale.

Outline preparation reads only the tenant-authorized reduced image preview. It
uses alpha at the placed rotation/flip, a bounded raster distance transform, and
closed polygon simplification (at most 180 smooth nodes). The body bounds are
measured again after smoothing so curve extrema cannot leave the output sheet.
The small sampling allowance protects the subject during simplification. This is a starting contour, not exact
original-pixel tracing or background removal. Disconnected subjects are rejected
instead of silently discarding one; interior transparent holes do not become
internal cutting holes. The original asset/version remains pinned for production.
Manual node editing and the existing immutable save/review flow remain available.

The barcode tab must intersect the lowest body boundary. Side/high placement
produces `barcode_not_at_bottom` and blocks both preview rendering and production;
the UI can move its X anchor to the lowest body while retaining the supplied width
and height. The tab has no editable vertical or side-placement option. Actual
barcode dimensions remain required inputs because the supplied diagram does not
state them.

**正反片排版** displays the current scene immediately using shared contour and
font-path functions. It mirrors the back image, keeps separate text readable, and
leaves a single-print back white. It is not a worker export and cannot enable the
production visual-review confirmation. **测量细窄处** measures two selected points
in millimetres and flags a segment below the current minimum (normally 50 mm).
Measurements and panning are view state, not exported artwork or proof that every
neck/limb meets the manufacturing rule.

## Boundaries

- `packages/contracts/src/pod/production-editor.ts` owns scene and preflight schemas.
- `packages/contracts/src/pod/production-editor-api.ts` owns API transport schemas.
- `packages/production-editor` owns geometry, font-outline layout and rendering.
- `apps/web/src/features/production-editor` owns the Fabric.js editing interface.
- API commands run under authenticated tenant membership and forced database RLS.
- Long-running output jobs use `production-editor-render`; job payloads contain
  only the render ID. Source pixels, text and scene documents never enter Redis.
- Originals, reduced previews, fonts and rendered output are private. Each project
  has a wrapped data-encryption key. Source-order projects inherit their report's
  retention deadline. Expiry, anonymisation and project deletion erase that key.
  Standalone projects remain available until explicitly deleted.
- Exporting a draft preview and approving production output are separate actions.
  Missing specifications and manual confirmations block production readiness.
  Every saved scene gets a new immutable version; concurrent saves must supply
  the current expected version and conflicting edits cannot overwrite it.

The browser edits reduced previews. Production rendering resolves private original
assets and pinned fonts on the server, converts text to paths, and generates the
requested PNG, JPEG or TIFF with actual pixel dimensions and resolution metadata.
There is no arbitrary URL fetch or caller-supplied SVG execution during rendering.
The decoded output is capped at 100 million pixels. PNG/TIFF can preserve alpha;
JPEG requires an explicit opaque background.

Large photographs can exceed libxml's default attribute-length limit after PNG
normalization and base64 embedding. Only the internally generated SVG uses
Sharp's `unlimited` XML mode; customer raster decoders retain their normal safety
checks and the explicit pixel limits. Inline image data is capped at 128 MiB,
including repeated layers and double-sided copies, and the complete generated
SVG is capped at 132 MiB. Excess data returns `render_asset_limit`; arbitrary
uploaded SVG and external image URLs remain unsupported. The regression fixture
uses an incompressible synthetic PNG above 10 MiB and verifies both preview and
production, plus rejection of oversized repeated layers. See the
[Sharp constructor reference](https://sharp.pixelplumbing.com/api-constructor/).

## Local development and acceptance

### Designer layout tools

Layout tools remain in the existing production workspace and use the same scene
contract and immutable save command. There are no additional routes, schemas,
storage domains or upstream infinite-canvas changes. Duplication references the
same private asset; replacement adds or reuses a project asset without overwriting
the original. Every composition change clears visual and back-text confirmation.

Image alignment measures alpha bounds from an authorized reduced preview
(alpha greater than 8/255, maximum 1600 pixels per side), then applies the scene's
scale, flip and rotation. Text alignment uses the pinned font and the same glyph
paths as the renderer. Bounds and parsed fonts are held only in a workspace-local
memory cache. These are editing aids, not production-resolution contour analysis.
The alignment rectangle excludes the pillow barcode and white border or uses the
tire safety inset. Fitting within that rectangle cannot guarantee containment in
an irregular outline or around a camera hole. Existing contour and manufacturing
checks remain mandatory. Background cover is restricted to opaque tire artwork,
resets its rotation and uses the full circular diameter's bounding rectangle.

Keyboard commands are scoped to the active workspace and disabled in editable
fields, cutout editing and unfinished contours. Locked layers reject editing,
reordering, deletion and duplication. Layer count and scene size limits remain
enforced; preflight can select an offending layer in the current workspace.

The `production-editor-tools.spec.ts` acceptance test uses synthetic images and
real API, storage and worker paths to verify transparent-subject positioning,
keyboard and lock boundaries, replacement, arc text, save/reopen, backend preview
and desktop/mobile layout. Existing tests verify final pillow/tire raster output.

Use Node 24.17.x and pnpm 11.10.x and follow
[`local-development.md`](../operations/local-development.md). The editor requires
API, Web, Worker, PostgreSQL, Redis, private object storage and ClamAV for uploads.
Apply migration `0064_production_editor` before opening the route. Fabric's optional
Node `canvas` build is disabled: the browser uses Fabric and server export uses
the dedicated Sharp renderer.

Font `geist_regular` uses the bundled `Geist-Regular.ttf`; its licence is retained
alongside the font. Uploaded fonts must contain the requested glyphs; a missing
font or unsupported glyph must not silently become a different font in production.

Acceptance checks cover product-rule separation, output dimensions/DPI/alpha,
mirrored back panels, preserved text direction, font failures, save conflicts,
cross-tenant reads, order-source version changes and cryptographic expiry. Browser
checks must exercise real editing and visible downloads at desktop and 390 px,
using labelled synthetic data instead of committing customer order files.
