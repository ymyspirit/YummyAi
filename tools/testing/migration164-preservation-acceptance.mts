import { createHash } from "node:crypto";
import { createEntityId } from "../../packages/contracts/src/index.js";
import { connectDatabase, inspectDatabaseSchemaShape } from "../../packages/database/src/index.js";
import {
  BackupOperationError, inspectBackupDatabaseSnapshot, inspectMigration164UsersProjection,
} from "../scripts/backup-restore.mjs";
import {
  assertUpgradeOriginalDatabaseSnapshot, type Migration164PostCheck,
} from "../scripts/database-upgrade.mts";
import { FACTORY_RETENTION_ACTOR_POLICY as actorPolicy } from "../scripts/upgrade-system-actor-policy.mjs";

type Manifest = Parameters<typeof assertUpgradeOriginalDatabaseSnapshot>[1];
type InspectionSql = Parameters<typeof assertUpgradeOriginalDatabaseSnapshot>[0];
type Effects = Record<string, boolean | number>;
type CaseResult = {
  id: string;
  result: "pass";
  rejectedBy: "preservation_check" | "database_trigger";
  rejectionCode: string;
  effects: Effects;
  rollbackVerified: true;
};
type Input = {
  databaseUrl: string;
  manifest: Manifest;
  context: Migration164PostCheck;
  expectedDatabase: string;
};

/** This is a disposable-copy experiment, not an operational exclusion hook. */
class AcceptanceFailure extends Error {
  readonly code: string;
  readonly caseId?: string;
  readonly sqlState?: string;
  closeFailure = false;
  constructor(code: string, caseId?: string, sqlState?: string) {
    super(code);
    this.name = "Migration164PreservationAcceptanceError";
    this.code = code;
    this.caseId = caseId;
    this.sqlState = sqlState;
  }
}
class RollbackCase extends Error {
  constructor(readonly result: Omit<CaseResult, "rollbackVerified">) {
    super("migration164_acceptance_rollback");
    this.name = "Migration164AcceptanceRollback";
  }
}
function fail(code: string, caseId?: string): never { throw new AcceptanceFailure(code, caseId); }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function check(value: unknown, code: string): asserts value { if (!value) fail(code); }
const quote = (value: unknown) => {
  if (typeof value !== "string" || !value.length || value.length > 63 || value.includes("\0"))
    fail("migration164_acceptance_catalog_invalid");
  return '"' + value.replaceAll('"', '""') + '"';
};
function safeSqlState(error: unknown) {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[0-9A-Z]{5}$/.test(error.code))
    return error.code;
}

