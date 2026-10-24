import { z } from "zod";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { AGENT_FULFILLMENT_COMMAND_VERSION, PrepareAgentFulfillmentCommandSchema } from "@yummyai/contracts/ai/agent-fulfillment-command";
import { FulfillmentCommandKindSchema, PrepareFulfillmentCommandSchema, fulfillmentCommandRequestKey,
  type PrepareFulfillmentCommand, type FulfillmentCommandKind } from "@yummyai/contracts/order/fulfillment-command";

/** Suggestions are neither complete owner inputs nor evidence of a person's actions. */
export const AGENT_FULFILLMENT_PROPOSAL_VERSION = "erp-agent-fulfillment-proposal-v1" as const;
const Id = EntityIdSchema.refine(value => value === value.toLowerCase(), "Use canonical original references");
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const agentModelOperatorFieldNames = ["verifiedByOperator", "segregationConfirmed", "physicalSelectionConfirmed", "orderUnitConfirmed",
  "operatorChecks", "confirmationToken", "confirmationExpiresAt"] as const;
export const agentFulfillmentModelForbiddenKeys = [...agentModelOperatorFieldNames, "requestId", "idempotencyKey", "externalEventId"] as const;
const forbidden = new Set<string>(agentFulfillmentModelForbiddenKeys);
function assertModelFields(raw: unknown, rejected: ReadonlySet<string>): void {
  function visit(value: unknown, depth: number) {
    if (depth > 32) throw new Error("agent_proposal_depth_invalid");
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(child => visit(child, depth + 1)); return; }
    for (const [key, child] of Object.entries(value)) {
      if (rejected.has(key) || ["__proto__", "constructor", "prototype"].includes(key)) throw new Error("agent_proposal_operator_field_forbidden");
      visit(child, depth + 1);
    }
  }
  visit(raw, 0);
}
export const assertAgentFulfillmentModelFields = (raw: unknown) => assertModelFields(raw, forbidden);
export const assertAgentModelOperatorFields = (raw: unknown) => assertModelFields(raw, new Set<string>(agentModelOperatorFieldNames));

type ModelSuggestion<T> = T extends readonly (infer Item)[] ? ModelSuggestion<Item>[] : T extends object
  ? { [Key in keyof T as Key extends typeof agentFulfillmentModelForbiddenKeys[number] ? never : Key]?: ModelSuggestion<T[Key]> } : T;
type InputFor<Kind extends FulfillmentCommandKind> = Extract<PrepareFulfillmentCommand, { kind: Kind }>["input"];
/** Derive only value shapes from the original schemas. Complete owner rules run on explicit preparation. */
function suggestions<Schema extends z.ZodType>(original: Schema): z.ZodType<ModelSuggestion<z.infer<Schema>>> {
  function project(raw: unknown): unknown {
    if (Array.isArray(raw)) return raw.map(project);
    if (!raw || typeof raw !== "object") return raw;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key === "default" || key === "required") continue;
      if (key === "properties") {
        result.properties = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([name]) => !forbidden.has(name)).map(([name, schema]) => [name, project(schema)]));
        result.required = [];
        result.additionalProperties = false;
      } else result[key] = project(value);
    }
    return result;
  }
  const schema = project(z.toJSONSchema(original, { io: "input" })) as Parameters<typeof z.fromJSONSchema>[0];
  return z.fromJSONSchema(schema) as z.ZodType<ModelSuggestion<z.infer<Schema>>>;
}
const originalInputs = Object.fromEntries(PrepareFulfillmentCommandSchema.options.map(value => [value.shape.kind.value, value.shape.input]));
export const agentFulfillmentSuggestionInputSchemas = Object.fromEntries(FulfillmentCommandKindSchema.options.map(kind => [kind, suggestions(originalInputs[kind]!)])) as {
  [Kind in FulfillmentCommandKind]: z.ZodType<ModelSuggestion<InputFor<Kind>>>;
};

export const AgentFulfillmentProposalSourceSchema = z.object({ stepId: z.uuidv7(), resultIndex: z.int().min(0).max(127), dataChecksum: Hash,
  orderId: Id, expectedSequence: z.int().positive() }).strict();
