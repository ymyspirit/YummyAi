import { sql, type SQLWrapper } from "drizzle-orm";
import { customType } from "drizzle-orm/pg-core";
import { stockQuantityString, stockQuantityValue, type StockQuantity } from "@yummyai/contracts/inventory/quantity";

/** Unconstrained numeric: a declared SQL scale would round before CHECK runs. */
export const stockQuantity = customType<{ data: StockQuantity; driverData: string }>({
  dataType: () => "numeric",
  fromDriver: value => stockQuantityValue(value),
  toDriver: value => stockQuantityString(value),
});

export function exactStockQuantity(column: SQLWrapper, unit: SQLWrapper) {
  return sql`${column} between -2147483647 and 2147483647 and scale(${column}) <= 9
    and (${unit} not in ('each','pair','set') or trunc(${column}) = ${column})`;
}

export function exactAggregateStockQuantity(column: SQLWrapper) {
  return sql`${column} between -999999999999999999999999999999 and 999999999999999999999999999999 and scale(${column}) <= 9`;
}
