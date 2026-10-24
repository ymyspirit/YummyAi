import { z } from "zod";
import { compareStockQuantity, stockQuantityValue, stockQuantityWithinCommandLimit } from "@yummyai/contracts/inventory/quantity";

export const StockQuantityViewSchema = z.union([z.number(), z.string().max(41)]).transform((value, context) => {
  try {
    return stockQuantityValue(value);
  } catch {
    context.addIssue({ code: "custom", message: "Use a safe whole number or a decimal string with at most nine decimal places" });
    return z.NEVER;
  }
});

export const NonnegativeStockQuantitySchema = StockQuantityViewSchema.refine(value => compareStockQuantity(value, 0) >= 0, {
  message: "Stock quantity cannot be negative",
});

export const PositiveStockQuantitySchema = StockQuantityViewSchema.refine(value => compareStockQuantity(value, 0) > 0 && stockQuantityWithinCommandLimit(value), {
  message: "Stock quantity must be positive and at most 2147483647",
});

export const SignedStockQuantitySchema = StockQuantityViewSchema.refine(value => compareStockQuantity(value, 0) !== 0 && stockQuantityWithinCommandLimit(value), {
  message: "Stock quantity delta must be nonzero and within the supported command range",
});
