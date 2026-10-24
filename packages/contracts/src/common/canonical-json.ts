/** Stable transport-independent JSON, including PostgreSQL JSONB key reordering. */
export function canonicalJson(value: unknown): string {
  function normalize(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, normalize(item)]),
      );
    return input;
  }
  return JSON.stringify(normalize(value));
}
