# ERP navigation

## Split-navigation interaction prototype

`/navigation-preview` is a separate, non-indexed navigation prototype. It reuses
the real destination registry, Lucide icons and ERP theme tokens. Its fixed module
rail changes the adjacent page list on click; only selecting a page changes the
preview URL (`?page=<destination-id>`). The approved interaction is now integrated
into the shared ERP shell; this route remains an independent layout illustration.

Favorites and page-panel collapse are stored only in the isolated browser key
`yummyai:navigation-preview:v1`. They contain public destination IDs and a boolean,
with in-memory fallback if browser storage is unavailable. A mobile modal drawer,
keyboard function search, browser Back/Forward and explicit links to the real ERP
support evaluation of the order → production-artwork → supplier route. The main
content is visibly labeled as a layout illustration; the prototype reads no
business records and creates no orders, assets, stock or supplier data.

## Current ERP navigation

The order group has five task destinations: `/orders`, `/order-artwork`,
`/production`, `/shipments` and `/after-sales`. Each center owns
its primary status filter. Query parameters preserve filters, pagination, and the
selected order line (`line`); detail journey links carry that line across centers.
The report importer remains `/orders?view=reports` and returns to operator review.
Shared editor sessions open the associated project directly and keep immutable
work-revision requirements visible. See [order centers](../integration/order-centers.md).

Independent `/print-library` belongs to creative design. The catalog group owns
`/product-specifications` (one SPU with its child specifications), `/product-development`
(sales SKU recipes and channel packages), `/pod-workbench/mockup-batches`, and
`/process-library` (generic process templates). Existing product-plan and Listing
destinations remain. See [identity model](artwork-product-sales-model.md).

The supply group exposes `/suppliers` as **供应商档案**, separate from calculated
supplier performance. Stores, inventory and procurement expose primary creation
buttons even when their datasets are empty. Native modal forms retain the parent
draft while related supplier, warehouse, location or stock records are created.

`/suppliers/<id>` retains the supplier module breadcrumb and shows its supplied
products. Product catalog rows link to `?plan=<id>#product-suppliers`; both views
use the same [versioned supply directory](../integration/product-suppliers.md).
Supply terms and procurement drafts distinguish custom orders and FBA replenishment.
See [manual operations](../integration/manual-operations.md).

Desktop navigation uses a fixed 104 px module rail and a 216 px page panel.
Selecting a module changes only the adjacent page list; it does not navigate or
move other module buttons. Hover provides visual feedback without opening or
closing panels. Selecting a page follows its original ERP URL, including the
existing unsaved-work guards. The current page and its owning module remain
marked; route changes reveal the owning module unless navigating between saved
pages inside Favorites.

Page stars add or remove public primary-destination IDs in
`yummyai.ui.favorite-pages`. Favorites persist across reloads and synchronize
between browser tabs, with validation and an in-memory fallback when storage is
unavailable. Empty favorites show instructions for adding a page. No business
records, tenant identifiers, usage history or marketplace data are stored here.
The preview's separate preference key is not used by the ERP shell.

The creative group includes creative projects, My Canvas, image/video workbenches,
prompts and assets alongside production files and mockups. AI model configuration
lives in a final Settings group. These routes share the ERP shell; the embedded
canvas runtime renders content without a second application navigation. Creative
tool routes preserve a selected workflow step through the ERP scope selector.
See [creative studio architecture](../integration/creative-studio.md).

The `(erp)/layout.tsx` route-group layout owns the shared sidebar, mobile menu and breadcrumb bar. Individual pages and loading boundaries only render business content. This keeps navigation mounted during route changes and failures. The legacy page shell classes remain available to their existing workspaces, with the shared layout overriding their previous two-column grid.

`apps/web/src/features/navigation/navigation-registry.ts` is the source of truth for primary destinations, function descriptions, search aliases, POD module URLs and common order filters. Both the sidebar and `/navigation` directory consume it. E2E navigation expectations import the registry rather than hardcoding a link count. The registry unit test inventories static ERP pages and fails for missing or non-existent destinations. The legacy redirect routes remain aliases, not duplicate menu entries.

The `/navigation` page is a static function directory. It reads no order records or customer data, and uses the same authenticated business pages as the sidebar. Function search runs locally over public UI metadata. It does not search order content, save browser history, change permissions or expose record identifiers. Detail breadcrumbs point back to their module index; global Listing navigation always goes to `/listings`.

Primary highlighting uses exact path matching, with explicit mappings for analysis, Listing, store and workflow details. Breadcrumbs also match supported query values, distinguishing POD modules, production product types and common order states. Unknown values fall back to the base page. Page titles follow the resolved location.

Breadcrumbs follow **overview → business module → page → detail**, omitting levels
that do not apply. Business-module links open `/navigation?group=<module-id>` with
the corresponding category selected. SPU (`?spu=`) and sales SKU (`?sku=`) details
reuse their page's authorized, already-loaded record labels; the shared navigation
does not fetch business data or display raw record IDs. Loading or unavailable
records retain a generic detail label and a working parent link. Parent links
remove the selected record while retaining list filters and pagination. The product
workspace reads selection from the URL so breadcrumb links, reload, and browser
Back/Forward agree with the visible page. Ordinary filters do not add breadcrumb
levels. The last item alone has `aria-current="page"`; long labels wrap on mobile.

Desktop navigation is scrollable within a fixed-height sidebar. At 900 px and below, a full-height modal menu replaces it. Function search supports Ctrl/Cmd K, input focus on opening, arrow-key result selection, Enter, Tab containment, Escape and focus restoration. Native dialogs make the rest of the document inert while open. Page loading and API errors do not remove the shared navigation.

