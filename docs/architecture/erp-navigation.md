# ERP navigation

`/business-tasks` defaults to the [workflow inbox](../integration/workflow-task-inbox.md).
The existing order/sales modes remain in its business-object selector; old targets
without an object still resolve to orders. Workflow links preserve URL filters and
open their actual node without prefetch or execution side effects.

## Shared sidebar and task workspaces

The ERP uses one 244 px sidebar. The product lifecycle comes first; supporting
creation, analysis and configuration tools follow it. The shared layout remains
mounted during loading, failures and route changes.

| Group | Primary destinations |
| --- | --- |
| 工作台 | 运营总览, 业务任务, AI 任务工作台 |
| 商品与上架 | 商品库, 印花库, 销售 SKU 组合, 商品套图, 上架工作台, 刊登管理 |
| 订单与履约 | 订单中心, 制图中心, 生产中心, 物流下单, 发货中心, 售后中心 |
| 创作工具 | 商品图文项目, 创意项目, 我的画布, 生图工作台, 视频创作台, 提示词库, 我的资产, 生产文件与底稿 |
| 研究与经营 | 研究资料库, 竞争店铺, 财务利润, 广告与 VOC |
| 供应链 | 供应商档案, 库存台账, 采购补货, 供应商绩效, 渠道库存 |
| 知识与规则 | 运营知识库, 规则中心 |
| 系统配置 | 店铺运营, 工作流中心, 履约配置, AI 模型配置, 数据与集成 |

Group buttons expand in place, use `aria-expanded` and `aria-controls`, and leave
the current route unchanged. Closed groups are inert and hidden from keyboard
focus and assistive technology. Route changes reveal the owning group. The three
workbench destinations stay visible. Favorites are a separate collapsible section.
The desktop sidebar can collapse to 68 px; selecting a group expands it again.
At widths of 900 px or below it becomes a single-column modal drawer. Mobile
selection does not overwrite the desktop compact preference.

The design adapts the open-source [shadcn/ui sidebar pattern](https://ui.shadcn.com/docs/components/aria/sidebar)
and [Next Shadcn Dashboard Starter](https://github.com/Kiranism/next-shadcn-dashboard-starter)
to the existing React, native-dialog, CSS and Lucide components. It adds no UI
framework dependency. White surfaces, neutral dividers and blue active states use
shared ERP tokens. Groups animate height, dialogs animate entry and exit, controls
provide hover/press feedback, and reduced-motion preferences disable movement.
The light theme is the initial default; explicit dark/system preferences remain
supported and are applied before paint.

The `(erp)/layout.tsx` layout owns the shell and breadcrumb bar.
`navigation-registry.ts` is the source of truth for destination IDs, groups, public
search metadata and parent relationships. The sidebar, directory and search all
consume it. Old destination IDs and URLs remain valid. Sales SKU combinations,
mockup batches and logistics purchasing are now primary destinations. Process
templates, historical product plans and specialized POD tools stay searchable as
auxiliary functions. The old `group=research` directory link maps to insights.

`/business-tasks` has a direct workbench entry. `/ai-tasks?business=1` redirects to
it while preserving other query parameters. Business and AI analysis tasks share
a persistent two-item workspace navigation. Opening either workspace only reads
existing records; model calls, production review, export and purchase controls
keep their existing business permissions and gates.

## Search, preferences and breadcrumbs

Search at the top of the sidebar supports Ctrl/Cmd K, initial input focus, arrow
selection, Enter, Tab containment, Escape and focus restoration. Search uses only
public route metadata and task vocabulary, never customer/order content. Native
modal dialogs make the background inert. `/navigation` offers the complete grouped
directory plus report-import, creative-project and awaiting-shipment shortcuts.

Public destination IDs in `yummyai.ui.favorite-pages` survive reloads and synchronize
across tabs. Unknown or duplicate IDs are filtered. Theme and compact preferences
use `yummyai.ui.theme` and `yummyai.ui.sidebar`. All controls have an in-memory
fallback when browser storage is unavailable. No tenant data or customer records
are persisted by navigation.

Breadcrumbs follow overview → group → page → detail, omitting redundant levels.
Group links open the corresponding directory category. SPU, sales SKU and sales
plan breadcrumbs use authorized loaded labels and preserve filters/pagination in
the return link. Raw record IDs do not become labels. The sidebar always links to
the original page index; domain handoffs and unsaved-work guards retain their
source object, query parameters and immutable versions.

`/navigation-preview` remains a historical, non-indexed two-column prototype. Its
own preference key and synthetic content are isolated; it does not describe the
current ERP shell and is not acceptance evidence for this redesign.

## Verification

Run `pnpm test:e2e:order-daily --suite=navigation` after stopping the normal Next/API
dev servers. The suite owns a disposable database, bucket and Redis and disables
all demo flags. It visits every primary destination, verifies filtered detail
return paths, search, keyboard operation, favorites, task-route compatibility,
compact/mobile behavior, themes and blocked storage. Screenshots under
`tmp/navigation-e2e` cover real desktop and narrow routes. The runner cleans its
resources even on failure. Restore normal services with `pnpm start:local`.

Local verification on 2026-10-13: repository lint, typecheck, unit suites and build
passed; the real navigation suite passed all 10 cases and the isolated AI-task
workflow regression passed. Desktop, 390 px mobile, compact-sidebar and dark-theme
screenshots were reviewed. The disposable databases, buckets and Redis instances
were removed, normal services were restarted, and `pnpm check:local-runtime` passed.
This is local verification, not a release or CI assertion.

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

Validation: Web unit suite, Web typecheck/build, lint, and `pnpm test:e2e:order-daily --suite=navigation`. The browser suite visits every primary destination and verifies task searches, query-specific navigation, history, focus behavior, desktop layout and the 390 px mobile menu.
