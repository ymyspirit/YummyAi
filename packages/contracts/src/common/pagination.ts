import { z } from "zod";

export const PageRequestSchema = z.object({
  cursor: z.string().optional(),
  limit: z.int().min(1).max(100).default(20),
});

export const PageResultSchema = z.object({
  items: z.array(z.unknown()),
  nextCursor: z.string().nullable(),
});
