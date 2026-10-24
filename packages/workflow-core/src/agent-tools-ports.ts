import type { TenantContext } from "@yummyai/contracts";
import type { AgentReadCall, AgentReadPageView } from "@yummyai/contracts/ai/agent-read";
import type { AgentCommandCapability } from "@yummyai/contracts/ai/agent-command";
import type { AgentToolInput, AgentToolOutput } from "@yummyai/contracts/ai/agent-tools";

/** Native owner ports; no database writes, model requests, recovery or downloads. */
export interface AgentToolOwnerPort {
  legacyRead(context: TenantContext, input: AgentReadCall): Promise<AgentReadPageView>;
  knowledgeSearch(context: TenantContext, input: AgentToolInput<"knowledge.search">): Promise<AgentToolOutput<"knowledge.search">>;
  creativeHistory(context: TenantContext, input: AgentToolInput<"creative.history">): Promise<AgentToolOutput<"creative.history">>;
  factoryCapacity(context: TenantContext, input: AgentToolInput<"factory.capacity">): Promise<AgentToolOutput<"factory.capacity">>;
}
export type AgentToolCommandsPort = (context: TenantContext) => AgentCommandCapability[];
