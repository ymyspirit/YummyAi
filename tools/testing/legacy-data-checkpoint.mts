import type { DatabaseConnection } from "../../packages/database/src/client.ts";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

/** Captures original columns once; subsequent snapshots cannot include new fields
 * or tables and therefore cannot hide a rewrite behind a schema upgrade. */
export async function captureLegacyDataCheckpoint(database: DatabaseConnection) {
  requireDisposableIntegrationEnvironment();
  const expected = decodeURIComponent(new URL(process.env.DATABASE_URL!).pathname.slice(1));
  const [actual] = await database.client.unsafe("select current_database() as name");
  if (actual?.name !== expected || !/^order_daily_e2e_[a-f0-9]{32}$/.test(expected)) throw new Error("Exact disposable legacy database required");
  const columns = await database.client.unsafe("select table_name,column_name from information_schema.columns where table_schema='public' order by table_name,ordinal_position");
  const tables = new Map<string, string[]>();
  for (const row of columns) {
    const table = String(row.table_name), field = String(row.column_name);
    if (!/^[a-z_][a-z0-9_]*$/.test(table) || !/^[a-z_][a-z0-9_]*$/.test(field)) throw new Error("Unexpected legacy identifier");
    tables.set(table, [...tables.get(table) ?? [], field]);
  }
  return { tableCount: tables.size, snapshot: () => database.client.begin(async tx => {
    await tx.unsafe("set local time zone 'UTC'");
    const snapshot: Array<{ table: string; rows: number; hash: string }> = [];
    for (const [table, fields] of tables) {
      const [row] = await tx.unsafe(`select count(*)::int as rows,md5(coalesce(string_agg(row_to_json(s)::text,E'\\n' order by row_to_json(s)::text),'')) as hash from (select ${fields.map(field => '"' + field + '"').join(",")} from "${table}") s`);
      snapshot.push({ table, rows: Number(row!.rows), hash: String(row!.hash) });
    }
    return snapshot;
  }) };
}
