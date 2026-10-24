import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import process from "node:process";
import fs, { createReadStream, createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL, URL, URLSearchParams } from "node:url";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createRequire } from "node:module";
import { FACTORY_RETENTION_ACTOR_POLICY } from "./upgrade-system-actor-policy.mjs";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requireStorage = createRequire(path.join(workspace, "packages/storage/package.json"));
const requireDatabase = createRequire(path.join(workspace, "packages/database/package.json"));
const postgres = requireDatabase("postgres");
const { S3Client, ListObjectsV2Command, GetObjectCommand, GetObjectTaggingCommand, PutObjectCommand, HeadBucketCommand, CreateBucketCommand, DeleteObjectsCommand, DeleteBucketCommand } = requireStorage("@aws-sdk/client-s3");
const exec = promisify(execFile);
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

export class BackupOperationError extends Error {
  constructor(code) { super(code); this.name = "BackupOperationError"; this.code = code; }
}
function fail(code) { throw new BackupOperationError(code); }
export function assertVerificationNames(database, bucket, sourceDatabase, sourceBucket) {
  if (!/^yummyai_restore_verify(?:_[a-z0-9]+)?$/.test(database) || !/^yummyai-restore-verify(?:-[a-z0-9]+)?$/.test(bucket) || bucket.length > 63 || database === sourceDatabase || bucket === sourceBucket) fail("unsafe_verification_resources");
}
export async function resolveWorkspacePath(root, requested, { fresh = false } = {}) {
  root = path.resolve(root);
  const absolute = path.resolve(root, requested), relative = path.relative(root, absolute);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) fail("backup_path_outside_workspace");
  let cursor = absolute;
  for (;;) {
    try { if ((await fsp.lstat(cursor)).isSymbolicLink()) fail("backup_linked_path"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (cursor === root) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) fail("backup_path_outside_workspace");
    cursor = parent;
  }
  if (fresh && fs.existsSync(absolute)) fail("backup_output_exists");
  return absolute;
}
function settings() {
  const databaseUrl = process.env.BACKUP_DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl || !process.env.S3_ENDPOINT || !process.env.S3_PRIVATE_BUCKET || !process.env.S3_ACCESS_KEY_ID || !process.env.S3_SECRET_ACCESS_KEY) fail("backup_configuration_missing");
  const url = new URL(databaseUrl);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) fail("backup_requires_local_postgres");
  return { databaseUrl, database: decodeURIComponent(url.pathname.slice(1)), user: decodeURIComponent(url.username), bucket: process.env.S3_PRIVATE_BUCKET };
}
function connection(url) { return postgres(url, { max: 1, onnotice() {}, connection: { TimeZone: "UTC" } }); }
function storage() {
  return new S3Client({ endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION || "us-east-1", forcePathStyle: true, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } });
}
async function dockerContainer() {
  try {
    const marker = path.join(workspace, ".artifacts/yummyai-compose/adopted.json");
    let managed = false;
    if (fs.existsSync(marker)) {
      const adoption = JSON.parse(await fsp.readFile(marker, "utf8"));
      if (adoption.version !== 1 || adoption.project !== "yummyai" || adoption.status !== "adopted") fail("backup_managed_deployment_invalid");
      managed = true;
    }
    const arguments_ = managed
      ? ["compose", "-p", "yummyai", "-f", path.join(workspace, "infra/compose.yummyai.yml"), "ps", "-q", "postgres"]
      : ["compose", "--env-file", path.join(workspace, ".env"), "-f", path.join(workspace, "infra/docker-compose.yml"), "ps", "-q", "postgres"];
    const { stdout } = await exec("docker", arguments_, { cwd: workspace, windowsHide: true });
    const id = stdout.trim();
    if (!/^[a-f0-9]{12,64}$/.test(id)) fail("backup_postgres_container_missing");
    return id;
  } catch { fail("backup_postgres_container_unavailable"); }
}
async function assertCluster(container, sql, config) {
  const [{ id }] = await sql.unsafe("select system_identifier::text as id from pg_control_system()");
  try {
    const { stdout } = await exec("docker", ["exec", container, "psql", "-U", config.user, "-d", config.database, "-Atc", "select system_identifier::text from pg_control_system()"], { cwd: workspace });
    if (stdout.trim() !== id) fail("backup_cluster_mismatch");
  } catch { fail("backup_cluster_mismatch"); }
}
async function transfer(command, args, { input, output } = {}) {
  const child = spawn(command, args, { cwd: workspace, windowsHide: true, stdio: [input ? "pipe" : "ignore", output ? "pipe" : "ignore", "pipe"] });
  child.stderr.resume(); // PostgreSQL errors can contain private values; never log them.
  const terminal = new Promise((resolve, reject) => {
    child.once("error", () => reject(new BackupOperationError("backup_command_unavailable")));
    child.once("close", code => code === 0 ? resolve() : reject(new BackupOperationError("backup_command_failed")));
  });
  const tasks = [terminal];
  if (input) tasks.push(pipeline(createReadStream(input), child.stdin));
  if (output) tasks.push(pipeline(child.stdout, createWriteStream(output, { flags: "wx", mode: 0o600 })));
  const outcomes = await Promise.allSettled(tasks);
  if (outcomes.some(r => r.status === "rejected")) fail("backup_command_failed");
}
async function fileHash(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function listObjects(client, bucket) {
  let token;
  const result = [];
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    for (const value of page.Contents || []) result.push({ key: value.Key, bytes: value.Size, etag: value.ETag });
    token = page.NextContinuationToken;
  } while (token);
  return result.sort((a, b) => a.key.localeCompare(b.key));
}
async function hashObject(client, bucket, key, output) {
  const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const hash = createHash("sha256");
  let bytes = 0;
  const transform = new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; hash.update(chunk); callback(null, chunk); } });
  if (output) await pipeline(object.Body, transform, createWriteStream(output, { flags: "wx", mode: 0o600 }));
  else for await (const chunk of object.Body) { bytes += chunk.length; hash.update(chunk); }
  const tags = await client.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key }));
  return {
    sha256: hash.digest("hex"), bytes, mediaType: object.ContentType || "application/octet-stream",
    metadata: Object.fromEntries(Object.entries(object.Metadata || {}).sort(([a], [b]) => a.localeCompare(b))),
    cacheControl: object.CacheControl || null, contentEncoding: object.ContentEncoding || null,
    contentDisposition: object.ContentDisposition || null, contentLanguage: object.ContentLanguage || null,
    expires: object.Expires?.toISOString() || null,
    tags: (tags.TagSet || []).map(t => ({ Key: t.Key, Value: t.Value })).sort((a, b) => a.Key.localeCompare(b.Key)),
  };
}
function comparable(value) { return JSON.stringify(value); }

