import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createEntityId } from "../../packages/contracts/src/index.js";
import { connectDatabase, assertDatabaseMigrationsCurrent, readMigrationEvidence } from "../../packages/database/src/index.js";
import { createBackup, resolveWorkspacePath } from "../scripts/backup-restore.mjs";
import { rehearseDatabaseUpgrade, applyDatabaseUpgrade, assertOriginalDatabasePreserved } from "../scripts/database-upgrade.mts";

const url = new URL(process.env.DATABASE_URL!), bucket = process.env.S3_PRIVATE_BUCKET!;
if (process.env.E2E_ISOLATED_DAILY !== "1" || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(url.pathname) || bucket !== url.pathname.slice(1).replaceAll("_", "-")) throw Error("Disposable upgrade fixture required");
process.env.BACKUP_DATABASE_URL = url.toString();
process.env.DATABASE_POOL_SIZE = "1";
const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const option = process.argv.indexOf("--output-root"), inline = process.argv.find(value => value.startsWith("--output-root="));
const requested = inline?.slice("--output-root=".length) ?? (option >= 0 ? process.argv[option + 1]! : `tmp/database-upgrade-acceptance-${randomUUID()}`);
const output = await resolveWorkspacePath(root, requested, { fresh: true });
await fs.mkdir(output, { recursive: true });
const require = createRequire(new URL("../../packages/storage/package.json", import.meta.url));
const { S3Client, CreateBucketCommand, HeadBucketCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const storage = new S3Client({ endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION || "us-east-1", forcePathStyle: true, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } });
const cases: string[] = [];
const pass = (name: string) => { cases.push(name); process.stdout.write(JSON.stringify({ databaseUpgradeCase: name, result: "pass" }) + "\n"); };
const backup = path.join(output, "backup"), rehearsalPath = path.join(output, "rehearsal.json");
let originalMigrationHash: string, tenantId: string;
try {
  try { await storage.send(new HeadBucketCommand({ Bucket: bucket })); }
  catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error;
    await storage.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  const source = connectDatabase();
  try {
    await assertDatabaseMigrationsCurrent(source);
    const [migration] = await source.client.unsafe("select id,hash from drizzle.__drizzle_migrations order by created_at,id limit 1");
    originalMigrationHash = migration.hash;
    // Only this disposable fixture synthesizes historical hash drift. The
    // operational upgrade path never updates or deletes Drizzle history.
    await source.client.unsafe("update drizzle.__drizzle_migrations set hash=$1 where id=$2", ["0".repeat(64), migration.id]);
    tenantId = createEntityId();
    await source.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic upgrade original',$2)", [tenantId, tenantId]);
    await assert.rejects(assertDatabaseMigrationsCurrent(source), { code: "DATABASE_MIGRATIONS_NOT_READY" }); pass("U01_missing_adoption_rejects_startup");
  } finally { await source.client.end(); }
  await storage.send(new PutObjectCommand({ Bucket: bucket, Key: "synthetic/upgrade-original", Body: Buffer.from([0, 42, 255, 1]), ContentType: "application/octet-stream", Metadata: { "tenant-id": tenantId!, "asset-domain": "authorized" }, Tagging: "purpose=upgrade-fixture" }));
  await createBackup({ outputDirectory: backup });
  const manifest = JSON.parse(await fs.readFile(path.join(backup, "backup-manifest.json"), "utf8"));
  const rehearsal = await rehearseDatabaseUpgrade({ backupDirectory: backup, reportPath: rehearsalPath });
  assert.equal(rehearsal.status, "pass"); assert(rehearsal.expectedDatabaseDeleted && rehearsal.restoreDatabaseDeleted && rehearsal.restoreBucketDeleted); pass("U02_actual_restore_upgrade_and_cleanup");
  const stalePath = path.join(output, "stale-rehearsal.json");
  await fs.writeFile(stalePath, JSON.stringify({ ...rehearsal, sourceSnapshotSha256: "f".repeat(64) }));
  await assert.rejects(applyDatabaseUpgrade({ backupDirectory: backup, rehearsalPath: stalePath, reportPath: path.join(output, "stale-apply.json") }), { code: "upgrade_rehearsal_is_stale" }); pass("U03_stale_rehearsal_rejected");
  const applied = await applyDatabaseUpgrade({ backupDirectory: backup, rehearsalPath, reportPath: path.join(output, "apply.json") });
  assert.equal(applied.status, "pass"); assert(applied.expectedDatabaseDeleted); pass("U04_verified_adoption_enables_startup");
  const app = connectDatabase();
  try {
    await app.client.unsafe("set role yummyai_app");
    assert.equal((await app.client.unsafe("select current_user as name"))[0].name, "yummyai_app");
    await assertDatabaseMigrationsCurrent(app);
    assert.equal((await app.client.unsafe("select count(*)::int as count from schema_adoption_receipts"))[0].count, 1);
    await assert.rejects(app.client.unsafe("insert into schema_adoption_receipts select * from schema_adoption_receipts"), { code: "42501" });
    await assert.rejects(app.client.unsafe("update schema_adoption_receipts set recorded_by='forged'"), { code: "42501" });
    await assert.rejects(app.client.unsafe("delete from schema_adoption_receipts"), { code: "42501" }); pass("U05_non_owner_readiness_and_no_forgery");
    await assert.rejects(app.client.unsafe("update drizzle.__drizzle_migrations set hash=hash"), { code: "42501" });
  } finally { await app.client.end(); }
  const current = connectDatabase();
  try {
    await assert.rejects(current.client.unsafe("update schema_adoption_receipts set recorded_by='changed'"), { code: "55000" });
    await assert.rejects(current.client.unsafe("delete from schema_adoption_receipts"), { code: "55000" }); pass("U06_receipts_immutable");
    await current.client.unsafe("alter table organizations add column runtime_upgrade_probe text");
    try { await assert.rejects(assertDatabaseMigrationsCurrent(current), { code: "DATABASE_MIGRATIONS_NOT_READY" }); }
    finally { await current.client.unsafe("alter table organizations drop column runtime_upgrade_probe"); }
    await assertDatabaseMigrationsCurrent(current);
    const [{ definition }] = await current.client.unsafe("select pg_get_constraintdef(oid,false) as definition from pg_constraint where conrelid='public.ai_assist_executions'::regclass and conname='ai_assist_executions_attempt_check'");
    await current.client.unsafe("alter table ai_assist_executions drop constraint ai_assist_executions_attempt_check;alter table ai_assist_executions add constraint ai_assist_executions_attempt_check check((attempt_count>=0 or attempt_count<=3) and dispatch_count>=0)");
    try { await assert.rejects(assertDatabaseMigrationsCurrent(current), { code: "DATABASE_MIGRATIONS_NOT_READY" }); }
    finally { await current.client.unsafe("alter table ai_assist_executions drop constraint ai_assist_executions_attempt_check;alter table ai_assist_executions add constraint ai_assist_executions_attempt_check " + definition); }
    await assertDatabaseMigrationsCurrent(current); pass("U07_schema_and_boolean_semantics_drift_block_receipt");
    await current.client.unsafe("update organizations set name='Synthetic changed value' where id=$1", [tenantId!]);
    try { await assert.rejects(assertOriginalDatabasePreserved(url.toString(), manifest), { code: "upgrade_original_data_changed" }); }
    finally { await current.client.unsafe("update organizations set name='Synthetic upgrade original' where id=$1", [tenantId!]); }
    pass("U08_original_data_changes_detected");
    const evidence = await readMigrationEvidence(current);
    assert.equal(evidence.drift.length, 1); assert.equal(evidence.actualRows[0]!.hash, "0".repeat(64));
    assert.notEqual(originalMigrationHash!, evidence.actualRows[0]!.hash);
    assert.deepEqual(evidence.actualRows, manifest.database.migrations);
    const [{ count }] = await current.client.unsafe("select count(*)::int as count from schema_adoption_receipts"); assert.equal(count, 1);
    pass("U09_original_history_preserved");
  } finally { await current.client.end(); }
} finally {
  storage.destroy();
  await fs.writeFile(path.join(output, "acceptance-proof.json"), JSON.stringify({ recordedAt: new Date().toISOString(), cases, fixtureDatabase: url.pathname.slice(1), fixtureBucket: bucket, normalDatabaseMigrated: false, actualPaidCalls: 0, resourceCleanupOwner: "isolated runner and nested upgrade finally blocks" }, null, 2) + "\n");
}
assert.equal(cases.length, 9);
process.stdout.write(JSON.stringify({ databaseUpgradeCasesPassed: cases.length, artifactRoot: output }) + "\n");
