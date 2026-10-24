import { z } from "zod";
import {
  HarnessExecutionContractSchema,
  HarnessToolDescriptorSchema,
} from "@yummyai/contracts/harness";
import { KnowledgeReferenceSchema } from "@yummyai/contracts/knowledge";

const Id = z.uuidv7(),
  Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Key = z.string().regex(/^[a-z][a-z0-9_.-]{2,159}$/);
export const RegisteredAgentMethodSchema = z
  .object({
    methodKey: Key,
    label: z.string().min(1).max(160),
    instructions: z.string().min(1).max(32000),
    steps: z.array(z.string().min(1).max(160)).min(1).max(32),
    executionContract: HarnessExecutionContractSchema,
    tools: z.array(HarnessToolDescriptorSchema).min(1).max(32),
  })
  .strict();
export const AgentMethodDefinitionSchema = RegisteredAgentMethodSchema.extend({
  notes: z.string().max(4000),
  knowledgeReferences: z.array(KnowledgeReferenceSchema).max(4),
}).strict();
export type RegisteredAgentMethod = z.infer<typeof RegisteredAgentMethodSchema>;
export type AgentMethodDefinition = z.infer<typeof AgentMethodDefinitionSchema>;
export const AgentMethodSelectionSchema = z.discriminatedUnion("mode", [
  z
    .object({
      schemaVersion: z.literal("agent-method-selection-v1"),
      mode: z.literal("builtin"),
      methodKey: Key,
      contractChecksum: Hash,
      withdrawalGeneration: z.int().nonnegative(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal("agent-method-selection-v1"),
      mode: z.literal("published"),
      methodKey: Key,
      contractChecksum: Hash,
      withdrawalGeneration: z.int().nonnegative(),
      methodId: Id,
      versionId: Id,
      version: z.int().positive(),
      checksum: Hash,
      publicationEventId: Id,
    })
    .strict(),
]);
export type AgentMethodSelection = z.infer<typeof AgentMethodSelectionSchema>;
export const PodMethodSnapshotSchema = z.object({
  schemaVersion: z.literal("pod-method-snapshot-v1"),
  executionContract: HarnessExecutionContractSchema,
  methodSelection: AgentMethodSelectionSchema,
}).strict();
export type PodMethodSnapshot = z.infer<typeof PodMethodSnapshotSchema>;
export const SaveAgentMethodSchema = z
  .object({
    methodKey: Key,
    notes: z.string().trim().max(4000),
    knowledgeVersionIds: z.array(Id).max(4),
    expectedRevision: z.int().nonnegative(),
    reason: z.string().trim().min(1).max(600),
    requestId: z.uuid(),
  })
  .strict()
  .refine(
    (v) => new Set(v.knowledgeVersionIds).size === v.knowledgeVersionIds.length,
    "知识来源不能重复",
  );
export const AgentMethodActionSchema = z.enum(["submit", "publish", "reject", "disable"]);
export const ChangeAgentMethodSchema = z
  .object({
    expectedRevision: z.int().positive(),
    version: z.int().positive(),
    reason: z.string().trim().min(1).max(600),
    requestId: z.uuid(),
    reviewedChecksum: Hash.optional(),
  })
  .strict();
export const AgentMethodVersionSchema = z.object({
  id: Id,
  methodId: Id,
  version: z.int().positive(),
  checksum: Hash,
  definition: AgentMethodDefinitionSchema,
  reason: z.string(),
  createdAt: z.iso.datetime(),
});
export const AgentMethodAvailabilitySchema = z.object({
  supported: z.boolean(),
  sourcesUsable: z.boolean(),
  eligible: z.boolean(),
  issues: z.array(z.string()),
  sourceStates: z.array(z.object({ versionId: Id, usable: z.boolean() })),
});
export const AgentMethodRowSchema = z.object({
  id: Id,
  methodKey: Key,
  revision: z.int().positive(),
  latestVersion: z.int().positive(),
  activeVersion: z.int().positive().nullable(),
  state: z.enum(["draft", "in_review", "published"]),
  withdrawalGeneration: z.int().nonnegative(),
  adoptedAt: z.iso.datetime().nullable(),
  disabledAt: z.iso.datetime().nullable(),
  latest: AgentMethodVersionSchema,
  active: AgentMethodVersionSchema.nullable(),
  latestAvailability: AgentMethodAvailabilitySchema,
  activeAvailability: AgentMethodAvailabilitySchema.nullable(),
});
export const AgentMethodWorkspaceSchema = z.object({
  catalog: z.array(RegisteredAgentMethodSchema),
  methods: z.array(AgentMethodRowSchema),
  canManage: z.boolean(),
  canPublish: z.boolean(),
});
export const AgentMethodHistorySchema = z.object({
  versions: z.array(AgentMethodVersionSchema),
  events: z.array(
    z.object({
      id: Id,
      version: z.int().positive(),
      revision: z.int().positive(),
      action: z.enum(["create", "revise", "submit", "publish", "reject", "disable"]),
      reason: z.string(),
      createdAt: z.iso.datetime(),
    }),
  ),
});
export const AgentMethodSourceQuerySchema = z
  .object({ query: z.string().trim().max(160).default(""), after: Id.optional() })
  .strict();
export const AgentMethodSourceChoiceSchema = KnowledgeReferenceSchema.pick({
  entryId: true,
  versionId: true,
  version: true,
  title: true,
  sourceLabel: true,
  reviewDueOn: true,
  href: true,
}).extend({ usable: z.boolean(), issues: z.array(z.string()) });
export const AgentMethodSourcesSchema = z.object({
  choices: z.array(AgentMethodSourceChoiceSchema).max(50),
  nextCursor: Id.nullable(),
});
export type AgentMethodWorkspace = z.infer<typeof AgentMethodWorkspaceSchema>;
export type AgentMethodRow = z.infer<typeof AgentMethodRowSchema>;
export type AgentMethodVersion = z.infer<typeof AgentMethodVersionSchema>;
export type AgentMethodHistory = z.infer<typeof AgentMethodHistorySchema>;
export type AgentMethodSourceChoice = z.infer<typeof AgentMethodSourceChoiceSchema>;