function validateInput(input: Input) {
  check(process.env.E2E_ISOLATED_DAILY === "1", "migration164_acceptance_isolation_required");
  check(typeof input.expectedDatabase === "string" && /^yummyai_restore_verify_[a-f0-9]{32}$/.test(input.expectedDatabase), "migration164_acceptance_database_not_owned");
  let url: URL;
  try { url = new URL(input.databaseUrl); }
  catch { return fail("migration164_acceptance_database_url_invalid"); }
  check(["postgres:", "postgresql:"].includes(url.protocol) &&
    ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname) &&
    url.pathname === "/" + input.expectedDatabase && !url.hash, "migration164_acceptance_database_not_owned");
  check(input.manifest?.version === 2 && input.manifest.status === "complete" &&
    typeof input.manifest.source?.database === "string" && input.manifest.source.database !== input.expectedDatabase &&
    Array.isArray(input.manifest.database?.tables) && Array.isArray(input.manifest.database.migrations) &&
    input.manifest.database.migrations.length === 148, "migration164_acceptance_original148_required");
  check(input.context?.phase === "post_migration" && input.context.originalMigrationCount === 148 &&
    input.context.preMigrationActorAbsent === true && input.context.canonicalMigration?.hash === actorPolicy.hash &&
    input.context.canonicalMigration.created_at === String(actorPolicy.createdAt), "migration164_acceptance_post_context_required");
}
async function assertDatabase(sql: InspectionSql, expectedDatabase: string) {
  const [row] = await sql.unsafe("select current_database() as name");
  check(row?.name === expectedDatabase, "migration164_acceptance_database_not_owned");
}
async function tuplePins(sql: InspectionSql) {
  const [row] = await sql.unsafe(
    "select u.xmin::text as actor_xmin,m.xmin::text as ledger_xmin,encode(sha256(convert_to(to_jsonb(u)::text,'UTF8')),'hex') as actor_hash from public.app_users u cross join drizzle.__drizzle_migrations m where u.id=$1::uuid and m.created_at=$2 and m.hash=$3",
    [actorPolicy.id, String(actorPolicy.createdAt), actorPolicy.hash],
  );
  check(row && /^[a-f0-9]{64}$/.test(row.actor_hash) && /^[0-9]+$/.test(row.actor_xmin) && /^[0-9]+$/.test(row.ledger_xmin), "migration164_acceptance_tuple_missing");
  return { actorXmin: String(row.actor_xmin), ledgerXmin: String(row.ledger_xmin), actorHash: String(row.actor_hash) };
}
async function touchSameLedger(sql: InspectionSql) {
  // Deliberate, rolled-back test mutation: pin contents do not change. Giving
  // actor and ledger this case's xmin isolates the other predicate under test.
  const rows = await sql.unsafe(
    "update drizzle.__drizzle_migrations set hash=hash,created_at=created_at where created_at=$1 and hash=$2 returning id",
    [String(actorPolicy.createdAt), actorPolicy.hash],
  );
  check(rows.length === 1, "migration164_acceptance_ledger_missing");
}
async function expectRejection(action: () => Promise<unknown>, expectedCode: string) {
  try { await action(); }
  catch (error) {
    if (error instanceof BackupOperationError && error.code === expectedCode) return expectedCode;
    throw new AcceptanceFailure("migration164_acceptance_unexpected_rejection", undefined, safeSqlState(error));
  }
  return fail("migration164_acceptance_negative_accepted");
}

/** Select only an actual original user with no referencing FK row. Private
 * identifiers stay inside the transaction and are never included in proof. */
async function unreferencedOriginalUser(sql: InspectionSql) {
  const references = await sql.unsafe(
    "select n.nspname as schema_name,c.relname as table_name,array_agg(a.attname::text order by k.ordinality) as child_columns,array_agg(p.attname::text order by k.ordinality) as parent_columns from pg_constraint f join pg_class c on c.oid=f.conrelid join pg_namespace n on n.oid=c.relnamespace cross join lateral unnest(f.conkey,f.confkey) with ordinality k(child_num,parent_num,ordinality) join pg_attribute a on a.attrelid=f.conrelid and a.attnum=k.child_num join pg_attribute p on p.attrelid=f.confrelid and p.attnum=k.parent_num where f.contype='f' and f.confrelid='public.app_users'::regclass group by f.oid,n.nspname,c.relname order by n.nspname,c.relname,f.oid",
  );
  check(references.length <= 4096, "migration164_acceptance_catalog_invalid");
  const predicates = references.map(row => {
    check(Array.isArray(row.child_columns) && Array.isArray(row.parent_columns) && row.child_columns.length > 0 &&
      row.child_columns.length === row.parent_columns.length && row.child_columns.length <= 32, "migration164_acceptance_catalog_invalid");
    const conditions = row.child_columns.map((column: unknown, index: number) => "r." + quote(column) + "=u." + quote(row.parent_columns[index]));
    return "not exists(select 1 from " + quote(row.schema_name) + "." + quote(row.table_name) + " r where " + conditions.join(" and ") + ")";
  });
  const [row] = await sql.unsafe(
    "with candidates as materialized(select * from public.app_users where id<>$1::uuid order by id limit 256) select u.id::text as id from candidates u" +
    (predicates.length ? " where " + predicates.join(" and ") : "") + " order by u.id limit 1", [actorPolicy.id],
  );
  check(typeof row?.id === "string" && /^[a-f0-9-]{36}$/.test(row.id), "migration164_acceptance_original_user_unavailable");
  return row.id as string;
}

/** Invoked only by the owner's programmatic upgrade rehearsal hook. No CLI,
 * environment-file loading, resource creation, migration or committed write. */
