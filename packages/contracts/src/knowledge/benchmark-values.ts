import { z } from "zod";

// Decimal strings preserve quantities, currency precision and small costs.
export const BenchmarkDecimalSchema = z.string().regex(/^-?(0|[1-9]\d{0,11})(\.\d{1,9})?$/);
export const BenchmarkTypedAnswerSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,59}$/),
  value: BenchmarkDecimalSchema,
  unit: z.string().trim().min(1).max(40),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  evidence: z.array(z.object({ sourceId: z.string().min(1).max(180), detail: z.string().min(1).max(500) }).strict()).max(12),
}).strict();
export type BenchmarkTypedAnswer = z.infer<typeof BenchmarkTypedAnswerSchema>;
