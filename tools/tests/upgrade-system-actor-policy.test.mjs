import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateMigration164ActorPreservation,
  FACTORY_RETENTION_ACTOR_POLICY,
  UpgradeSystemActorPolicyError,
} from "../scripts/upgrade-system-actor-policy.mjs";

const hash = (character) => character.repeat(64);
function facts() {
  return {
    phase: "post_migration",
    originalMigrationCount: 148,
    preMigrationActorAbsent: true,
    canonicalMigration: { hash: FACTORY_RETENTION_ACTOR_POLICY.hash, created_at: "1792566300000" },
    actualMigration: { hash: FACTORY_RETENTION_ACTOR_POLICY.hash, created_at: "1792566300000" },
    matchingLedgerRows: 1,
    originalColumns: [...FACTORY_RETENTION_ACTOR_POLICY.columns],
    currentColumns: [...FACTORY_RETENTION_ACTOR_POLICY.columns],
    actorRows: 1,
    fixedFieldsMatch: true,
    finiteMatchingTimestamps: true,
    memberships: 0,
    actorTupleXmin: "4294967295",
    ledgerTupleXmin: "4294967295",
    appendedRowSha256: hash("b"),
    originalUsers: { rows: 12, sha256: hash("a") },
    currentUsers: { rows: 13, sha256: hash("c") },
    preservedUsers: { rows: 12, sha256: hash("a") },
  };
}

function rejected(value, reason) {
  assert.throws(() => evaluateMigration164ActorPreservation(value), (error) => {
    assert.ok(error instanceof UpgradeSystemActorPolicyError);
    assert.equal(error.code, "upgrade_system_actor_policy_rejected");
    assert.equal(error.message, "upgrade_system_actor_policy_rejected");
    assert.equal(error.reason, reason);
    return true;
  });
}

test("only the exact immediate migration164 append yields a frozen metadata proof without changing its facts", () => {
  const input = facts(), before = JSON.stringify(input);
  const proof = evaluateMigration164ActorPreservation(input);
  assert.deepEqual(proof, {
    version: "migration-0164-system-actor-append-v1",
    migrationOrdinal: 164,
    migrationHash: "0f1b4956a1fa105a7120667f41ed1350fa51d86752df570b1691e5483ca9dfbd",
    migrationCreatedAt: 1792566300000,
    actorId: "00000000-0000-7000-8000-000000000009",
    appendedRowSha256: hash("b"),
    appendedRows: 1,
    originalUsersMatched: true,
    membershipAbsentAtCheck: true,
    boundedSameBatchTupleXid: true,
  });
  assert.ok(Object.isFrozen(proof));
  assert.equal(JSON.stringify(input), before);
  assert.equal(JSON.stringify(proof).includes("oidc_subject"), false);
  assert.equal(JSON.stringify(proof).includes(input.actorTupleXmin), false);
});

test("migration ordinal and array index remain distinct and the exact policy is deeply frozen", () => {
  assert.equal(FACTORY_RETENTION_ACTOR_POLICY.migrationOrdinal, 164);
  assert.equal(FACTORY_RETENTION_ACTOR_POLICY.arrayIndex, 163);
  assert.equal(FACTORY_RETENTION_ACTOR_POLICY.id, "00000000-0000-7000-8000-000000000009");
  assert.equal(FACTORY_RETENTION_ACTOR_POLICY.oidc_subject, "system:factory-erp-source-retention");
  assert.equal(FACTORY_RETENTION_ACTOR_POLICY.email, "factory-erp-retention@system.invalid");
  assert.equal(FACTORY_RETENTION_ACTOR_POLICY.display_name, "Factory ERP source retention");
  assert.deepEqual(FACTORY_RETENTION_ACTOR_POLICY.columns, ["id", "oidc_subject", "email", "display_name", "created_at", "updated_at"]);
  assert.ok(Object.isFrozen(FACTORY_RETENTION_ACTOR_POLICY));
  assert.ok(Object.isFrozen(FACTORY_RETENTION_ACTOR_POLICY.columns));
  assert.throws(() => { FACTORY_RETENTION_ACTOR_POLICY.arrayIndex = 164; }, TypeError);
});

test("backup, restore and pre-migration phases cannot obtain an exclusion proof", () => {
  for (const phase of ["backup", "restore", "pre_migration", "POST_MIGRATION", null]) rejected({ ...facts(), phase }, "invalid_phase");
});

test("a backup already at164 or later and invalid original migration counts are rejected", () => {
  for (const originalMigrationCount of [164, 183, -1, 148.5, "148", Number.NaN])
    rejected({ ...facts(), originalMigrationCount }, "migration_not_pending");
  assert.equal(evaluateMigration164ActorPreservation({ ...facts(), originalMigrationCount: 163 }).migrationOrdinal, 164);
});

test("a preexisting actor cannot be accepted even when the aggregate row delta appears correct", () => {
  for (const preMigrationActorAbsent of [false, "true", null]) rejected({ ...facts(), preMigrationActorAbsent }, "actor_preexisted");
});

test("both canonical and actual ledger pins must equal the frozen SQL hash and journal timestamp", () => {
  for (const field of ["canonicalMigration", "actualMigration"]) {
    rejected({ ...facts(), [field]: { hash: hash("d"), created_at: "1792566300000" } }, "migration_pin_mismatch");
    rejected({ ...facts(), [field]: { hash: FACTORY_RETENTION_ACTOR_POLICY.hash, created_at: "1792566300001" } }, "migration_pin_mismatch");
    rejected({ ...facts(), [field]: { hash: FACTORY_RETENTION_ACTOR_POLICY.hash, created_at: 1792566300000 } }, "migration_pin_mismatch");
  }
});