/** Privileged offline migration/backup access follows ADR-002; application
 * repositories and workers continue to use withTenant and forced RLS. No row
 * values are returned to the operator or written to plaintext logs. */
export async function inspectBackupDatabase(databaseUrl, projection) {
  const sql = connection(databaseUrl);
  try {
    return await sql.begin("isolation level repeatable read read only", tx => inspectBackupDatabaseSnapshot(tx, projection));
  } finally { await sql.end(); }
}

async function inspectTableProjection(sql, table, columns, excludeMigration164Actor = false) {
  const expressions = columns.map(column => {
    const id = quote(column.name);
    // Preserve arbitrary precision and ignore scale-only widening on original columns.
    const expression = column.category === "N" ? "(case when position('.' in (" + id + "::numeric::text))>0 then rtrim(rtrim(" + id + "::numeric::text,'0'),'.') else " + id + "::numeric::text end)" : id;
    return expression + " as " + id;
  });
  const where = excludeMigration164Actor ? " where id <> $1::uuid" : "";
  const parameters = excludeMigration164Actor ? [FACTORY_RETENTION_ACTOR_POLICY.id] : [];
  const rows = await sql.unsafe("select md5(to_jsonb(p)::text) as hash from (select " + expressions.join(",") + " from public." + quote(table.name) + where + ") p order by hash", parameters);
  const checksum = createHash("sha256");
  for (const row of rows) checksum.update(row.hash + "\n");
  return { name: table.name, columns, rows: rows.length, sha256: checksum.digest("hex"), rlsEnabled: table.enabled, rlsForced: table.forced };
}