export async function runMigration164PreservationAcceptance(input: Input) {
  validateInput(input); // Before connectDatabase can open a socket.
  const { databaseUrl, manifest, context, expectedDatabase } = input;
  const connection = connectDatabase(databaseUrl);
  const cases: CaseResult[] = [];
  const runBody = async () => {
    const originalUsers = manifest.database.tables.find((table: { name: string }) => table.name === "app_users");
    check(originalUsers, "migration164_acceptance_original_users_missing");
    const baseline = await connection.client.begin("isolation level repeatable read read only", async sql => {
      await assertDatabase(sql, expectedDatabase);
      const positive = await assertUpgradeOriginalDatabaseSnapshot(sql, manifest, context);
      check(positive.migrationAddedSystemActors.length === 1, "migration164_acceptance_positive_missing");
      const snapshot = await inspectBackupDatabaseSnapshot(sql);
      const pins = await tuplePins(sql);
      check(pins.actorXmin === pins.ledgerXmin, "migration164_acceptance_positive_xmin_mismatch");
      return { positive, snapshotSha256: hash(snapshot), migrationsSha256: hash(snapshot.migrations), pins };
    });
    const schemaBefore = await inspectDatabaseSchemaShape(connection.client);
    const assertRestored = async () => {
      await connection.client.begin("isolation level repeatable read read only", async sql => {
        await assertDatabase(sql, expectedDatabase);
        check(hash(await inspectBackupDatabaseSnapshot(sql)) === baseline.snapshotSha256, "migration164_acceptance_rollback_data_changed");
        check(hash(await tuplePins(sql)) === hash(baseline.pins), "migration164_acceptance_rollback_tuple_changed");
      });
    };
    const rollback = async (id: string, action: (sql: InspectionSql) => Promise<Omit<CaseResult, "id" | "result" | "rollbackVerified">>) => {
      let result: Omit<CaseResult, "rollbackVerified"> | undefined;
      let failure: AcceptanceFailure | undefined;
      try {
        await connection.client.begin("isolation level repeatable read", async sql => {
          await assertDatabase(sql, expectedDatabase);
          await sql.unsafe("set local lock_timeout='3s'");
          await sql.unsafe("set local statement_timeout='30s'");
          throw new RollbackCase({ id, result: "pass", ...await action(sql) });
        });
        failure = new AcceptanceFailure("migration164_acceptance_rollback_not_observed", id);
      } catch (error) {
        if (error instanceof RollbackCase) result = error.result;
        else if (error instanceof AcceptanceFailure) failure = new AcceptanceFailure(error.code, id, error.sqlState);
        else failure = new AcceptanceFailure("migration164_acceptance_sql_failed", id, safeSqlState(error));
      }
      await assertRestored();
      if (failure) throw failure;
      check(result, "migration164_acceptance_rollback_not_observed");
      cases.push({ ...result, rollbackVerified: true });
    };
    const policyRejection = async (sql: InspectionSql, effects: Effects) => ({
      rejectedBy: "preservation_check" as const,
      rejectionCode: await expectRejection(() => assertUpgradeOriginalDatabaseSnapshot(sql, manifest, context), "upgrade_system_actor_policy_rejected"),
      effects,
    });

    await rollback("strict_default_has_no_exclusion", async sql => ({
      rejectedBy: "preservation_check",
      rejectionCode: await expectRejection(() => assertUpgradeOriginalDatabaseSnapshot(sql, manifest), "upgrade_original_data_changed"),
      effects: { actorAndLedgerUnchanged: true, contextOmitted: true },
    }));
    await rollback("actor_microseconds_differ_in_same_js_millisecond", async sql => {
      await touchSameLedger(sql);
      const rows = await sql.unsafe(
        "update public.app_users set created_at=date_trunc('milliseconds',created_at)+interval '1 microsecond',updated_at=date_trunc('milliseconds',created_at)+interval '2 microseconds' where id=$1::uuid returning created_at,updated_at,created_at<>updated_at as unequal,isfinite(created_at) and isfinite(updated_at) as finite",
        [actorPolicy.id],
      );
      const row = rows[0], pins = await tuplePins(sql);
      // Drizzle preserves unsafe timestamp results as strings. Conversion here
      // demonstrates JS precision only; the policy still checks native PG facts.
      const createdDate = row?.created_at instanceof Date ? row.created_at :
        typeof row?.created_at === "string" ? new Date(row.created_at) : null;
      const updatedDate = row?.updated_at instanceof Date ? row.updated_at :
        typeof row?.updated_at === "string" ? new Date(row.updated_at) : null;
      const createdTime = createdDate?.getTime() ?? NaN, updatedTime = updatedDate?.getTime() ?? NaN;
      check(rows.length === 1 && row.unequal === true && row.finite === true && Number.isFinite(createdTime) && Number.isFinite(updatedTime) &&
        createdTime === updatedTime && pins.actorXmin === pins.ledgerXmin, "migration164_acceptance_microsecond_setup_failed");
      return policyRejection(sql, { databaseTimestampsDiffer: true, javascriptMillisecondsEqual: true, sameCaseTupleXmin: true,
        ledgerContentUnchanged: true, driverTimestampStrings: typeof row.created_at === "string" && typeof row.updated_at === "string" });
    });
    await rollback("actor_fixed_identity_changed", async sql => {
      await touchSameLedger(sql);
      const rows = await sql.unsafe("update public.app_users set display_name=$2 where id=$1::uuid returning id", [actorPolicy.id, "Synthetic preservation negative"]);
      const pins = await tuplePins(sql);
      check(rows.length === 1 && pins.actorXmin === pins.ledgerXmin, "migration164_acceptance_fixed_field_setup_failed");
      return policyRejection(sql, { fixedFieldChanged: true, sameCaseTupleXmin: true, ledgerContentUnchanged: true });
    });
    await rollback("system_actor_extra_column", async sql => {
      await touchSameLedger(sql);
      await sql.unsafe("alter table public.app_users add column migration164_acceptance_probe text");
      const rows = await sql.unsafe("update public.app_users set migration164_acceptance_probe='synthetic' where id=$1::uuid returning id", [actorPolicy.id]);
      const pins = await tuplePins(sql);
      check(rows.length === 1 && pins.actorXmin === pins.ledgerXmin, "migration164_acceptance_extra_column_setup_failed");
      return policyRejection(sql, { extraColumnAddedOnlyInRollbackTransaction: true, sameCaseTupleXmin: true, ledgerContentUnchanged: true });
    });
    await rollback("original_user_deleted_and_replaced_with_balanced_count", async sql => {
      const originalId = await unreferencedOriginalUser(sql), replacementId = createEntityId();
      const deleted = await sql.unsafe("delete from public.app_users where id=$1::uuid returning id", [originalId]);
      check(deleted.length === 1, "migration164_acceptance_original_user_unavailable");
      await sql.unsafe("insert into public.app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic balanced replacement')",
        [replacementId, "synthetic:preservation:" + replacementId, replacementId + "@example.invalid"]);
      const projection = await inspectMigration164UsersProjection(sql, originalUsers);
      check(projection.rows === originalUsers.rows && projection.sha256 !== originalUsers.sha256, "migration164_acceptance_balanced_setup_failed");
      return policyRejection(sql, { originalUserDeleted: true, differentSyntheticUserInserted: true, originalCountBalanced: true, originalChecksumChanged: true, referencedOriginalUserUsed: false });
    });
    await rollback("unexpected_additional_user", async sql => {
      const id = createEntityId();
      await sql.unsafe("insert into public.app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic additional user')",
        [id, "synthetic:preservation:" + id, id + "@example.invalid"]);
      const projection = await inspectMigration164UsersProjection(sql, originalUsers);
      check(projection.rows === originalUsers.rows + 1, "migration164_acceptance_extra_user_setup_failed");
      return policyRejection(sql, { additionalNonSystemUsers: 1 });
    });
    for (const status of ["invited", "active", "disabled"] as const) {
      await rollback("system_actor_membership_" + status, async sql => {
        const [tenant] = await sql.unsafe("select id::text as id from public.organizations order by id limit 1");
        check(typeof tenant?.id === "string", "migration164_acceptance_tenant_unavailable");
        let code: string | undefined;
        let exactTrigger = false;
        try {
          await sql.unsafe("insert into public.memberships(id,tenant_id,user_id,status) values($1,$2,$3,$4)",
            [createEntityId(), tenant.id, actorPolicy.id, status]);
        } catch (error) {
          code = safeSqlState(error);
          exactTrigger = error instanceof Error && error.message === "factory_erp_retention_actor_noninteractive";
        }
        check(code === "23514" && exactTrigger, "migration164_acceptance_membership_guard_failed");
        return { rejectedBy: "database_trigger", rejectionCode: code, effects: { guardPreventedMembership: true, exactReservedActorTrigger: true, preservationCheckSawIllegalMembership: false, triggerDisabled: false } };
      });
    }
    await rollback("migration164_ledger_hash_changed", async sql => {
      const rows = await sql.unsafe("update drizzle.__drizzle_migrations set hash=$3 where created_at=$1 and hash=$2 returning id",
        [String(actorPolicy.createdAt), actorPolicy.hash, "0".repeat(64)]);
      check(rows.length === 1, "migration164_acceptance_ledger_setup_failed");
      return policyRejection(sql, { canonicalLedgerHashChanged: true, original148PrefixChanged: false });
    });
    await rollback("migration164_ledger_time_changed", async sql => {
      const rows = await sql.unsafe("update drizzle.__drizzle_migrations set created_at=created_at+1 where created_at=$1 and hash=$2 returning id",
        [String(actorPolicy.createdAt), actorPolicy.hash]);
      check(rows.length === 1, "migration164_acceptance_ledger_setup_failed");
      return policyRejection(sql, { canonicalLedgerTimeChanged: true, original148PrefixChanged: false });
    });
    await rollback("actor_and_ledger_cross_transaction_xmin", async sql => {
      const rows = await sql.unsafe("update public.app_users set display_name=display_name where id=$1::uuid returning id", [actorPolicy.id]);
      const pins = await tuplePins(sql);
      check(rows.length === 1 && pins.actorHash === baseline.pins.actorHash && pins.actorXmin !== pins.ledgerXmin &&
        pins.ledgerXmin === baseline.pins.ledgerXmin, "migration164_acceptance_xmin_setup_failed");
      return policyRejection(sql, { originalActorFieldsUnchanged: true, actorAndLedgerTupleXminDiffer: true, ledgerUntouched: true });
    });

    await assertRestored();
    const schemaAfter = await inspectDatabaseSchemaShape(connection.client);
    check(schemaAfter.sha256 === schemaBefore.sha256, "migration164_acceptance_rollback_schema_changed");
    const final = await connection.client.begin("isolation level repeatable read read only", sql => assertUpgradeOriginalDatabaseSnapshot(sql, manifest, context));
    check(hash(final) === hash(baseline.positive) && cases.length === 12, "migration164_acceptance_final_baseline_changed");
    return {
      version: 1,
      operation: "migration164-preservation-acceptance",
      status: "pass",
      database: expectedDatabase,
      originalMigrationCount: 148,
      migrationOrdinal: actorPolicy.migrationOrdinal,
      migrationArrayIndex: actorPolicy.arrayIndex,
      legitimatePostMigrationPassed: true,
      strictDefaultRejected: true,
      cases,
      negativeCases: cases.length,
      originalDatabaseSnapshotSha256: baseline.snapshotSha256,
      completeMigrationLedgerSha256: baseline.migrationsSha256,
      schemaSha256: schemaBefore.sha256,
      finalSnapshotAndSchemaUnchanged: true,
      originalActorAndLedgerTupleXminRestored: true,
      migrationAddedSystemActors: baseline.positive.migrationAddedSystemActors,
      committedMutations: 0,
      normalDatabaseTouched: false,
      backupManifestChanged: false,
      tupleXminMeaning: "bounded_same_migration_batch_not_statement_exclusive_provenance",
    };
  };
  let result: Awaited<ReturnType<typeof runBody>> | undefined;
  let primaryFailure: AcceptanceFailure | undefined;
  let closeFailure = false;
  try {
    result = await runBody();
  } catch (error) {
    primaryFailure = error instanceof AcceptanceFailure ? error :
      new AcceptanceFailure("migration164_acceptance_failed", undefined, safeSqlState(error));
  } finally {
    try { await connection.client.end(); }
    catch { closeFailure = true; }
  }
  if (primaryFailure) {
    primaryFailure.closeFailure = closeFailure;
    throw primaryFailure;
  }
  if (closeFailure) {
    const error = new AcceptanceFailure("migration164_acceptance_connection_close_failed");
    error.closeFailure = true;
    throw error;
  }
  check(result, "migration164_acceptance_result_missing");
  return result;
}