export type AgentFulfillmentProposalSource = z.infer<typeof AgentFulfillmentProposalSourceSchema>;
const target = { targetId: Id };
export const AgentFulfillmentSuggestionOriginalSchema = z.discriminatedUnion("kind", [
  z.object({ ...target, kind: z.literal("delivery_create"), input: agentFulfillmentSuggestionInputSchemas.delivery_create }).strict(),
  z.object({ ...target, kind: z.literal("delivery_feedback"), packageId: Id, input: agentFulfillmentSuggestionInputSchemas.delivery_feedback }).strict(),
  z.object({ ...target, kind: z.literal("production_milestone"), input: agentFulfillmentSuggestionInputSchemas.production_milestone }).strict(),
  z.object({ ...target, kind: z.literal("quality_inspection"), input: agentFulfillmentSuggestionInputSchemas.quality_inspection }).strict(),
  z.object({ ...target, kind: z.literal("quality_group_inspection"), input: agentFulfillmentSuggestionInputSchemas.quality_group_inspection }).strict(),
  z.object({ ...target, kind: z.literal("production_recovery"), input: agentFulfillmentSuggestionInputSchemas.production_recovery }).strict(),
  z.object({ ...target, kind: z.literal("whole_production_milestone"), input: agentFulfillmentSuggestionInputSchemas.whole_production_milestone }).strict(),
  z.object({ ...target, kind: z.literal("whole_quality_inspection"), input: agentFulfillmentSuggestionInputSchemas.whole_quality_inspection }).strict(),
  z.object({ ...target, kind: z.literal("shipment_create"), input: agentFulfillmentSuggestionInputSchemas.shipment_create }).strict(),
  z.object({ ...target, kind: z.literal("whole_shipment_create"), input: agentFulfillmentSuggestionInputSchemas.whole_shipment_create }).strict(),
  z.object({ ...target, kind: z.literal("shipment_version"), input: agentFulfillmentSuggestionInputSchemas.shipment_version }).strict(),
  z.object({ ...target, kind: z.literal("shipment_review"), versionId: Id, input: agentFulfillmentSuggestionInputSchemas.shipment_review }).strict(),
  z.object({ ...target, kind: z.literal("shipment_dispatch"), input: agentFulfillmentSuggestionInputSchemas.shipment_dispatch }).strict(),
  z.object({ ...target, kind: z.literal("shipment_platform_confirmation"), input: agentFulfillmentSuggestionInputSchemas.shipment_platform_confirmation }).strict(),
]);
export const AgentFulfillmentSuggestionSchema = z.object({ version: z.literal(AGENT_FULFILLMENT_PROPOSAL_VERSION), domain: z.literal("fulfillment"),
  source: AgentFulfillmentProposalSourceSchema, original: AgentFulfillmentSuggestionOriginalSchema }).strict().superRefine((value, ctx) => {
  try { assertAgentFulfillmentModelFields(value); }
  catch { ctx.addIssue({ code: "custom", message: "Model suggestions cannot contain operator assertions, execution credentials or request keys" }); }
});
export type AgentFulfillmentSuggestion = z.infer<typeof AgentFulfillmentSuggestionSchema>;
export function parseAgentFulfillmentSuggestion(raw: unknown): AgentFulfillmentSuggestion {
  assertAgentFulfillmentModelFields(raw);
  return AgentFulfillmentSuggestionSchema.parse(raw);
}
export const canonicalAgentFulfillmentSuggestion = (raw: unknown) => canonicalJson(parseAgentFulfillmentSuggestion(raw));
export const AgentFulfillmentOperatorCheckSchema = z.object({ key: z.enum(["verified_by_operator", "physical_segregation", "physical_selection", "order_unit_confirmed"]),
  path: z.array(z.union([z.string().min(1).max(100), z.int().nonnegative()])).min(1).max(16),
  state: z.literal("pending"), requiredWhen: z.enum(["always", "quality_group_selected", "manufacturing_selected"]) }).strict();
export type AgentFulfillmentOperatorCheck = z.infer<typeof AgentFulfillmentOperatorCheckSchema>;
export function agentFulfillmentOperatorChecks(kind: FulfillmentCommandKind): AgentFulfillmentOperatorCheck[] {
  if (kind === "delivery_feedback") return [{ key: "verified_by_operator", path: ["input", "verifiedByOperator"], state: "pending", requiredWhen: "always" }];
  if (kind === "quality_group_inspection") return [{ key: "physical_segregation", path: ["input", "segregationConfirmed"], state: "pending", requiredWhen: "always" }];
  if (kind === "production_recovery") return [
    { key: "physical_selection", path: ["input", "physicalSelectionConfirmed"], state: "pending", requiredWhen: "quality_group_selected" },
    { key: "order_unit_confirmed", path: ["input", "manufacturing", "orderUnitConfirmed"], state: "pending", requiredWhen: "manufacturing_selected" },
  ];
  return [];
}

/** Exact parent slot and original source identity survive operator edits to suggested values. */
export function bindAgentFulfillmentCompletion(suggestion: AgentFulfillmentSuggestion, slotId: string, raw: unknown) {
  const fixed = parseAgentFulfillmentSuggestion(suggestion), slot = z.uuidv7().parse(slotId), completed = PrepareAgentFulfillmentCommandSchema.parse(raw);
  const expected = fixed.original, actual = completed.original;
  if (completed.version !== AGENT_FULFILLMENT_COMMAND_VERSION || completed.orderId !== fixed.source.orderId || actual.requestId !== slot
    || fulfillmentCommandRequestKey(actual) !== slot || actual.kind !== expected.kind || actual.targetId !== expected.targetId
    || expected.kind === "delivery_feedback" && (actual.kind !== "delivery_feedback" || actual.packageId !== expected.packageId)
    || expected.kind === "shipment_review" && (actual.kind !== "shipment_review" || actual.versionId !== expected.versionId))
    throw new Error("agent_fulfillment_completion_identity_mismatch");
  return completed;
}
