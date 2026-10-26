import { z } from "zod";
const Money = z.string().regex(/^(0|[1-9]\d{0,7})\.\d{6}$/);
const PositiveMoney = Money.refine(value => /[1-9]/.test(value), "Budget must be positive");
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const StudioImageBudgetSettingsSchema = z.object({
  revision: Hash.nullable(), monthlyCapUsd: PositiveMoney, defaultTaskCapUsd: PositiveMoney, imageTaskCapUsd: PositiveMoney,
}).strict();
export type StudioImageBudgetSettings = z.infer<typeof StudioImageBudgetSettingsSchema>;
export const StudioImageBudgetWorkspaceSchema = z.object({
  version: z.literal(1), revision: Hash.nullable(), periodStart: z.iso.datetime(), periodEnd: z.iso.datetime(),
  occupiedUsd: z.string().regex(/^(0|[1-9]\d{0,15})\.\d{6}$/),
  policy: z.object({ monthlyCapUsd: Money, defaultTaskCapUsd: Money, imageTaskCapUsd: Money.nullable(),
    imageCapSource: z.enum(["specific", "default", "invalid"]) }).strict().nullable(),
}).strict();
export type StudioImageBudgetWorkspace = z.infer<typeof StudioImageBudgetWorkspaceSchema>;