The page panel can be collapsed to leave the 104 px module rail with visible labels. Selecting a desktop module reveals the panel again. The existing `yummyai.ui.sidebar` preference stores this choice; the location-bar toggle and page-panel toggle stay synchronized. The location bar offers light/dark/system controls; preferences survive reloads in local browser storage. Mobile uses a full-height two-column modal drawer without overwriting the desktop collapse choice. The theme is applied before first paint and switches independently of route or source-task state.

## Module and page navigation

The module rail shows Favorites, overview, six business modules and Settings without showing every page simultaneously. `SIDEBAR_GROUPS` provides the fixed business order: overview, commerce, creative, catalog, research, supply, insights, settings. Module buttons use `aria-pressed` and `aria-controls`; inactive page lists are hidden from keyboard focus and the accessibility tree. The module rail and page list scroll independently. Desktop and mobile share the same grouping and labels, with 44 px minimum touch targets in the mobile drawer.

Three shortcuts at the bottom of the page panel serve the confirmed daily workflow: import order reports, open creative projects, and view awaiting-shipment orders. Shortcut labels use task verbs and their destinations come from the same registry. These remain fixed task shortcuts alongside the user's editable Favorites.

The function directory initially lists commerce destinations. Category selection narrows the list; an explicit All control exposes the complete directory. Nonempty search always spans all categories. Primary entries and auxiliary tools share a searchable registry; the sidebar only displays primary entries. The directory includes every registered depth, including modules nested beneath auxiliary tools.

The shared visual system and React Bits source attribution are documented in [ERP UI design system](erp-ui-design-system.md). Browser coverage verifies every destination by opening its module before navigating, rather than expecting every link to remain simultaneously visible.

The creative module includes **创意项目** at `/creative-designs/canvas`, the five integrated studio pages, **生产文件与底稿**, and **商品套图**. Its `?brief=` parameter restores the selected ERP demand after reload; it does not change which navigation item is selected. Batch generation, image processing and proof tasks are auxiliary tools under the creative workbench and remain searchable. See [creative studio integration](../integration/creative-studio.md).

## Continuous workspaces (2026-09-09)

### Record drawers (2026-09-15)

Orders, artwork records, SPUs/specifications and sales SKU details use the shared
native `TaskDrawer`. The original list remains mounted beneath the modal: filters,
pagination, selection, scroll and the opening control remain available on return.
The drawer locks background scrolling, contains keyboard focus, restores focus on
close and provides fixed navigation/actions. Browser Back/Forward and reload follow
the record URL. Dirty or submitting forms guard close, Escape, traversal and links;
a failed save retains the submitted inputs. Prerequisite links explicitly backed by
the tab's task draft can return without discarding that draft.

Order journey steps switch `detailMode` inside the current center and retain `line`,
the frozen `queue` and list filters. Opening/switching catalog details does not read
the list again. Print/SPU text filtering uses the loaded catalog; sales SKU queries
still use server filtering and pagination. Successful saves refresh the relevant
data with the current list mounted. Detail data is never treated as an approval.

Print `artwork`, SPU `spu`, and sales `sku` parameters select a drawer. `form`,
`editSpu`, `specificationVersionId`, `compose` and `artworkVersionId` restore its
current form. Print-to-product combination can run in the print drawer with the
exact artwork version selected. A drawer shows one task at a time. Batch specification
binding and production-canvas editing retain full workspaces and return to the
originating record. No new API routes or persistence domains are introduced.

UI regression command (stop the active Web dev server first):
`pnpm exec playwright test --config apps/web/playwright.task-drawers.config.ts`.
The suite uses real ERP components with in-memory synthetic transport, so it creates
no business rows, files, AI jobs or external side effects.

- `/orders` is **订单中心**. The **订单报告导入** entry uses `?view=reports`; `/orders/import` redirects there for old bookmarks. Only the selected view loads its server data. The six centers described below divide review, artwork, production, shipping, after-sales and print profiles across stable routes.
- Operators edit a report line in the order center and explicitly push an immutable requirement revision. Its artwork task opens `ProductionEditorSession` in the artwork center. The order number, SKU, quantity and pushed requirements remain available. Only projects pinned to this work item and requirement revision are offered. Existing matching drafts reopen automatically; new drafts keep the pinned order source attached.
- A creative result opens the same editor inside its current creative project. The editor is restricted to the associated production project. Configuring a general process template also happens in-place; returning refreshes eligible approved templates.
- Returning preserves mounted parent state: selected order, search, batch, pagination, creative selections and result filters. The session owns one same-route history entry, so browser Back returns to its originating task. Unsaved document/contour changes require confirmation; saving creates an immutable version. Sidebar and tab links also guard unsaved changes. Background reads do not block leaving a standalone editor.
- Refreshing restores saved data, not unsaved edits. The native leave-page warning remains active. Production editor versions, customer-source pins, reviews and backend preflight rules are unchanged.
- Original Infinite Canvas remains a separate editing window connected through the existing public plugin. It retains the current ERP brief and returns results to that brief. Its upstream code and plugin protocol are unchanged by this navigation work.
- Report review, creative approval and digital-file generation do not assert physical production or shipment completion. The production and shipment centers record those operational transitions separately.

The three shortcuts now point to report import, creative projects and awaiting-shipment orders. Independent production product links remain discoverable in search, while the editor itself has one product selector at project creation instead of duplicate route-changing product tabs.

Local report/production BFF writes accept an exact numeric-loopback Host in development when Next normalizes the internal Request URL to localhost. Cross-site, protocol/port mismatches and production origin mismatches remain rejected.

Validation: Web unit suite, Web typecheck/build, lint on touched files, and `pnpm test:e2e navigation-workspace`. The browser suite visits every primary destination and verifies task searches, query-specific navigation, history, focus behavior, desktop layout and the 390 px mobile menu.
