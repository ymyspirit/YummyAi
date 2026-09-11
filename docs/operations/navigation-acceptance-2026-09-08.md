# Navigation acceptance — 2026-09-08

The shared ERP layout now provides 21 primary destinations, a `/navigation` directory with 33 function entries, global function search, return breadcrumbs and a mobile menu. Order report import and production artwork are direct sidebar destinations. Existing business content and API/data boundaries are unchanged by this navigation work.

Verified locally:

- `pnpm --filter @yummyai/web test`: 51 files, 242 tests passed, including 55 navigation tests.
- `pnpm --filter @yummyai/web typecheck`: passed; final production build also completed TypeScript checks.
- ESLint on navigation, ERP routes, root layout, affected E2E files and the E2E runner: passed with no warnings.
- `pnpm check:rules`: 3 checks passed.
- `pnpm test:e2e navigation-workspace p0-flow pod-batch-workbenches amazon-report production-editor`: 31 passed. This includes ordinary module navigation, dynamic detail return links, ZIP search, separate pillow/tire-cover entries, real production editor save/review/export, legacy redirects, mobile layout and keyboard focus. Existing demo/API fixtures remain owned by their respective test suites; navigation itself uses the actual application components.
- `pnpm --filter @yummyai/web build`: passed, including the new static `/navigation` route.
- `git diff --check` for the affected Web files and documentation: passed.

Desktop screenshots were reviewed at 1440 × 1000 and mobile screenshots at 390 × 844. The mobile menu, search and function directory have no horizontal overflow. Search focuses the input when opened, contains Tab focus, closes on Escape and restores focus to its trigger. Breadcrumb hydration was checked while immediately entering order import from the server-rendered orders page, with no browser runtime errors.

After restoring the normal runtime with `pnpm start:local`, a browser smoke check reproduced a separate development-origin problem: `localhost:3000` hydrated correctly while `127.0.0.1:3000` rejected the HMR WebSocket and left controls inactive. `next.config.ts` now explicitly allows those two loopback development origins. Both real addresses then passed opening search with Ctrl K, searching for a tire cover, pressing Enter, and displaying the correct production-editor breadcrumb, with zero page runtime errors. This configuration applies to the development server; see the local-development runbook.

Screenshots are generated under `apps/web/test-results/navigation-workspace-*` by the browser tests. They contain the function directory and navigation UI; the navigation acceptance screenshots do not require customer records.

This records local navigation acceptance, not a release candidate or marketplace deployment. The workspace also contains pre-existing order-import and production-editor work.

## UI UX Pro Max and React Bits refinement

The user identified excessive visible entries as the main usability problem. The sidebar now exposes the overview and six expandable business modules, plus three fixed task shortcuts. Only one module is expanded at a time, and opening a page reveals its current module. The directory starts with six order/fulfillment entries rather than presenting all 33 at once; category controls narrow the list while keyword search remains global. React Bits SpotlightCard provides restrained pointer/focus feedback on the four common-task links, with its license retained locally and reduced-motion behavior verified.

Final checks after refinement:

- Web unit suite: 51 files / 242 tests passed.
- Web typecheck, scoped ESLint, and all three project-rule checks passed.
- `pnpm test:e2e navigation-workspace p0-flow pod-batch-workbenches amazon-report production-editor`: **36 passed** in the final run. It covers all 21 destinations, disclosure buttons, fixed shortcuts, category/global search, keyboard focus, 375/768/1440 px widths, light/dark/reduced-motion modes, order report import, and real production artwork download.
- Web production build passed, including TypeScript and static `/navigation` generation.
- Desktop and small-screen screenshots were reviewed. The menu's visible links and buttons meet 44 px target height at 375 px, and the new navigation surfaces have no page-level horizontal overflow.

Two existing test timing assumptions were exposed under parallel load and corrected: the Fabric drag test now waits for the synthetic image's actual pixels to be painted, and the sequential P0 navigation walk waits for the destination URL and current-page marker before opening the next module. No arbitrary sleeps or relaxed assertions were added.

Stable local screenshot copies: `test-results/erp-navigation-desktop.png`, `test-results/erp-navigation-mobile-menu.png`, and `test-results/erp-navigation-mobile-dark.png`. These copies contain navigation metadata rather than customer order records. Design decisions and attribution: [ERP interface system](../architecture/erp-ui-design-system.md).

The full local runtime was restored through `pnpm start:local`; its Web/API consistency check passed. Fresh browser contexts on both `127.0.0.1:3000` and `localhost:3000` verified six module buttons, six initial directory entries, module expansion, keyboard search into the tire-cover editor, the order-import shortcut, and an 844 × 390 landscape mobile-menu route to inventory. Both had zero page runtime errors and no horizontal page overflow. The final live directory screenshot is `test-results/erp-navigation-live.png`.
