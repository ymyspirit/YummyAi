import { z } from "zod";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";
import { InventoryUnitSchema } from "@yummyai/contracts/inventory";

const Checksum = z.string().regex(/^[a-f0-9]{64}$/);
const Positive = z.int().positive().max(1_000_000_000);
const Responsibility = z.enum(["merchant", "factory"]);
const Code = z.string().trim().min(1).max(64);
const Name = z.string().trim().min(1).max(200);
/** Explicit factory projection. Internal stock IDs, costs, timing and BOM notes never enter it. */
export const FactoryManufacturingPlanContentSchema = z.object({
  schemaVersion: z.literal(1), code: Code, name: Name, versionNumber: z.int().positive(),
  sourceContentChecksum: Checksum, quantity: Positive, unit: z.enum(["each", "pair", "set"]),
  recipeOutputQuantity: Positive, proposalOnly: z.literal(true),
  materials: z.array(z.object({ code: Code, name: Name, unit: InventoryUnitSchema, responsibility: Responsibility,
    operationCode: Code.nullable(), recipeQuantityNumerator: Positive, recipeQuantityDenominator: Positive,
    lossBps: z.int().min(0).max(100000), lossBasis: z.enum(["add_to_net", "fraction_of_input"]),
    plannedNumerator: z.string().regex(/^[1-9]\d*$/), plannedDenominator: z.string().regex(/^[1-9]\d*$/),
  }).strict()).min(1).max(200),
  operations: z.array(z.object({ code: Code, name: Name, processCode: Code, responsibility: Responsibility }).strict()).min(1).max(200),
}).strict();
export const FactoryManufacturingPlanSchema = FactoryManufacturingPlanContentSchema.extend({ checksum: Checksum }).strict();
export const ProductionDeliveryManufacturingSchema = z.object({
  bindingId: Id, versionId: Id, specificationVersionId: Id, sourceWorkRevisionId: Id.nullable(), sourceContentChecksum: Checksum,
  plan: FactoryManufacturingPlanSchema,
}).strict().refine(value => value.sourceContentChecksum === value.plan.sourceContentChecksum,
  { path: ["sourceContentChecksum"], message: "制造来源指纹必须一致" });
export type FactoryManufacturingPlan = z.infer<typeof FactoryManufacturingPlanSchema>;
export type ProductionDeliveryManufacturing = z.infer<typeof ProductionDeliveryManufacturingSchema>;
