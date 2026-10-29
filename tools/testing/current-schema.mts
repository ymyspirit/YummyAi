import { readFileSync } from "node:fs";

/** The migration target belongs to this checkout, never to a caller-selected environment value. */
export function currentSchemaVersion(): number {
  const journal = JSON.parse(readFileSync(new URL("../../packages/database/migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries?: unknown };
  if (!Array.isArray(journal.entries) || journal.entries.length === 0 || journal.entries.some((raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return true;
    const entry = raw as Record<string, unknown>;
    return !Number.isSafeInteger(entry.idx) || (entry.idx as number) < 0 || typeof entry.tag !== "string" || !/^\d{4}_[a-z0-9_]+$/.test(entry.tag);
  })) throw new Error("test_current_migration_journal_invalid");
  return journal.entries.length;
}
