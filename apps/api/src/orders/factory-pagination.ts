import { BadRequestException } from "@nestjs/common";
import { and, lt, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
const ExactTime = z.iso.datetime().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
const Cursor = z.object({
  at: z.iso.datetime().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.(?:\d{3}|\d{6})Z$/),
  id: z.uuidv7().transform(value => value.toLowerCase()),
}).strict();
type Position = z.infer<typeof Cursor>;
type Anchor = { createdAtExact: string; id: string };
function invalidCursor(): never {
  throw new BadRequestException("分页位置无效，请重新读取");
}
export function factoryCursor(cursor: string | undefined) {
  if (!cursor) return null;
  try {
    if (cursor.length > 240 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return invalidCursor();
    return Cursor.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    return invalidCursor();
  }
}
/** Obtain PostgreSQL's full timestamp precision without passing through JS Date. */
export function factoryCursorTimestamp(column: AnyPgColumn) {
  return sql<string>`to_char(${column} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}
/** The owning query must locate this anchor inside its original visible/filter set. */
export function resolveFactoryCursor(cursor: Position | null, anchor: Anchor | undefined): Position | null {
  if (!cursor) return null;
  if (!anchor || anchor.id !== cursor.id || !ExactTime.safeParse(anchor.createdAtExact).success) return invalidCursor();
  // Historical tokens retained milliseconds only. Recover the real instant from
  // the immutable visible anchor rather than applying the truncated boundary.
  const expected = cursor.at.length === 24 ? `${anchor.createdAtExact.slice(0, 23)}Z` : anchor.createdAtExact;
  if (cursor.at !== expected) return invalidCursor();
  return { at: anchor.createdAtExact, id: anchor.id };
}
export function factoryCursorBefore(createdAt: AnyPgColumn, id: AnyPgColumn, cursor: Position | null) {
  return cursor ? or(
    sql`${createdAt}<${cursor.at}::timestamptz`,
    and(sql`${createdAt}=${cursor.at}::timestamptz`, lt(id, cursor.id)),
  ) : undefined;
}
export function nextFactoryCursor(
  row: Anchor | undefined,
  hasMore: boolean,
) {
  return hasMore && row
    ? Buffer.from(JSON.stringify({ at: ExactTime.parse(row.createdAtExact), id: row.id })).toString(
        "base64url",
      )
    : null;
}
