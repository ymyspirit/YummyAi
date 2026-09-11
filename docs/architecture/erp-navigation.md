# ERP navigation

The `(erp)/layout.tsx` route-group layout owns the shared sidebar, mobile menu and breadcrumb bar. Individual pages and loading boundaries only render business content. This keeps navigation mounted during route changes and failures. The legacy page shell classes remain available to their existing workspaces, with the shared layout overriding their previous two-column grid.

`apps/web/src/features/navigation/navigation-registry.ts` is the source of truth for primary destinations, function descriptions, search aliases, POD module URLs and common order filters. Both the sidebar and `/navigation` directory consume it. E2E navigation expectations import the registry rather than hardcoding a link count. The registry unit test inventories static ERP pages and fails for missing or non-existent destinations. The legacy redirect routes remain aliases, not duplicate menu entries.

The `/navigation` page is a static function directory. It reads no order records or customer data, and uses the same authenticated business pages as the sidebar. Function search runs locally over public UI metadata. It does not search order content, save browser history, change permissions or expose record identifiers. Detail breadcrumbs point back to their module index; global Listing navigation always goes to `/listings`.

Primary highlighting uses exact path matching, with explicit mappings for analysis, Listing, store and workflow details. Breadcrumbs also match supported query values, distinguishing POD modules, production product types and common order states. Unknown values fall back to the base page. Page titles follow the resolved location.

Desktop navigation is scrollable within a fixed-height sidebar. At 900 px and below, a full-height modal menu replaces it. Function search supports Ctrl/Cmd K, input focus on opening, arrow-key result selection, Enter, Tab containment, Escape and focus restoration. Native dialogs make the rest of the document inert while open. Page loading and API errors do not remove the shared navigation.

The modern shell adds a 76 px compact sidebar option without changing destinations or module expansion. Its hidden visual labels remain in the accessibility tree, and icon links/buttons have titles. The location bar offers light/dark/system controls; both preferences survive reloads in local browser storage. A compact preference never replaces the mobile menu. The theme is applied before first paint and switches independently of route or source-task state.

## Progressive disclosure (2026-09-08)

The sidebar shows the overview and six business modules instead of opening every destination simultaneously. `SIDEBAR_GROUPS` provides the fixed order: overview, commerce, creative, catalog, research, supply, insights. Module buttons use `aria-expanded` and `aria-controls`; inactive children are hidden from keyboard focus and the accessibility tree. One module opens at a time. Route changes open the relevant module automatically; inspecting another module does not change the current route. Desktop and mobile share the same grouping and labels.

Three shortcuts above the modules serve the confirmed daily workflow: import order reports, open creative projects, and view awaiting-shipment orders. Shortcut labels use task verbs and their destinations come from the same registry. These are fixed shortcuts, not fabricated recent-use data or a new permission system.

The function directory initially lists commerce destinations. Category selection narrows the list; an explicit All control exposes the complete directory. Nonempty search always spans all categories. Primary entries and auxiliary tools share a searchable registry; the sidebar only displays primary entries. The directory includes every registered depth, including modules nested beneath auxiliary tools.

The shared visual system and React Bits source attribution are documented in [ERP UI design system](erp-ui-design-system.md). Browser coverage verifies every destination by opening its module before navigating, rather than expecting every link to remain simultaneously visible.

The creative module includes **创意工作台** at `/creative-designs/canvas`, **生产文件与底稿**, and **商品套图**. Its `?brief=` parameter restores the selected ERP demand after reload; it does not change which navigation item is selected. Batch generation, image processing and proof tasks are auxiliary tools under the creative workbench and remain searchable. See [Infinite Canvas integration](../integration/infinite-canvas.md).

## Continuous workspaces (2026-09-09)

- `/orders` is **订单工作台**. The **履约队列** and **导入与定制** views share this route; the latter uses `?view=reports`. `/orders/import` redirects to this view for old bookmarks. Only the selected view loads its server data.
- A reviewed report line opens `ProductionEditorSession` in the current order view. The order number, SKU, quantity and customization version remain visible, with the original requirements available in a disclosure. Only projects pinned to this line and its current reviewed version are offered. Existing matching drafts reopen automatically. New drafts must keep the order source attached.
- A creative result opens the same editor inside its current creative project. The editor is restricted to the associated production project. Configuring a general process template also happens in-place; returning refreshes eligible approved templates.
- Returning preserves mounted parent state: selected order, search, batch, pagination, creative selections and result filters. The session owns one same-route history entry, so browser Back returns to its originating task. Unsaved document/contour changes require confirmation; saving creates an immutable version. Sidebar and tab links also guard unsaved changes. Background reads do not block leaving a standalone editor.
- Refreshing restores saved data, not unsaved edits. The native leave-page warning remains active. Production editor versions, customer-source pins, reviews and backend preflight rules are unchanged.
- Original Infinite Canvas remains a separate editing window connected through the existing public plugin. It retains the current ERP brief and returns results to that brief. Its upstream code and plugin protocol are unchanged by this navigation work.
- Report review, creative approval and digital-file generation do not assert physical production or shipment completion. The fulfillment queue remains responsible for those operational transitions.

The three shortcuts now point to report import, creative projects and awaiting-shipment orders. Independent production product links remain discoverable in search, while the editor itself has one product selector at project creation instead of duplicate route-changing product tabs.

Local report/production BFF writes accept an exact numeric-loopback Host in development when Next normalizes the internal Request URL to localhost. Cross-site, protocol/port mismatches and production origin mismatches remain rejected.

Validation: Web unit suite, Web typecheck/build, lint on touched files, and `pnpm test:e2e navigation-workspace`. The browser suite visits every primary destination and verifies task searches, query-specific navigation, history, focus behavior, desktop layout and the 390 px mobile menu.
