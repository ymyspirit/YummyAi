import { z } from "zod";

/** Shared filters only. Each owning domain defines its own task facts and closure. */
export const BusinessTaskInboxQuerySchema = z
  .object({
    assignment: z.enum(["mine", "unassigned", "visible"]).default("mine"),
    status: z.enum(["open", "closed", "all"]).default("open"),
    due: z.enum(["any", "overdue", "today", "unset"]).default("any"),
    q: z.string().trim().max(200).default(""),
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    sort: z.enum(["deadline", "updated"]).default("deadline"),
    timeZone: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .default("UTC")
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "Unsupported time zone"),
  })
  .strict()
  .refine(
    (value) => value.status === "open" || value.due === "any",
    "Due filters apply to open tasks",
  );

export type BusinessTaskInboxQuery = z.infer<typeof BusinessTaskInboxQuerySchema>;
