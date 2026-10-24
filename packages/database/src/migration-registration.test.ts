import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("migration source registration", () => {
  const folder = fileURLToPath(new URL("../migrations/", import.meta.url));
  const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as {
    entries: Array<{ idx: number; when: number; tag: string }>;
  };
  it("registers every checked-in SQL source exactly once", () => {
    const files = readdirSync(folder).filter(name => name.endsWith(".sql")).sort();
    const registered = journal.entries.map(entry => entry.tag + ".sql").sort();
    expect(new Set(registered).size).toBe(registered.length);
    expect(registered).toEqual(files);
  });
  it("keeps migration identifiers and execution timestamps strictly ordered", () => {
    for (let index = 1; index < journal.entries.length; index++) {
      expect(journal.entries[index]!.idx).toBeGreaterThan(journal.entries[index - 1]!.idx);
      expect(journal.entries[index]!.when).toBeGreaterThan(journal.entries[index - 1]!.when);
    }
  });
});
