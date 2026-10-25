import { z } from "zod";

export const StudioImageUsdSchema = z.string().regex(/^(0|[1-9]\d{0,7})\.\d{8}$/);
export const StudioImageReservationSchema = z.string().regex(/^(0|[1-9]\d{0,7})\.\d{6}$/).refine(value => /[1-9]/.test(value), "Reservation must be positive");
export const StudioImagePricingSchema = z.object({
  estimatedUsd: StudioImageUsdSchema, reservationUsd: StudioImageReservationSchema,
  reference: z.string().trim().min(1).max(500),
}).strict().refine(value => BigInt(value.estimatedUsd.replace(".", "")) <= BigInt(value.reservationUsd.replace(".", "")) * 100n,
  "Estimate exceeds reservation");
export type StudioImagePricing = z.infer<typeof StudioImagePricingSchema>;