/** Strict inspection in the caller's snapshot. No caller-supplied row exclusions. */
export async function inspectBackupDatabaseSnapshot(sql, projection) {
    const catalog = await sql.unsafe("select c.relname as name,c.relrowsecurity as enabled,c.relforcerowsecurity as forced from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') order by c.relname");
    const tables = [];
    for (const table of catalog) {
      const original = projection?.find(p => p.name === table.name);
      if (projection && !original) continue;
      const columns = original?.columns || await sql.unsafe("select a.attname as name,t.typcategory as category,format_type(a.atttypid,a.atttypmod) as type from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace join pg_type t on t.oid=a.atttypid where n.nspname='public' and c.relname=$1 and a.attnum>0 and not a.attisdropped order by a.attnum", [table.name]);
      tables.push(await inspectTableProjection(sql, table, columns));
    }
    if (projection && tables.length !== projection.length) fail("restore_missing_original_table");
    const policies = await sql.unsafe("select tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='public' order by tablename,policyname");
    const grants = await sql.unsafe("select table_name,grantee,privilege_type,is_grantable from information_schema.role_table_grants where table_schema='public' and grantee in ('yummyai_app','PUBLIC') order by table_name,grantee,privilege_type");
    const migrations = await sql.unsafe("select hash,created_at::text as created_at from drizzle.__drizzle_migrations order by created_at,id");
    return { tables, policies, grants, migrations };
}

/** Only the versioned upgrade policy may use this exact fixed-ID projection.
 * The default backup and restore paths always call the strict inspector above. */
