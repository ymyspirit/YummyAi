import { createHash } from "node:crypto";

export function catalogFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item: unknown) => {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const record = item as Record<string, unknown>;
          return Object.fromEntries(
            Object.keys(record)
              .sort()
              .map((key) => [key, record[key]]),
          );
        }
        return item;
      }),
    )
    .digest("hex");
}
