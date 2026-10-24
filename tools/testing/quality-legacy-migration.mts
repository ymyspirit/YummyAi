import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import type { DatabaseConnection } from "../../packages/database/src/client.ts";

/** Fresh disposable databases only. Replays the actual canonical pre-0130 ledger. */
export async function migrateQualityLegacyDatabase(connection: DatabaseConnection, expectedName: string) {
  return migrateCanonicalLegacyDatabase(connection, expectedName, "0130_quality_assessment");
}

export async function migrateShipmentLegacyDatabase(connection: DatabaseConnection, expectedName: string) {
  return migrateCanonicalLegacyDatabase(connection, expectedName, "0131_shipment_production_sources");
}

export async function migrateQualityGroupsLegacyDatabase(connection: DatabaseConnection, expectedName: string) {
  return migrateCanonicalLegacyDatabase(connection, expectedName, "0132_quality_physical_groups");
}

export async function migrateManufacturingLegacyDatabase(connection: DatabaseConnection, expectedName: string) {
  return migrateCanonicalLegacyDatabase(connection, expectedName, "0134_production_manufacturing_bindings");
}
export async function migrateManufacturingDeliveryLegacyDatabase(connection: DatabaseConnection, expectedName: string) {
  return migrateCanonicalLegacyDatabase(connection, expectedName, "0135_manufacturing_delivery");
}
export async function migrateShiposLegacyDatabase(connection: DatabaseConnection, expectedName: string) {
  return migrateCanonicalLegacyDatabase(connection, expectedName, "0137_shipos_observation_order");
}

export async function migrateInventoryLegacyDatabase(connection: DatabaseConnection, expectedName: string) {
  return migrateCanonicalLegacyDatabase(connection, expectedName, "0138_inventory_exact_quantities");
}
export async function migrateReceiptRequestLegacyDatabase(connection: DatabaseConnection, expectedName: string) {
  return migrateCanonicalLegacyDatabase(connection, expectedName, "0142_procurement_receipt_request_evidence");
}
export async function migrateIncomingLegacyDatabase(connection: DatabaseConnection, expectedName: string) {
  return migrateCanonicalLegacyDatabase(connection, expectedName, "0143_procurement_receipt_exact_quantities");
}
export async function migrateProcurementLegacyDatabase(connection: DatabaseConnection, expectedName: string) {
  return migrateCanonicalLegacyDatabase(connection, expectedName, "0146_procurement_original_request_evidence");
}

export async function migrateProcurementPrecisionLegacyDatabase(connection: DatabaseConnection, expectedName: string) {
  return migrateCanonicalLegacyDatabase(connection, expectedName, "0149_procurement_measurement_invoices");
}
export async function migrateInvoiceCommandLegacyDatabase(connection: DatabaseConnection, expectedName: string) {
  return migrateCanonicalLegacyDatabase(connection, expectedName, "0150_procurement_invoice_commands");
}
export async function migrateInvoiceReconciliationLegacyDatabase(connection: DatabaseConnection, expectedName: string) {
  // The upgrade fixture first creates a genuine old invoice with the retained 148
  // owner, then uses the frozen 150 migrator/owner before verifying 150 -> 151.
  return migrateCanonicalLegacyDatabase(connection, expectedName, "0149_procurement_measurement_invoices");
}
export async function migrateFinanceMonetaryLegacyDatabase(connection: DatabaseConnection, expectedName: string) {
  return migrateCanonicalLegacyDatabase(connection, expectedName, "0152_finance_monetary_basis");
}
export async function migrateFinancePayablesLegacyDatabase(connection: DatabaseConnection, expectedName: string) {
  // The actual148 owner first creates historical invoices. The retained152
  // migrator/owner then produces a genuine proof with legacy_unknown basis.
  return migrateCanonicalLegacyDatabase(connection, expectedName, "0149_procurement_measurement_invoices");
}

export async function migrateFinanceAuthorityLegacyDatabase(connection: DatabaseConnection, expectedName: string) {
  return migrateCanonicalLegacyDatabase(connection, expectedName, "0154_finance_source_authority");
}
export async function migrateFinancePayablesAdjustmentsLegacyDatabase(connection: DatabaseConnection, expectedName: string) {
  return migrateCanonicalLegacyDatabase(connection, expectedName, "0155_finance_payable_adjustments");
}

export function migrateFinanceCostAllocationLegacyDatabase(connection: DatabaseConnection, expectedName: string) {
  return migrateCanonicalLegacyDatabase(connection, expectedName, "0156_finance_cost_allocation");
}

export function migrateFinanceCommandLegacyDatabase(connection: DatabaseConnection, expectedName: string) {
  return migrateCanonicalLegacyDatabase(connection, expectedName, "0157_finance_original_commands");
}

export function migrateFactoryCapacityLegacyDatabase(connection: DatabaseConnection, expectedName: string) {
  return migrateCanonicalLegacyDatabase(connection, expectedName, "0159_factory_capacity_ledger");
}

async function migrateCanonicalLegacyDatabase(connection: DatabaseConnection, expectedName: string, targetTag: string) {
  if (!/^order_daily_e2e_[a-f0-9]{32}$/.test(expectedName)) throw new Error("Legacy quality migration requires a disposable database");
  const [actual] = await connection.client.unsafe("select current_database() as name,to_regclass('drizzle.__drizzle_migrations') as ledger");
  if (actual?.name !== expectedName || actual.ledger !== null) throw new Error("Legacy quality migration requires the exact fresh database");
  const requireDatabase = createRequire(new URL("../../packages/database/package.json", import.meta.url));
  const { readMigrationFiles } = requireDatabase("drizzle-orm/migrator");
  const migrationsFolder = fileURLToPath(new URL("../../packages/database/migrations/", import.meta.url));
  const journal = JSON.parse(await readFile(new URL("../../packages/database/migrations/meta/_journal.json", import.meta.url), "utf8"));
  const target = journal.entries.find((entry: { tag: string }) => entry.tag === targetTag);
  if (!target) throw new Error("Canonical quality migration missing");
  const migrations = (readMigrationFiles({ migrationsFolder }) as Array<{ folderMillis: number; sql: string[]; hash: string }>)
    .filter(migration => migration.folderMillis < target.when);
  if (!migrations.length) throw new Error("Legacy migration history missing");
  await connection.client.begin(async tx => {
    await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('yummyai-schema-migrations',0))");
    await tx.unsafe("create schema drizzle");
    await tx.unsafe("create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
    for (const migration of migrations) {
      for (const statement of migration.sql) await tx.unsafe(statement);
      await tx.unsafe("insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)", [migration.hash, migration.folderMillis]);
    }
  });
}