export async function inspectMigration164UsersProjection(sql, original) {
  if (original?.name !== "app_users" || comparable(original.columns?.map(column => column.name)) !== comparable(FACTORY_RETENTION_ACTOR_POLICY.columns)) fail("upgrade_system_actor_policy_rejected");
  const [table] = await sql.unsafe("select relname as name,relrowsecurity as enabled,relforcerowsecurity as forced from pg_class where oid='public.app_users'::regclass");
  return inspectTableProjection(sql, table, original.columns, true);
}
async function assertQuiescent(sql) {
  const [{ count }] = await sql.unsafe("select count(*)::int as count from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and backend_type='client backend'");
  if (count) fail("backup_source_has_other_clients");
}
export async function validateBackup(root, directory) {
  const backup = await resolveWorkspacePath(root, directory);
  const manifest = JSON.parse(await fsp.readFile(path.join(backup, "backup-manifest.json"), "utf8"));
  if (manifest.version !== 2 || manifest.status !== "complete" || manifest.postgres?.path !== "postgres.dump" || !Array.isArray(manifest.objects) || !manifest.database?.tables || !manifest.database?.migrations) fail("backup_manifest_invalid");
  if (await fileHash(path.join(backup, "postgres.dump")) !== manifest.postgres.sha256) fail("backup_dump_checksum_mismatch");
  const keys = new Set(), files = new Set();
  for (const object of manifest.objects) {
    if (typeof object.key !== "string" || !/^objects\/[a-f0-9]{64}\.bin$/.test(object.path) || keys.has(object.key) || files.has(object.path)) fail("backup_manifest_object_invalid");
    keys.add(object.key); files.add(object.path);
    const file = await resolveWorkspacePath(root, path.join(backup, object.path));
    if ((await fsp.stat(file)).size !== object.bytes || await fileHash(file) !== object.sha256) fail("backup_object_checksum_mismatch");
  }
  return { backup, manifest };
}
export async function createBackup({ outputDirectory, root = workspace }) {
  const config = settings(), output = await resolveWorkspacePath(root, outputDirectory, { fresh: true }), sql = connection(config.databaseUrl), client = storage();
  try {
    const container = await dockerContainer();
    await assertCluster(container, sql, config);
    await assertQuiescent(sql);
    const before = await inspectBackupDatabase(config.databaseUrl);
    await fsp.mkdir(path.dirname(output), { recursive: true });
    await fsp.mkdir(output, { mode: 0o700 });
    await fsp.mkdir(path.join(output, "objects"), { mode: 0o700 });
    await transfer("docker", ["exec", container, "pg_dump", "-U", config.user, "-d", config.database, "--format=custom", "--no-owner"], { output: path.join(output, "postgres.dump") });
    const sourceObjects = await listObjects(client, config.bucket), objects = [];
    for (const object of sourceObjects) {
      const relative = "objects/" + digest(object.key) + ".bin";
      const saved = await hashObject(client, config.bucket, object.key, path.join(output, relative));
      if (saved.bytes !== object.bytes) fail("backup_source_object_changed");
      objects.push({ key: object.key, path: relative, ...saved });
    }
    const after = await inspectBackupDatabase(config.databaseUrl);
    await assertQuiescent(sql);
    if (comparable(before) !== comparable(after) || comparable(sourceObjects) !== comparable(await listObjects(client, config.bucket))) fail("backup_source_changed");
    const manifest = { version: 2, status: "complete", createdAt: new Date().toISOString(), source: { database: config.database, bucket: config.bucket }, postgres: { path: "postgres.dump", sha256: await fileHash(path.join(output, "postgres.dump")) }, database: before, objects, consistency: { otherSourceClients: 0, databaseStable: true, objectInventoryStable: true }, acl: "PostgreSQL grants and RLS retained; restore uses no-owner without no-acl" };
    await fsp.writeFile(path.join(output, "backup-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return { status: "complete", outputDirectory: output, tables: before.tables.length, migrations: before.migrations.length, objects: objects.length, bytes: objects.reduce((n, o) => n + o.bytes, 0), manifestSha256: digest(await fsp.readFile(path.join(output, "backup-manifest.json"))) };
  } finally { await sql.end(); client.destroy(); }
}
async function bucketExists(client, bucket) {
  try { await client.send(new HeadBucketCommand({ Bucket: bucket })); return true; }
  catch (error) { if (error.$metadata?.httpStatusCode === 404) return false; throw error; }
}
export async function verifyBackupObjects(bucket, manifest) {
  const client = storage();
  try {
    const actualObjects = await listObjects(client, bucket);
    if (comparable(actualObjects.map(o => ({ key: o.key, bytes: o.bytes }))) !== comparable(manifest.objects.map(o => ({ key: o.key, bytes: o.bytes })))) fail("restore_object_inventory_mismatch");
    for (const object of manifest.objects) {
      const actual = await hashObject(client, bucket, object.key);
      for (const field of ["bytes", "sha256", "metadata", "mediaType", "cacheControl", "contentEncoding", "contentDisposition", "contentLanguage", "expires", "tags"])
        if (comparable(actual[field]) !== comparable(object[field])) fail("restore_object_content_or_metadata_mismatch");
    }
    return { objects: manifest.objects.length, bytes: manifest.objects.reduce((n, o) => n + o.bytes, 0) };
  } finally { client.destroy(); }
}
export async function restoreDrill({ backupDirectory, verificationDatabase, verificationBucket, cleanup = false, reportPath, verifyRestored, root = workspace }) {
  const config = settings(), nonce = randomUUID().replaceAll("-", "");
  const database = verificationDatabase || "yummyai_restore_verify_" + nonce, bucket = verificationBucket || "yummyai-restore-verify-" + nonce;
  assertVerificationNames(database, bucket, config.database, config.bucket);
  const { backup, manifest } = await validateBackup(root, backupDirectory);
  const maintenanceUrl = new URL(config.databaseUrl); maintenanceUrl.pathname = "/postgres";
  const targetUrl = new URL(config.databaseUrl); targetUrl.pathname = "/" + database;
  const admin = connection(maintenanceUrl.toString()), client = storage();
  let databaseCreated = false, bucketCreated = false, primaryError;
  /** @type {Record<string, unknown> & {recordedAt: string, status: string, database: string, bucket: string, sourceUntouched: boolean, databaseDeleted: boolean, bucketDeleted: boolean, cleanupRequested: boolean, cleanupErrors: string[], upgrade?: unknown, error?: string}} */
  const result = { recordedAt: new Date().toISOString(), status: "checking", database, bucket, sourceUntouched: true, databaseDeleted: false, bucketDeleted: false, cleanupRequested: cleanup, cleanupErrors: [] };
  try {
    const exists = await admin.unsafe("select 1 from pg_database where datname=$1", [database]);
    if (exists.length || await bucketExists(client, bucket)) fail("verification_resource_exists");
    const container = await dockerContainer(), source = connection(config.databaseUrl);
    try { await assertCluster(container, source, config); } finally { await source.end(); }
    await admin.unsafe("create database " + quote(database)); databaseCreated = true;
    await client.send(new CreateBucketCommand({ Bucket: bucket })); bucketCreated = true;
    await transfer("docker", ["exec", "-i", container, "pg_restore", "-U", config.user, "-d", database, "--no-owner", "--exit-on-error"], { input: path.join(backup, "postgres.dump") });
    const restored = await inspectBackupDatabase(targetUrl.toString());
    if (comparable(restored) !== comparable(manifest.database)) fail("restore_database_inventory_mismatch");
    for (const object of manifest.objects) await client.send(new PutObjectCommand({
      Bucket: bucket, Key: object.key, Body: createReadStream(path.join(backup, object.path)), ContentLength: object.bytes,
      ContentType: object.mediaType, Metadata: object.metadata, CacheControl: object.cacheControl || undefined,
      ContentEncoding: object.contentEncoding || undefined, ContentDisposition: object.contentDisposition || undefined,
      ContentLanguage: object.contentLanguage || undefined, Expires: object.expires ? new Date(object.expires) : undefined,
      Tagging: object.tags?.length ? new URLSearchParams(object.tags.map(t => [t.Key, t.Value])).toString() : undefined,
    }));
    await verifyBackupObjects(bucket, manifest);
    if (verifyRestored) result.upgrade = await verifyRestored({ databaseUrl: targetUrl.toString(), bucket, manifest, backup });
    Object.assign(result, { status: "pass", tables: restored.tables.length, migrations: restored.migrations.length, objects: manifest.objects.length, dataChecksums: "pass", tenantPolicies: "pass", applicationGrants: "pass", objectChecksums: "pass" });
  } catch (error) { primaryError = error; result.status = "failed"; result.error = error instanceof BackupOperationError ? error.code : "restore_operation_failed"; }
  finally {
    if (cleanup) {
      if (bucketCreated) try {
        const objects = await listObjects(client, bucket);
        for (let i = 0; i < objects.length; i += 1000) {
          const deleted = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects.slice(i, i + 1000).map(o => ({ Key: o.key })), Quiet: true } }));
          if (deleted.Errors?.length) fail("restore_cleanup_objects_failed");
        }
        await client.send(new DeleteBucketCommand({ Bucket: bucket }));
        result.bucketDeleted = !await bucketExists(client, bucket);
      } catch { result.cleanupErrors.push("verification_bucket_cleanup_failed"); }
      if (databaseCreated) try { await admin.unsafe("drop database " + quote(database)); result.databaseDeleted = !(await admin.unsafe("select 1 from pg_database where datname=$1", [database])).length; }
      catch { result.cleanupErrors.push("verification_database_cleanup_failed"); }
    }
    await admin.end(); client.destroy();
    if (reportPath) {
      const report = await resolveWorkspacePath(root, reportPath, { fresh: true });
      await fsp.mkdir(path.dirname(report), { recursive: true });
      await fsp.writeFile(report, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
    }
  }
  if (result.cleanupErrors.length) fail("restore_cleanup_incomplete");
  if (primaryError) throw new BackupOperationError(result.error);
  return result;
}
async function main() {
  const [operation, ...args] = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cleanup") { options.cleanup = true; continue; }
    const names = { "--output": "outputDirectory", "--backup": "backupDirectory", "--database": "verificationDatabase", "--bucket": "verificationBucket", "--report": "reportPath" };
    const name = names[args[i]];
    if (!name || !args[i + 1]) fail("backup_arguments_invalid");
    options[name] = args[++i];
  }
  if (operation === "backup" && options.outputDirectory) return createBackup(options);
  if (operation === "restore" && options.backupDirectory) return restoreDrill(options);
  fail("backup_arguments_invalid");
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().then(result => process.stdout.write(JSON.stringify(result) + "\n")).catch(error => { process.stderr.write((error instanceof BackupOperationError ? error.code : "backup_operation_failed") + "\n"); process.exitCode = 1; });
}
