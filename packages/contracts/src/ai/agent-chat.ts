import { z } from "zod";
import {
  AssistModelSchema,
  AssistViewSchema,
  CreateAssistSchema,
} from "@yummyai/contracts/ai/assist";
import { KnowledgeConversationSchema } from "@yummyai/contracts/knowledge/governance";
import { KnowledgeProductOptionsSchema } from "@yummyai/contracts/knowledge";

export const AGENT_CHAT_EVENT_VERSION = "agent-chat-event-v1" as const;
const Authority = z.string().min(1).max(65_536);
export const CreateAgentChatTurnSchema = z
  .object({
    requestId: z.uuid(),
    scopeId: z.uuid(),
    previousRunId: z.uuidv7().nullable(),
    modelId: z.uuidv7(),
    message: z.string().trim().min(1).max(2000),
  spuIds: z.array(z.uuidv7()).max(1).optional(),
  })
  .strict();
export type CreateAgentChatTurn = z.infer<typeof CreateAgentChatTurnSchema>;
/** Identical native intent on client and server, including every default. */
export function agentChatAssistRequest(raw: CreateAgentChatTurn) {
  const input = CreateAgentChatTurnSchema.parse(raw);
  return CreateAssistSchema.parse({
    kind: "knowledge_answer",
    requestId: input.requestId,
    scopeId: input.scopeId,
    modelId: input.modelId,
    previousRunId: input.previousRunId,
    purpose: "dialogue",
    evidenceStoreId: null,
    taskGoal: input.message,
    search: {
      query: input.message.slice(0, 300),
      topic: "all",
      platform: "all",
      market: "ALL",
      spuIds: input.spuIds ?? [],
    },
  });
}
export const AgentChatWorkspaceSchema = z
  .object({
    contextAuthority: Authority,
    models: z.array(AssistModelSchema).max(200),
    conversations: z.array(KnowledgeConversationSchema).max(20),
  products: KnowledgeProductOptionsSchema.shape.items.optional(),
  productsHasMore: z.boolean().optional(),
  streamingModelIds: z.array(z.uuidv7()).max(200).optional(),
  })
  .strict();
export type AgentChatWorkspace = z.infer<typeof AgentChatWorkspaceSchema>;
export const AgentChatHistorySchema = z
  .object({
    contextAuthority: Authority,
    scopeId: z.uuid(),
    turns: z.array(AssistViewSchema).max(40),
    hasMore: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.turns.some(
        (turn) =>
          turn.kind !== "knowledge_answer" ||
          turn.scope !== `knowledge:${value.scopeId}` ||
          (turn.request &&
            (turn.request.kind !== "knowledge_answer" ||
              turn.request.scopeId !== value.scopeId ||
              turn.request.purpose !== "dialogue")),
      )
    )
      context.addIssue({
        code: "custom",
        message: "Conversation history retains one original private dialogue scope",
      });
  });
export type AgentChatHistory = z.infer<typeof AgentChatHistorySchema>;
export const AgentChatStreamRequestSchema = z
  .object({
    requestId: z.uuid(),
    inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type AgentChatStreamRequest = z.infer<typeof AgentChatStreamRequestSchema>;
const Envelope = {
  version: z.literal(AGENT_CHAT_EVENT_VERSION),
  runId: z.uuidv7(),
  requestId: z.uuid(),
  contextAuthority: Authority,
  sequence: z.int().positive(),
};
export const AgentChatEventSchema = z
  .discriminatedUnion("type", [
    z.object({ ...Envelope, type: z.literal("status"), text: z.string().min(1).max(512) }).strict(),
    z
      .object({ ...Envelope, type: z.literal("text_delta"), text: z.string().min(1).max(8192) })
      .strict(),
    z.object({ ...Envelope, type: z.literal("completed"), run: AssistViewSchema }).strict(),
    z
      .object({
        ...Envelope,
        type: z.literal("error"),
        code: z.enum([
          "authority_changed",
          "read_unavailable",
          "stream_unavailable",
          "result_unknown",
        ]),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (
      value.type === "completed" &&
      (value.run.id !== value.runId ||
        value.run.request?.requestId !== value.requestId ||
        value.run.kind !== "knowledge_answer" ||
        !["completed", "failed", "cancelled"].includes(value.run.status))
    )
      context.addIssue({
        code: "custom",
        message: "A final answer retains its exact native request",
      });
  });
export type AgentChatEvent = z.infer<typeof AgentChatEventSchema>;
