import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  connectDatabase, migrateDatabase, readMigrationEvidence,
  assertDatabaseMigrationsCurrent, inspectDatabaseSchemaShape, compareSchemaShapes,
} from "../../packages/database/src/index.js";
import {
  BackupOperationError, resolveWorkspacePath,
  inspectBackupDatabaseSnapshot, inspectMigration164UsersProjection,
  restoreDrill, validateBackup, verifyBackupObjects,
} from "./backup-restore.mjs";
import { FACTORY_RETENTION_ACTOR_POLICY as actorPolicy, evaluateMigration164ActorPreservation, UpgradeSystemActorPolicyError } from "./upgrade-system-actor-policy.mjs";

const workspace = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const exec = promisify(execFile);
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => JSON.stringify(value);
function fail(code: string): never { throw new BackupOperationError(code); }
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const urlFor = (source: string, database: string) => { const u = new URL(source); u.pathname = "/" + database; return u.toString(); };

export async function captureRuntimeSource(root = workspace) {
  const { stdout } = await exec("git", ["ls-files", "-c", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const names = [...new Set(stdout.split("\0").filter(name =>
    /^(apps|packages|tools|infra|patches)\//.test(name) ||
    /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|eslint\.config\.[cm]?js|tsconfig[^/]*\.json|CLAUDE\.md|AGENTS\.md)$/.test(name),
  ))].sort();
  const files: Array<{ path: string; sha256: string }> = [];
  for (const name of names) {
    const absolute = await resolveWorkspacePath(root, name);
    let stat;
    try { stat = await fs.lstat(absolute); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (!stat.isFile()) fail("upgrade_source_not_regular_file");
    files.push({ path: name, sha256: sha(await fs.readFile(absolute)) });
  }
  if (!["packages/database/src/migrate.ts", "packages/database/migrations/0128_legacy_runtime_alignment.sql", "pnpm-lock.yaml"].every(name => files.some(file => file.path === name))) fail("upgrade_source_incomplete");
  return { algorithm: "runtime-source-v1", sha256: sha(json(files)), files };
}
type BackupManifest = Awaited<ReturnType<typeof validateBackup>>["manifest"];
type InspectionSql = Pick<ReturnType<typeof connectDatabase>["client"], "unsafe">;
export type Migration164PostCheck = {
  phase: "post_migration"; originalMigrationCount: number; preMigrationActorAbsent: true;
  canonicalMigration: { hash: string; created_at: string };
};

/** Called only immediately after this invocation's migrateDatabase, inside a
 * single repeatable-read snapshot. The default path retains strict equality. */
export async function assertUpgradeOriginalDatabaseSnapshot(sql: InspectionSql, manifest: BackupManifest, context?: Migration164PostCheck) {
  const current = await inspectBackupDatabaseSnapshot(sql, manifest.database.tables);
  const migrationAddedSystemActors = [];
  if (context) {
    if (context.phase !== "post_migration" || context.originalMigrationCount !== manifest.database.migrations.length || context.originalMigrationCount >= actorPolicy.migrationOrdinal || context.preMigrationActorAbsent !== true) fail("upgrade_system_actor_policy_rejected");
    const originalUsers = manifest.database.tables.find((table: { name: string }) => table.name === "app_users");
    const currentUsers = current.tables.find((table: { name: string }) => table.name === "app_users");
    if (!originalUsers || !currentUsers) fail("upgrade_system_actor_policy_rejected");
    const columns = await sql.unsafe("select attname as name from pg_attribute where attrelid='public.app_users'::regclass and attnum>0 and not attisdropped order by attnum");
    const [actor] = await sql.unsafe(
      "select count(*)::int as rows,bool_and(id=$1::uuid and oidc_subject=$2 and email=$3 and display_name=$4) as fixed_fields_match,bool_and(isfinite(created_at) and isfinite(updated_at) and created_at=updated_at) as finite_matching_timestamps,max(xmin::text) as tuple_xmin from public.app_users where id=$1::uuid",
      [actorPolicy.id, actorPolicy.oidc_subject, actorPolicy.email, actorPolicy.display_name],
    );
    const [membership] = await sql.unsafe("select count(*)::int as count from public.memberships where user_id=$1::uuid", [actorPolicy.id]);
    const ledger = await sql.unsafe("select hash,created_at::text as created_at,xmin::text as tuple_xmin from drizzle.__drizzle_migrations where created_at=$1 order by id", [String(actorPolicy.createdAt)]);
    const [appended] = await sql.unsafe("select encode(sha256(convert_to(to_jsonb(u)::text,'UTF8')),'hex') as sha256 from public.app_users u where id=$1::uuid", [actorPolicy.id]);
    const preservedUsers = await inspectMigration164UsersProjection(sql, originalUsers);
    try {
      migrationAddedSystemActors.push(evaluateMigration164ActorPreservation({
        ...context, actualMigration: { hash: ledger[0]?.hash, created_at: ledger[0]?.created_at }, matchingLedgerRows: ledger.length,
        originalColumns: originalUsers.columns.map((column: { name: string }) => column.name), currentColumns: columns.map(column => column.name),
        actorRows: actor?.rows, fixedFieldsMatch: actor?.fixed_fields_match, finiteMatchingTimestamps: actor?.finite_matching_timestamps,
        memberships: membership?.count, actorTupleXmin: actor?.tuple_xmin, ledgerTupleXmin: ledger[0]?.tuple_xmin, appendedRowSha256: appended?.sha256,
        originalUsers: { rows: originalUsers.rows, sha256: originalUsers.sha256 }, currentUsers: { rows: currentUsers.rows, sha256: currentUsers.sha256 },
        preservedUsers: { rows: preservedUsers.rows, sha256: preservedUsers.sha256 },
      }));
    } catch (error) { if (error instanceof UpgradeSystemActorPolicyError) fail(error.code); throw error; }
    current.tables[current.tables.indexOf(currentUsers)] = preservedUsers;
  }
  const rows = (tables: typeof current.tables) => tables.map(table => ({ name: table.name, rows: table.rows, sha256: table.sha256 }));
  if (json(rows(current.tables)) !== json(rows(manifest.database.tables))) fail("upgrade_original_data_changed");
  const prefix = current.migrations.slice(0, manifest.database.migrations.length);
  if (json(prefix) !== json(manifest.database.migrations)) fail("upgrade_original_migration_history_changed");
  return { originalTables: current.tables.length, originalRows: current.tables.reduce((n, table) => n + table.rows, 0), originalMigrations: prefix.length, migrationAddedSystemActors };
}
export async function assertOriginalDatabasePreserved(databaseUrl: string, manifest: BackupManifest) {
  const connection = connectDatabase(databaseUrl);
  try { return await connection.client.begin("isolation level repeatable read read only", tx => assertUpgradeOriginalDatabaseSnapshot(tx, manifest)); }
  finally { await connection.client.end(); }
}
async function migration164PostCheck(sql: InspectionSql, manifest: BackupManifest, canonicalRows: Array<{ hash: string; created_at: string }>): Promise<Migration164PostCheck | undefined> {
  if (manifest.database.migrations.length >= actorPolicy.migrationOrdinal) return;
  const [presence] = await sql.unsafe("select count(*)::int as count from public.app_users where id=$1::uuid or oidc_subject=$2 or email=$3", [actorPolicy.id, actorPolicy.oidc_subject, actorPolicy.email]);
  const [memberships] = await sql.unsafe("select count(*)::int as count from public.memberships where user_id=$1::uuid", [actorPolicy.id]);
  const migration = canonicalRows[actorPolicy.arrayIndex];
  if (presence?.count !== 0 || memberships?.count !== 0 || migration?.hash !== actorPolicy.hash || migration?.created_at !== String(actorPolicy.createdAt)) fail("upgrade_system_actor_policy_rejected");
  return { phase: "post_migration", originalMigrationCount: manifest.database.migrations.length, preMigrationActorAbsent: true, canonicalMigration: migration };
}
async function assertQuiescent(databaseUrl: string) {
  const connection = connectDatabase(databaseUrl);
  try {
    const [row] = await connection.client.unsafe("select count(*)::int as count from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and backend_type='client backend'");
    if (row.count) fail("upgrade_requires_stopped_application");
  } finally { await connection.client.end(); }
}
type Report = Record<string, unknown> & { status: string; phases: string[]; expectedDatabase: string; expectedDatabaseDeleted: boolean };
async function canonicalDatabase<T>(source: string, report: Report, save: () => Promise<void>, action: (url: string) => Promise<T>) {
  const name = report.expectedDatabase;
  if (!/^yummyai_upgrade_expected_[a-f0-9]{32}$/.test(name) || new URL(source).pathname === "/" + name) fail("upgrade_unsafe_expected_database");
  const admin = connectDatabase(urlFor(source, "postgres"));
  let created = false;
  try {
    if ((await admin.client.unsafe("select 1 from pg_database where datname=$1", [name])).length) fail("verification_resource_exists");
    await admin.client.unsafe("create database " + quote(name)); created = true;
    report.phases.push("canonical_database_created"); await save();
    const url = urlFor(source, name), expected = connectDatabase(url);
    try { await migrateDatabase(expected); }
    finally { await expected.client.end(); }
    return await action(url);
  } finally {
    try {
      if (created) {
        await admin.client.unsafe("drop database " + quote(name));
        report.expectedDatabaseDeleted = !(await admin.client.unsafe("select 1 from pg_database where datname=$1", [name])).length;
      }
    } catch { report.expectedDatabaseCleanupFailed = true; fail("upgrade_expected_database_cleanup_failed"); }
    finally { await admin.client.end(); await save(); }
  }
}
type UpgradeVerification = (value: { databaseUrl: string; bucket: string; manifest: BackupManifest; context?: Migration164PostCheck }) => Promise<unknown>;
async function alignAndVerify({ databaseUrl, bucket, manifest, manifestSha256, sourceSha256, canonicalUrl, onSchemaMismatch, verifyPreservation }: {
  databaseUrl: string; bucket: string; manifest: Awaited<ReturnType<typeof validateBackup>>["manifest"];
  manifestSha256: string; sourceSha256: string; canonicalUrl: string;
  onSchemaMismatch?: (value: unknown) => Promise<void>;
  verifyPreservation?: UpgradeVerification;
}) {
  await assertOriginalDatabasePreserved(databaseUrl, manifest);
  const connection = connectDatabase(databaseUrl), canonical = connectDatabase(canonicalUrl);
  try {
    const before = await readMigrationEvidence(connection);
    if (before.actualRows.length > before.canonicalRows.length || before.actualRows.some((row, i) => row.created_at !== before.canonicalRows[i]?.created_at)) fail("upgrade_original_migration_timestamps_changed");
    const originalPostCheck = await migration164PostCheck(connection.client, manifest, before.canonicalRows);
    await migrateDatabase(connection);
    // Disposable acceptance may exercise rollback-only counterexamples. All
    // operational data, schema and object checks still run after it returns.
    const preservationAcceptance = verifyPreservation ? await verifyPreservation({ databaseUrl, bucket, manifest, context: originalPostCheck }) : undefined;
    const original = await connection.client.begin("isolation level repeatable read read only", tx => assertUpgradeOriginalDatabaseSnapshot(tx, manifest, originalPostCheck));
    const actualShape = await inspectDatabaseSchemaShape(connection.client), expectedShape = await inspectDatabaseSchemaShape(canonical.client);
    const comparison = compareSchemaShapes(actualShape, expectedShape);
    if (!comparison.equal || comparison.actualSha256 !== comparison.expectedSha256) {
      await onSchemaMismatch?.({ actualSha256: comparison.actualSha256, expectedSha256: comparison.expectedSha256,
        differences: comparison.differences.map(row => ({ section: row.section, name: row.name, disposition: row.disposition,
          changedFields: [...new Set([...Object.keys(row.actual ?? {}), ...Object.keys(row.expected ?? {})])].filter(key => json(row.actual?.[key]) !== json(row.expected?.[key])),
          ...(process.env.E2E_ISOLATED_DAILY === "1" && row.section === "constraints" ? { actual: row.actual, expected: row.expected } : {}),
        })) });
      fail("upgrade_canonical_schema_mismatch");
    }
    const objects = await verifyBackupObjects(bucket, manifest), evidence = await readMigrationEvidence(connection);
    if (!evidence.timestampsMatch) fail("upgrade_migration_timestamps_mismatch");
    if (evidence.actualRows.slice(manifest.database.migrations.length).some((row, i) => row.hash !== evidence.canonicalRows[manifest.database.migrations.length + i]?.hash)) fail("upgrade_new_migration_hash_mismatch");
    if (evidence.drift.length) {
      // This append is the only adoption path. It follows actual row, object,
      // canonical schema and original-ledger verification; never rewrites history.
      await connection.client.unsafe(
        "insert into public.schema_adoption_receipts(canonical_migrations_sha256,actual_migrations_sha256,schema_sha256,migration_count,prior_migration_count,verification_version,backup_manifest_sha256,source_snapshot_sha256,original_drift,evidence) values($1,$2,$3,$4,$5,'postgres-public-schema-v1',$6,$7,$8::jsonb,$9::jsonb) on conflict do nothing",
        [evidence.canonicalSha256, evidence.actualSha256, actualShape.sha256, evidence.canonicalRows.length, manifest.database.migrations.length, manifestSha256, sourceSha256, json(evidence.drift), json({ schema_matched: true, original_data_matched: true, objects_matched: true, ...original, ...objects })],
      );
    }
    await assertDatabaseMigrationsCurrent(connection);
    return { ...original, ...objects, ...(preservationAcceptance === undefined ? {} : { preservationAcceptance }), migrations: evidence.actualRows.length, historicalHashDrifts: evidence.drift.length, schemaSha256: actualShape.sha256, canonicalMigrationsSha256: evidence.canonicalSha256, actualMigrationsSha256: evidence.actualSha256, originalDataMatched: true, originalHistoryMatched: true, schemaMatched: true, objectsMatched: true, readiness: "pass" };
  } finally { await connection.client.end(); await canonical.client.end(); }
}
function settings() {
  const url = process.env.BACKUP_DATABASE_URL || process.env.DATABASE_URL;
  if (!url || !["localhost", "127.0.0.1", "[::1]", "::1"].includes(new URL(url).hostname) || !process.env.S3_PRIVATE_BUCKET) fail("upgrade_requires_local_operational_configuration");
  return { url, bucket: process.env.S3_PRIVATE_BUCKET };
}
async function startReport(operation: string, reportPath: string, root: string) {
  const target = await resolveWorkspacePath(root, reportPath, { fresh: true }), nonce = randomUUID().replaceAll("-", "");
  const report: Report = { version: 1, operation, status: "checking", recordedAt: new Date().toISOString(), phases: [], expectedDatabase: "yummyai_upgrade_expected_" + nonce, expectedDatabaseDeleted: false };
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, json(report) + "\n", { flag: "wx" });
  const save = () => fs.writeFile(target, JSON.stringify(report, null, 2) + "\n");
  return { report, save };
}
async function assertSourceUnchanged(expected: string, root: string) {
  if ((await captureRuntimeSource(root)).sha256 !== expected) fail("upgrade_runtime_source_changed");
}
export async function rehearseDatabaseUpgrade({ backupDirectory, reportPath, root = workspace, verifyPreservation, verifyUpgraded }: {
  backupDirectory: string; reportPath: string; root?: string;
  verifyPreservation?: UpgradeVerification; verifyUpgraded?: UpgradeVerification;
}) {
  const config = settings(), { report, save } = await startReport("rehearse", reportPath, root);
  try {
    const { backup, manifest } = await validateBackup(root, backupDirectory), source = await captureRuntimeSource(root);
    const manifestSha256 = sha(await fs.readFile(path.join(backup, "backup-manifest.json")));
    Object.assign(report, { sourceSnapshotSha256: source.sha256, sourceFiles: source.files.length, backupManifestSha256: manifestSha256, normalDatabaseMigrated: false });
    const nonce = randomUUID().replaceAll("-", "");
    Object.assign(report, { restoreDatabase: "yummyai_restore_verify_" + nonce, restoreBucket: "yummyai-restore-verify-" + nonce }); await save();
    const restored = await canonicalDatabase(config.url, report, save, async canonicalUrl => restoreDrill({
      backupDirectory: backup, verificationDatabase: report.restoreDatabase, verificationBucket: report.restoreBucket, cleanup: true, root,
      reportPath: path.relative(root, path.resolve(root, reportPath)).replace(/\.json$/, "-restore.json"),
      verifyRestored: async ({ databaseUrl, bucket }: { databaseUrl: string; bucket: string }) => {
        report.phases.push("original_backup_restored_and_verified"); await save();
        const upgraded = await alignAndVerify({ databaseUrl, bucket, manifest, manifestSha256, sourceSha256: source.sha256, canonicalUrl, verifyPreservation,
          onSchemaMismatch: async value => { report.schemaMismatch = value; await save(); },
        });
        if (verifyUpgraded) {
          report.upgradedAcceptance = await verifyUpgraded({ databaseUrl, bucket, manifest });
          report.phases.push("upgraded_copy_acceptance_verified"); await save();
        }
        report.phases.push("isolated_upgrade_and_adoption_verified"); await save(); return upgraded;
      },
    }));
    await assertSourceUnchanged(source.sha256, root);
    Object.assign(report, { status: "pass", upgrade: restored.upgrade, restoreDatabaseDeleted: restored.databaseDeleted, restoreBucketDeleted: restored.bucketDeleted, actualPaidCalls: 0 });
    await save(); return report;
  } catch (error) {
    // The nested finally owns the restore resources even when verification
    // fails. Preserve its exact cleanup result in the outer recovery record.
    try {
      const nestedPath = path.resolve(root, reportPath.replace(/\.json$/, "-restore.json"));
      const nested = JSON.parse(await fs.readFile(nestedPath, "utf8"));
      if (nested.database === report.restoreDatabase && nested.bucket === report.restoreBucket && nested.cleanupRequested === true) {
        report.restoreDatabaseDeleted = nested.databaseDeleted === true;
        report.restoreBucketDeleted = nested.bucketDeleted === true;
        report.restoreCleanupErrors = nested.cleanupErrors;
      }
    } catch { /* No nested resource was created, or its report is unavailable. */ }
    Object.assign(report, { status: "failed", error: error instanceof BackupOperationError ? error.code : "upgrade_rehearsal_failed" }); await save(); throw new BackupOperationError(String(report.error));
  }
}
export async function applyDatabaseUpgrade({ backupDirectory, rehearsalPath, reportPath, root = workspace }: { backupDirectory: string; rehearsalPath: string; reportPath: string; root?: string }) {
  const config = settings(), { report, save } = await startReport("apply", reportPath, root);
  try {
    const rehearsal = JSON.parse(await fs.readFile(await resolveWorkspacePath(root, rehearsalPath), "utf8"));
    if (rehearsal.version !== 1 || rehearsal.operation !== "rehearse" || rehearsal.status !== "pass" || !rehearsal.expectedDatabaseDeleted || !rehearsal.restoreDatabaseDeleted || !rehearsal.restoreBucketDeleted || rehearsal.upgrade?.readiness !== "pass") fail("upgrade_successful_rehearsal_required");
    const { backup, manifest } = await validateBackup(root, backupDirectory), source = await captureRuntimeSource(root);
    const manifestSha256 = sha(await fs.readFile(path.join(backup, "backup-manifest.json")));
    if (rehearsal.backupManifestSha256 !== manifestSha256 || rehearsal.sourceSnapshotSha256 !== source.sha256) fail("upgrade_rehearsal_is_stale");
    if (manifest.source.database !== decodeURIComponent(new URL(config.url).pathname.slice(1)) || manifest.source.bucket !== config.bucket) fail("upgrade_backup_source_mismatch");
    await assertQuiescent(config.url);
    await assertOriginalDatabasePreserved(config.url, manifest);
    await verifyBackupObjects(config.bucket, manifest);
    Object.assign(report, { sourceSnapshotSha256: source.sha256, sourceFiles: source.files.length, backupManifestSha256: manifestSha256, normalDatabaseMigrated: false });
    report.phases.push("normal_source_and_rehearsal_verified"); await save();
    const upgraded = await canonicalDatabase(config.url, report, save, async canonicalUrl => {
      await assertQuiescent(config.url); await assertSourceUnchanged(source.sha256, root);
      report.normalMigrationAttempted = true; await save();
      return alignAndVerify({ databaseUrl: config.url, bucket: config.bucket, manifest, manifestSha256, sourceSha256: source.sha256, canonicalUrl,
        onSchemaMismatch: async value => { report.schemaMismatch = value; await save(); },
      });
    });
    await assertSourceUnchanged(source.sha256, root); await assertQuiescent(config.url);
    Object.assign(report, { status: "pass", normalDatabaseMigrated: true, upgrade: upgraded, actualPaidCalls: 0 }); await save(); return report;
  } catch (error) {
    Object.assign(report, { status: "failed", error: error instanceof BackupOperationError ? error.code : "upgrade_apply_failed", automaticBusinessRollback: false }); await save(); throw new BackupOperationError(String(report.error));
  }
}
async function main() {
  const [operation, ...args] = process.argv.slice(2), options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = ({ "--backup": "backupDirectory", "--report": "reportPath", "--rehearsal": "rehearsalPath" } as Record<string, string>)[args[i]!];
    if (!key || !args[i + 1]) fail("upgrade_arguments_invalid"); options[key] = args[i + 1]!;
  }
  if (!options.backupDirectory || !options.reportPath) fail("upgrade_arguments_invalid");
  const shared = { backupDirectory: options.backupDirectory, reportPath: options.reportPath };
  if (operation === "rehearse") return rehearseDatabaseUpgrade(shared);
  if (operation === "apply" && options.rehearsalPath) return applyDatabaseUpgrade({ ...shared, rehearsalPath: options.rehearsalPath });
  fail("upgrade_arguments_invalid");
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().then(result => process.stdout.write(json(result) + "\n")).catch(error => { process.stderr.write((error instanceof BackupOperationError ? error.code : "upgrade_operation_failed") + "\n"); process.exitCode = 1; });
}
