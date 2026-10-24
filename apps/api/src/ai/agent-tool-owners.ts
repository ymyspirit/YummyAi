import { Inject, Injectable } from "@nestjs/common";
import type { TenantContext } from "@yummyai/contracts";
import type { AgentReadCall, AgentReadPageView } from "@yummyai/contracts/ai/agent-read";
import type { AgentToolInput, AgentToolOutput } from "@yummyai/contracts/ai/agent-tools";
import type { AgentToolOwnerPort } from "@yummyai/workflow-core";
import { KnowledgeService } from "../knowledge/knowledge.service.js";
import { CreativeExecutionOperatorService } from "../design/creative-execution-operator.service.js";
import { FactoryCapacityService } from "../suppliers/factory-capacity.service.js";
import { AgentReadService } from "./agent-read.service.js";

/** Each native owner retains its object authority, private-data and business rules. */
@Injectable()
export class AgentToolOwners implements AgentToolOwnerPort {
  constructor(
    @Inject(KnowledgeService) private readonly knowledge: KnowledgeService,
    @Inject(CreativeExecutionOperatorService) private readonly creative: CreativeExecutionOperatorService,
    @Inject(FactoryCapacityService) private readonly factories: FactoryCapacityService,
    @Inject(AgentReadService) private readonly reads: AgentReadService,
  ) {}

  knowledgeSearch(context: TenantContext, input: AgentToolInput<"knowledge.search">): Promise<AgentToolOutput<"knowledge.search">> {
    return this.knowledge.search(context, input);
  }

  creativeHistory(context: TenantContext, input: AgentToolInput<"creative.history">): Promise<AgentToolOutput<"creative.history">> {
    return this.creative.history(context, input.scope, input.ownerId, input.after ? { after: input.after } : {});
  }

  factoryCapacity(context: TenantContext, input: AgentToolInput<"factory.capacity">): Promise<AgentToolOutput<"factory.capacity">> {
    return this.factories.workspace(context, input.factoryId, input.query);
  }

  legacyRead(context: TenantContext, input: AgentReadCall): Promise<AgentReadPageView> {
    return this.reads.call(context, input);
  }
}