test("a missing or duplicated migration164 ledger row is rejected", () => {
  for (const matchingLedgerRows of [0, 2, "1"]) rejected({ ...facts(), matchingLedgerRows }, "ledger_ambiguous");
});

test("new, missing, reordered or duplicate actor columns cannot widen the policy", () => {
  for (const field of ["originalColumns", "currentColumns"]) {
    rejected({ ...facts(), [field]: [...FACTORY_RETENTION_ACTOR_POLICY.columns, "future_field"] }, "columns_changed");
    rejected({ ...facts(), [field]: FACTORY_RETENTION_ACTOR_POLICY.columns.slice(0, 5) }, "columns_changed");
    rejected({ ...facts(), [field]: [...FACTORY_RETENTION_ACTOR_POLICY.columns].reverse() }, "columns_changed");
    rejected({ ...facts(), [field]: Array(6).fill("id") }, "columns_changed");
    const sparse = [...FACTORY_RETENTION_ACTOR_POLICY.columns]; delete sparse[1];
    rejected({ ...facts(), [field]: sparse }, "columns_changed");
  }
});

test("the exact actor must occur once and its fixed identity must have matched in SQL", () => {
  for (const actorRows of [0, 2, "1"]) rejected({ ...facts(), actorRows }, "actor_count_mismatch");
  for (const fixedFieldsMatch of [false, "true"]) rejected({ ...facts(), fixedFieldsMatch }, "actor_identity_mismatch");
});

test("nonfinite or microsecond-different SQL timestamps are rejected without reparsing through JavaScript Date", () => {
  rejected({ ...facts(), finiteMatchingTimestamps: false }, "actor_timestamps_mismatch");
  rejected({ ...facts(), finiteMatchingTimestamps: "true" }, "actor_timestamps_mismatch");
});

test("any actor membership blocks the proof without claiming permanent noninteractivity", () => {
  for (const memberships of [1, -1, "0"]) rejected({ ...facts(), memberships }, "actor_has_membership");
  const proof = evaluateMigration164ActorPreservation(facts());
  assert.equal(Object.hasOwn(proof, "noninteractiveAtCheck"), false);
  assert.equal(proof.membershipAbsentAtCheck, true);
});

test("a different row-version transaction or reserved, wrapped or noncanonical tuple XID is rejected", () => {
  rejected({ ...facts(), actorTupleXmin: "42", ledgerTupleXmin: "43" }, "tuple_transaction_mismatch");
  for (const xmin of ["0", "1", "2", "4294967296", "042", "-3", "3.0", "3e0", "", 42])
    rejected({ ...facts(), actorTupleXmin: xmin, ledgerTupleXmin: xmin }, "tuple_transaction_mismatch");
  assert.equal(evaluateMigration164ActorPreservation({ ...facts(), actorTupleXmin: "3", ledgerTupleXmin: "3" }).boundedSameBatchTupleXid, true);
});

test("changed or missing original users fail even when exactly one new row was counted", () => {
  rejected({ ...facts(), preservedUsers: { rows: 12, sha256: hash("d") } }, "original_users_changed");
  rejected({ ...facts(), preservedUsers: { rows: 11, sha256: hash("a") } }, "original_users_changed");
});

test("an extra user or a missing actor append cannot be hidden behind the actor filter", () => {
  for (const rows of [12, 14]) rejected({ ...facts(), currentUsers: { rows, sha256: hash("c") } }, "unexpected_app_users_delta");
});

test("row counts must be nonnegative safe integers and the append cannot overflow", () => {
  for (const field of ["originalUsers", "currentUsers", "preservedUsers"])
    for (const rows of [-1, 1.5, "12", Number.MAX_SAFE_INTEGER + 1])
      rejected({ ...facts(), [field]: { rows, sha256: hash("a") } }, "invalid_row_counts");
  rejected({ ...facts(), originalUsers: { rows: Number.MAX_SAFE_INTEGER, sha256: hash("a") },
    preservedUsers: { rows: Number.MAX_SAFE_INTEGER, sha256: hash("a") }, currentUsers: { rows: Number.MAX_SAFE_INTEGER, sha256: hash("c") } }, "unexpected_app_users_delta");
});

test("every checksum must be a lowercase64-hex value", () => {
  rejected({ ...facts(), appendedRowSha256: "B".repeat(64) }, "invalid_checksum");
  for (const field of ["originalUsers", "currentUsers", "preservedUsers"])
    rejected({ ...facts(), [field]: { rows: 12, sha256: "synthetic-private-value" } }, "invalid_checksum");
});

test("missing, unknown, nested unknown and accessor facts are rejected without leaking raw values", () => {
  for (const key of Object.keys(facts())) { const input = facts(); delete input[key]; rejected(input, "invalid_facts"); }
  rejected({ ...facts(), arbitraryExcludedId: "synthetic-private-value" }, "invalid_facts");
  rejected({ ...facts(), actualMigration: { ...facts().actualMigration, extra: "synthetic-private-value" } }, "invalid_facts");
  rejected({ ...facts(), originalUsers: { ...facts().originalUsers, extra: "synthetic-private-value" } }, "invalid_facts");
  const accessor = facts(); Object.defineProperty(accessor, "memberships", { enumerable: true, get() { throw new Error("must-not-read"); } });
  rejected(accessor, "invalid_facts");
  for (const input of [null, [], "synthetic-private-value"])
    assert.throws(() => evaluateMigration164ActorPreservation(input), (error) => error.message === "upgrade_system_actor_policy_rejected" && !error.message.includes("synthetic-private-value"));
});
