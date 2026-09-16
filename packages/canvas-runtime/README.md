# YummyAI integrated creative runtime

This workspace builds the content area of Infinite Canvas inside YummyAI's ERP shell.
The original application at port 4175 remains a separate, unmodified legacy host.

`vendor/` contains unmodified upstream source, public assets and its MIT license:

- Repository: https://github.com/basketikun/infinite-canvas
- Tag: `v0.18.0`
- Commit: `d213a74614e0e4bd8a26383d1e1e907249e9c61b`
- Copyright and license: [vendor/LICENSE](vendor/LICENSE)

YummyAI adaptations live in `src/`, `configuration-adapter.ts` and `vite.config.ts`. The build checks exact
upstream function anchors before adapting storage, model calls and config entry.
It deliberately omits the upstream site navigation, autonomous Agent panel,
automatic prompt-source scripts, analytics and provider credential persistence.
The canvas editor, image/video workbenches, media import/export and asset tools
reuse the pinned upstream implementation.

The creative loopback runtime has no ERP cookies or saved model credentials. The
separate configuration surface holds a newly typed key only for submission; saved
keys stay in the API vault and are never returned. Both surfaces use only the
source/origin/channel-validated parent message protocol for business transport.
The parent validates shared Zod contracts and fixes the scope before calling the
authenticated, tenant-protected API. Runtime CSP prevents direct provider calls.

Run `pnpm studio:start` from the repository root. Web development also starts or
reuses this service. Production user-session integration is a separate boundary;
the current browser BFF intentionally rejects production requests.

See [integration guide](../../docs/integration/creative-studio.md) for supported
provider protocols, storage behavior, project ownership and recovery procedures.

`upstream.lock.json` records the release commit, adapter and document/configuration
protocol versions, and exact checksums for every vendored file. The build launcher
checks it before reusing or rebuilding assets. `pnpm canvas:check-upstream` reports
release metadata without installing it. See the [upgrade runbook](../../docs/operations/creative-studio-upgrades.md)
for candidate comparison, upstream verification, compatibility checks and rollback.
