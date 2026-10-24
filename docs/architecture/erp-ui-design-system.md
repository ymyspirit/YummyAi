# ERP interface system

Updated 2026-09-09. Scope: shared ERP shell, typography, semantic colors, appearance preferences, operational tables/forms, overview, orders, creative workbench and production editor. Business data, production dimensions, tenant permissions, and export gates continue through the existing services.

## Design inputs

- UI UX Pro Max: use data-dense dashboard and hierarchical exploration guidance with density 8, motion 2, variance 3. The generic design-system query also suggested oversized landing-page typography; that recommendation does not fit the project's operational ERP boundary and was not adopted.
- [Next Shadcn Dashboard Starter by Kiranism](https://github.com/Kiranism/next-shadcn-dashboard-starter) is the selected layout reference. Its Next.js 16 / React 19 stack matches this application; its neutral inset content surface, sidebar, theme controls and table/form hierarchy fit an internal ERP. The upstream project has an [MIT license](https://github.com/Kiranism/next-shadcn-dashboard-starter/blob/main/LICENSE). This is a visual adaptation within the existing application, not a replacement installation: no upstream authentication, billing, demo data, router, or UI dependencies were copied. The hosted dashboard demo redirected to sign-in during research; its gated operations were not tested.
- [Sat Naing's Shadcn Admin](https://github.com/satnaing/shadcn-admin) was also reviewed. Its Vite/TanStack Router foundation is less suitable as an application replacement for this Next.js checkout. Existing ERP services and state remain authoritative.
- [IBM Carbon left navigation](https://carbondesignsystem.com/components/UI-shell-left-panel/usage/): persistent navigation, explicitly expandable submenus, and at most two sidebar levels. Finer product choices remain in the workspace or function directory.
- [React Bits Spotlight Card](https://reactbits.dev/components/spotlight-card): adapted TypeScript/CSS source in `apps/web/src/components/react-bits`. The repository's full MIT + Commons Clause notice is retained in that directory. No unrelated npm package named `react-bits` is installed.

## Visual rules

- `apps/web/src/app/erp-theme.css` owns the common light/dark palette. Neutral gray surfaces and thin borders provide structure; blue identifies actions and selection. Status colors remain semantic. `--action` has white foreground in both themes; `--blue` can become lighter for text without weakening action-button contrast.
- Keep Geist and existing Lucide icons, with an explicit Microsoft YaHei fallback for Chinese alongside monospace data labels. Page titles are 27 px (24 px on mobile), body and controls 13–14 px, and supporting text at least 12 px. The old 8–10 px table labels have been removed. Real counts retain tabular numerals. Redundant English section codes are suppressed.
- Sidebar width is 240 px, with an optional 76 px icon view. Text remains accessible in the compact view, and native titles identify each icon. Below 900 px, use the existing full-height menu; mobile menu and appearance controls retain 44 px targets.
- The content sits inside one inset surface with a 58 px location bar. Shared padding aligns titles, filters and tables. Workflow tabs wrap on narrow screens, while wide business tables scroll within their own containers.
- Creative projects use a distinct list beside the active task. The prominent canvas action explicitly states that it opens the infinite canvas in another window. Artwork uses the available review width; process details stay expandable. Orders retain their two views and inline production editor.
- Production UI colors do not change image pixels, DPI, file exports or the white/checkerboard print preview. Native workflow graph stages retain their own dark workspace palette; the separately hosted Infinite Canvas source remains unchanged.

## Appearance preferences

The location bar offers light, dark and system themes plus a desktop sidebar toggle. `appearance-preferences.ts` initializes attributes before first paint; `ErpAppearance` handles interaction, operating-system changes and cross-tab storage events. Foreground and background switch together without hover transitions exposing unreadable intermediate colors. The default follows the operating system. Local storage stores only `yummyai.ui.theme` and `yummyai.ui.sidebar`; denied storage does not break navigation or current-tab theme controls. These preferences do not represent roles, tenant selection, identity or customer data.

## Motion and accessibility

React Bits SpotlightCard is used on the three common-task entries and four creative templates. Pointer movement changes only CSS coordinates, without React renders or animation dependencies. The effect has a 180 ms opacity transition; keyboard focus also has a visible border. Touch devices have the same ordinary links. With `prefers-reduced-motion`, the gradient and transition are disabled and all content remains visible.

Module expansion is immediate; only the chevron rotation transitions. No content is delayed behind an entry animation. Search and menu dialogs retain Escape, Tab containment, inert background, initial focus and focus restoration. The skip link and breadcrumbs remain available throughout navigation.

## Maintenance

Use `navigation-registry.ts` for destinations, aliases, grouping and shortcuts. Do not create a second route list in a component. Keep commercial and production workflows separate in business code. Do not derive navigation access from frontend-only role switches or store customer information in browser preferences.

Validate light/dark at 375, 768 and 1440 px, keyboard-only navigation, reduced motion, all route destinations, actual import/production workflows, and a production Web build. This is UI acceptance, not a P0 release certification.

See [2026-09-09 UI acceptance](../operations/ui-modernization-acceptance-2026-09-09.md) for the current verification scope and artifacts.
