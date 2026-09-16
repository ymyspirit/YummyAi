# Creative studio upstream upgrades

The ERP creative editor and model configuration reuse Infinite Canvas source.
Upstream code is kept in `packages/canvas-runtime/vendor`; all ERP changes are
outside this directory. The current baseline is v0.18.0 at
`d213a74614e0e4bd8a26383d1e1e907249e9c61b`. The original source paths are `web/src`,
`web/public`, plus the root MIT `LICENSE`.

## Ownership and compatibility

| Area | Owner | Upgrade rule |
| --- | --- | --- |
| Canvas, image/video UI, model drawer and picker | Pinned upstream | Update together, preserving upstream files |
| Tenant, authorization, encrypted keys, tasks, assets | ERP services | Reuse existing services and forced RLS |
| Configuration RPC and model route mapping | ERP adapter | Review contracts and checked source substitutions |
| Saved documents and media | ERP private versioned storage | Preserve versions and object identities; never replace a failed read with empty data |
| User defaults | `model_preferences` | Tenant/member isolation; invalid old defaults remain visible for correction |

`upstream.lock.json` records the tag, commit, adapter version, document protocol,
configuration protocol and per-file checksums. All 183 vendored files in the
initial lock were checked against the official GitHub commit tree. Builds verify
the lock before accepting a cached bundle. Checked source anchors fail the build
when upstream functions no longer match the adapter. A matching checksum does
not prove behavioral compatibility; the browser and storage checks below remain
required. The runtime has no updater that rewrites production files or user data.

## Inspect an update

Run from the ERP root with Node 24.17.x and pnpm 11.10.x:

```powershell
pnpm canvas:verify-upstream
pnpm canvas:check-upstream
pnpm canvas:compare-upstream 'D:\path\to\candidate-infinite-canvas-checkout'
```

`check` reads official release metadata and reports the current/latest tags.
`compare` reads an explicitly selected checkout and reports added, removed and
changed files; neither command installs a release. Review the release notes,
license, dependency/lock changes, configuration components, API protocols,
document serializers and import/export behavior before choosing a candidate.

## Prepare and verify a candidate

1. Use an isolated candidate checkout. Preserve the existing dirty workspace and
   select an explicit upstream tag/commit. Keep an immutable copy of the current
   adapter, vendor lock, runtime artifact and ERP version as the rollback target.
2. Run the existing backup script in [backup and restore](backup-restore.md),
   including the dedicated model encryption configuration. Back up PostgreSQL and
   private object storage together. Test restoration in the named verification
   database/bucket; do not restore over the working database for a drill.
3. In the candidate only, replace vendored files with the reviewed release source.
   Update dependency versions and the pnpm lockfile only where required by that
   release. Keep ERP changes in adapters and wrapper components. Never copy the
   upstream browser credential store into the ERP database.
4. Record the exact candidate after source review. The following command requires
   real values in place of the placeholders:

   ```powershell
   pnpm canvas:record-upstream <release-tag> <full-commit-sha> <adapter-version>
   ```

   It checks the official tag-to-commit relationship and every local vendor file
   against that commit, then updates only the lock. It does not deploy a runtime.
   Protocol-version changes need a separate migration and rollback decision;
   recording a new lock does not increment them automatically.
5. Build the runtime and run relevant unit, integration and browser suites. Stop
   the dev Web/API servers before standard E2E. At minimum:

   ```powershell
   pnpm canvas:verify-upstream
   node --test tools/tests/canvas-upstream.test.mjs
   pnpm --filter @yummyai/canvas-runtime build
   pnpm --filter @yummyai/canvas-runtime test
   pnpm --filter @yummyai/api test:integration model-configuration creative-studio
   pnpm test:e2e creative-studio
   pnpm lint
   pnpm typecheck
   ```

   Test representative historical canvas exports with text, images, connections,
   prompts and generation history. Verify open/edit/save/reload/export, tenant and
   member isolation, model discovery/manual fallback, failed-save retention and
   defaults. Compare node/connection counts and original media checksums. Run
   desktop and 390 px checks on the actual candidate runtime. Existing creation
   suites use synthetic records; catalogue fixtures never call a paid provider.
6. If the release changes document serialization, add an explicit versioned
   converter and tests using saved old-format fixtures. Preserve the original
   document and media. If an old version cannot safely reopen a converted
   document, plan rollback through original versions before switching.
7. Run the project's complete release checks and CI on the candidate commit when
   preparing a release. A local green test run or a clean upstream lock alone is
   not a release candidate. Switch only after the reviewed candidate passes.

## Rollback and preservation

For adapter/UI-only upgrades, restore the complete previous ERP/runtime artifact
and upstream lock together. Do not downgrade only vendor files under newer
adapters. Migration 0078 is additive; leaving its defaults table in place is safe
for the previous application and avoids deleting users' preferences.

If a data converter was applied, restore original document versions using its
reviewed rollback path. Full database/object restoration requires a coordinated
maintenance window and a backup of newer writes first; otherwise unrelated ERP
work after the backup would be lost. Keep the old legacy host/browser export until
imported media and documents have been verified. Existing approved design,
listing and export records remain immutable.

## Current local backup evidence

On 2026-09-14, `.artifacts/backups/studio-config-20260914` backed up PostgreSQL and
1,485 objects. PostgreSQL SHA-256:
`f60bd7496aeac9abc0d81c4de7549d4d00882f15f7873b43cf71aa601d22f8d8`.
The isolated `yummyai_restore_verify_studio_config` database and
`yummyai-restore-verify-studio-config` bucket restored successfully; verification
resources were removed. Logs: `tmp/studio-config-backup.log` and
`tmp/studio-config-restore.log`. This is local recoverability evidence, not an
exact-commit release certification or a test of a newer upstream release.
