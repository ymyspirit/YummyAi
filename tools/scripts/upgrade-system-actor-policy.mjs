/** A single migration effect, never a general backup/restore exclusion policy. */
export const FACTORY_RETENTION_ACTOR_POLICY = Object.freeze({
  version: "migration-0164-system-actor-append-v1",
  id: "00000000-0000-7000-8000-000000000009",
  oidc_subject: "system:factory-erp-source-retention",
  email: "factory-erp-retention@system.invalid",
  display_name: "Factory ERP source retention",
  columns: Object.freeze(["id", "oidc_subject", "email", "display_name", "created_at", "updated_at"]),
  migrationOrdinal: 164,
  arrayIndex: 163,
  hash: "0f1b4956a1fa105a7120667f41ed1350fa51d86752df570b1691e5483ca9dfbd",
  createdAt: 1792566300000,
});

export class UpgradeSystemActorPolicyError extends Error {
  constructor(reason) {
    super("upgrade_system_actor_policy_rejected");
    this.name = "UpgradeSystemActorPolicyError";
    this.code = "upgrade_system_actor_policy_rejected";
    this.reason = reason;
  }
}

const factKeys = Object.freeze([
  "phase", "originalMigrationCount", "preMigrationActorAbsent", "canonicalMigration", "actualMigration",
  "matchingLedgerRows", "originalColumns", "currentColumns", "actorRows", "fixedFieldsMatch",
  "finiteMatchingTimestamps", "memberships", "actorTupleXmin", "ledgerTupleXmin", "appendedRowSha256",
  "originalUsers", "currentUsers", "preservedUsers",
]);
const hashPattern = /^[a-f0-9]{64}$/;
const reject = (reason) => { throw new UpgradeSystemActorPolicyError(reason); };

function exactRecord(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject("invalid_facts");
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key)) ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some((descriptor) => !Object.hasOwn(descriptor, "value")))
    reject("invalid_facts");
}

function exactColumns(columns) {
  return Array.isArray(columns) && columns.length === FACTORY_RETENTION_ACTOR_POLICY.columns.length &&
    FACTORY_RETENTION_ACTOR_POLICY.columns.every((column, index) => columns[index] === column);
}

function tupleXid(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,9}$/.test(value)) return false;
  const numeric = Number(value);
  return numeric >= 3 && numeric <= 4294967295;
}

/**
 * Facts must be collected by the operational caller, including precise PG
 * timestamp equality, in the immediate post-migration verification phase.
 * xmin is a bounded batch consistency check, not a permanent full-XID proof.
 * This function performs no I/O, hashes no private row and changes no input.
 *
 * @param {unknown} facts
 */
export function evaluateMigration164ActorPreservation(facts) {
  exactRecord(facts, factKeys);
  exactRecord(facts.canonicalMigration, ["hash", "created_at"]);
  exactRecord(facts.actualMigration, ["hash", "created_at"]);
  for (const summary of [facts.originalUsers, facts.currentUsers, facts.preservedUsers]) exactRecord(summary, ["rows", "sha256"]);

  if (facts.phase !== "post_migration") reject("invalid_phase");
  if (!Number.isSafeInteger(facts.originalMigrationCount) || facts.originalMigrationCount < 0 ||
      facts.originalMigrationCount >= FACTORY_RETENTION_ACTOR_POLICY.migrationOrdinal) reject("migration_not_pending");
  if (facts.preMigrationActorAbsent !== true) reject("actor_preexisted");
  for (const migration of [facts.canonicalMigration, facts.actualMigration]) {
    if (migration.hash !== FACTORY_RETENTION_ACTOR_POLICY.hash ||
        migration.created_at !== String(FACTORY_RETENTION_ACTOR_POLICY.createdAt)) reject("migration_pin_mismatch");
  }
  if (facts.matchingLedgerRows !== 1) reject("ledger_ambiguous");
  if (!exactColumns(facts.originalColumns) || !exactColumns(facts.currentColumns)) reject("columns_changed");
  if (facts.actorRows !== 1) reject("actor_count_mismatch");
  if (facts.fixedFieldsMatch !== true) reject("actor_identity_mismatch");
  if (facts.finiteMatchingTimestamps !== true) reject("actor_timestamps_mismatch");
  if (facts.memberships !== 0) reject("actor_has_membership");
  if (!tupleXid(facts.actorTupleXmin) || !tupleXid(facts.ledgerTupleXmin) ||
      facts.actorTupleXmin !== facts.ledgerTupleXmin) reject("tuple_transaction_mismatch");
  if (typeof facts.appendedRowSha256 !== "string" || !hashPattern.test(facts.appendedRowSha256)) reject("invalid_checksum");
  for (const summary of [facts.originalUsers, facts.currentUsers, facts.preservedUsers]) {
    if (!Number.isSafeInteger(summary.rows) || summary.rows < 0) reject("invalid_row_counts");
    if (typeof summary.sha256 !== "string" || !hashPattern.test(summary.sha256)) reject("invalid_checksum");
  }
  if (facts.preservedUsers.rows !== facts.originalUsers.rows ||
      facts.preservedUsers.sha256 !== facts.originalUsers.sha256) reject("original_users_changed");
  if (facts.originalUsers.rows >= Number.MAX_SAFE_INTEGER ||
      facts.currentUsers.rows !== facts.originalUsers.rows + 1) reject("unexpected_app_users_delta");

  return Object.freeze({
    version: FACTORY_RETENTION_ACTOR_POLICY.version,
    migrationOrdinal: FACTORY_RETENTION_ACTOR_POLICY.migrationOrdinal,
    migrationHash: FACTORY_RETENTION_ACTOR_POLICY.hash,
    migrationCreatedAt: FACTORY_RETENTION_ACTOR_POLICY.createdAt,
    actorId: FACTORY_RETENTION_ACTOR_POLICY.id,
    appendedRowSha256: facts.appendedRowSha256,
    appendedRows: 1,
    originalUsersMatched: true,
    membershipAbsentAtCheck: true,
    boundedSameBatchTupleXid: true,
  });
}
