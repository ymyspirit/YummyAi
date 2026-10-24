import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createEntityId } from "../../packages/contracts/src/index.js";
import { connectDatabase, withTenant } from "../../packages/database/src/index.js";
import { sql } from "../../apps/api/node_modules/drizzle-orm/index.js";
import { createBackup, restoreDrill, inspectBackupDatabase, resolveWorkspacePath } from "../scripts/backup-restore.mjs";

const sourceUrl = new URL(process.env.DATABASE_URL!), sourceBucket = process.env.S3_PRIVATE_BUCKET!;
if (process.env.E2E_ISOLATED_DAILY !== "1" || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(sourceUrl.pathname) || sourceBucket !== sourceUrl.pathname.slice(1).replaceAll("_", "-")) throw Error("Unsafe backup fixture resources");
const token = sourceUrl.pathname.slice("/order_daily_e2e_".length), workspace = fileURLToPath(new URL("../../", import.meta.url));
const arg = process.argv.indexOf("--output-root"), inline = process.argv.find(value => value.startsWith("--output-root="));
const requested = inline ? inline.slice("--output-root=".length) : arg >= 0 ? process.argv[arg + 1] : `tmp/backup-restore-acceptance-${token}`;
const output = await resolveWorkspacePath(workspace, requested, { fresh: true });
await fs.mkdir(output, { recursive: true });
const require = createRequire(new URL("../../packages/storage/package.json", import.meta.url));
const { S3Client, PutObjectCommand, GetObjectCommand, CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, HeadBucketCommand } = require("@aws-sdk/client-s3");
const client = new S3Client({ endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION || "us-east-1", forcePathStyle: true, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } });
const cases: Array<{ id: string; result: string }> = [], pass = (id: string) => { cases.push({ id, result: "pass" }); process.stdout.write(JSON.stringify({ backupRestoreCase: id, result: "pass" }) + "\n"); };
const maintenanceUrl = new URL(sourceUrl); maintenanceUrl.pathname = "/postgres";
const maintenance = connectDatabase(maintenanceUrl.toString());
const existingDatabase = `yummyai_restore_verify_${token}db`, existingBucket = `yummyai-restore-verify-${token}b`;
let createdDatabase = false, createdBucket = false;
try {
  try { await client.send(new HeadBucketCommand({ Bucket: sourceBucket })); }
  catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error;
    await client.send(new CreateBucketCommand({ Bucket: sourceBucket }));
  }
  const source = connectDatabase(), tenantId = createEntityId(), userId = createEntityId();
  try {
    await source.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic backup tenant',$2)", [tenantId, tenantId]);
    await source.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic backup user')", [userId, userId, `${userId}@example.test`]);
    await source.client.unsafe("create table backup_probe(tenant_id uuid not null,id uuid primary key,value numeric(24,8),large_value bigint,original_text text);alter table backup_probe enable row level security;alter table backup_probe force row level security;create policy backup_probe_tenant on backup_probe for all to yummyai_app using(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);grant select,insert on backup_probe to yummyai_app");
    await withTenant(source.db, { tenantId, userId, permissions: [], dataScope: "tenant" }, tx => tx.execute(sql`insert into backup_probe(tenant_id,id,value,large_value,original_text) values(${tenantId},${createEntityId()},1234567890123456.12345678,9007199254740993,${"Synthetic 原文\nexact bytes"})`));
  } finally { await source.client.end(); }
  for (const [key, body] of [["synthetic/first", Buffer.from([0, 1, 255, 8])], ["synthetic/原件 name with space", Buffer.from("Synthetic 原始资料")]] as const) await client.send(new PutObjectCommand({ Bucket: sourceBucket, Key: key, Body: body, Metadata: { "tenant-id": tenantId, "asset-domain": "authorized", sha256: createHash("sha256").update(body).digest("hex") }, ContentType: "application/octet-stream", CacheControl: "private, no-store", Tagging: "purpose=backup-fixture" }));
  const backup = path.join(output, "backup"), created = await createBackup({ outputDirectory: backup });
  const manifest = JSON.parse(await fs.readFile(path.join(backup, "backup-manifest.json"), "utf8"));
  assert.equal(created.status, "complete"); assert(manifest.database.tables.some((t: { name: string; rows: number; rlsForced: boolean }) => t.name === "backup_probe" && t.rows === 1 && t.rlsForced));
  assert(manifest.objects.every((o: { path: string }) => /^objects\/[a-f0-9]{64}\.bin$/.test(o.path))); pass("BR01");
  const restored = await restoreDrill({ backupDirectory: backup, cleanup: true, reportPath: path.join(output, "successful-restore.json") });
  assert.equal(restored.status, "pass"); assert(restored.databaseDeleted && restored.bucketDeleted); pass("BR02");
  await maintenance.client.unsafe('create database "' + existingDatabase + '"'); createdDatabase = true;
  const existingUrl = new URL(sourceUrl); existingUrl.pathname = "/" + existingDatabase;
  const existing = connectDatabase(existingUrl.toString());
  try { await existing.client.unsafe("create table owned_sentinel(value text);insert into owned_sentinel values('Synthetic existing database')"); }
  finally { await existing.client.end(); }
  await assert.rejects(restoreDrill({ backupDirectory: backup, verificationDatabase: existingDatabase, cleanup: true, reportPath: path.join(output, "database-collision.json") }), { code: "verification_resource_exists" });
  const preserved = connectDatabase(existingUrl.toString());
  try { assert.equal((await preserved.client.unsafe("select value from owned_sentinel"))[0].value, "Synthetic existing database"); }
  finally { await preserved.client.end(); } pass("BR03");
  await client.send(new CreateBucketCommand({ Bucket: existingBucket })); createdBucket = true;
  await client.send(new PutObjectCommand({ Bucket: existingBucket, Key: "owned-sentinel", Body: "Synthetic existing bucket" }));
  await assert.rejects(restoreDrill({ backupDirectory: backup, verificationBucket: existingBucket, cleanup: true, reportPath: path.join(output, "bucket-collision.json") }), { code: "verification_resource_exists" });
  const preservedObject = await client.send(new GetObjectCommand({ Bucket: existingBucket, Key: "owned-sentinel" }));
  assert.equal(await preservedObject.Body.transformToString(), "Synthetic existing bucket"); pass("BR04");
  const corrupt = path.join(output, "corrupt"); await fs.cp(backup, corrupt, { recursive: true });
  const invalidDump = Buffer.from("Synthetic invalid pg_dump archive"), corruptManifest = structuredClone(manifest);
  await fs.writeFile(path.join(corrupt, "postgres.dump"), invalidDump); corruptManifest.postgres.sha256 = createHash("sha256").update(invalidDump).digest("hex");
  await fs.writeFile(path.join(corrupt, "backup-manifest.json"), JSON.stringify(corruptManifest));
  const failedReport = path.join(output, "failed-restore.json");
  await assert.rejects(restoreDrill({ backupDirectory: corrupt, cleanup: true, reportPath: failedReport }), { code: "backup_command_failed" });
  const failed = JSON.parse(await fs.readFile(failedReport, "utf8")); assert(failed.databaseDeleted && failed.bucketDeleted && !failed.cleanupErrors.length); pass("BR05");
  const after = await inspectBackupDatabase(sourceUrl.toString()); assert.deepEqual(JSON.parse(JSON.stringify(after)), manifest.database);
  for (const report of [restored, failed]) {
    assert.equal((await maintenance.client.unsafe("select 1 from pg_database where datname=$1", [report.database])).length, 0);
    await assert.rejects(client.send(new HeadBucketCommand({ Bucket: report.bucket })), (e: { $metadata?: { httpStatusCode?: number } }) => e.$metadata?.httpStatusCode === 404);
  } pass("BR06");
} finally {
  if (createdDatabase) await maintenance.client.unsafe('drop database "' + existingDatabase + '"');
  if (createdBucket) { await client.send(new DeleteObjectCommand({ Bucket: existingBucket, Key: "owned-sentinel" })); await client.send(new DeleteBucketCommand({ Bucket: existingBucket })); }
  await maintenance.client.end(); client.destroy();
  await fs.writeFile(path.join(output, "acceptance-proof.json"), JSON.stringify({ recordedAt: new Date().toISOString(), cases, sourceDatabase: sourceUrl.pathname.slice(1), sourceBucket, actualPaidCalls: 0, collisionResourcesCleaned: true }, null, 2) + "\n");
}
assert.equal(cases.length, 6);
process.stdout.write(JSON.stringify({ backupRestoreCasesPassed: cases.length, artifactRoot: output }) + "\n");
