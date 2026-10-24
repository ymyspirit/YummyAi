import type { AdvertisingReadOwner } from "@yummyai/advertising-core";
import type { DevelopmentReadOwner,ListingReadOwner } from "@yummyai/catalog-core";
import type { TenantContext } from "@yummyai/contracts";
import type { AgentResourceCall,AgentResourceCandidates,AgentResourceCandidatesQuery,AgentResourceInput,AgentResourceKey,AgentResourceResult } from "@yummyai/contracts/ai/agent-resources";
import type { FinanceProfitReadOwner } from "@yummyai/finance-core";
import type { ResearchReadOwner } from "@yummyai/knowledge-core";
import type { OrderReadOwner } from "@yummyai/order-core";
export type AgentResourceOwnerResult={data:unknown;sources:AgentResourceResult['sources']};
export type AgentResourceOwnerCandidates=Pick<AgentResourceCandidates,'items'|'coverage'>;
export type AgentResourceOwnerSelection={ [K in AgentResourceKey]:{tool:K;input:AgentResourceInput<K>} }[AgentResourceKey];
export interface AgentResourceOwnerPort{
candidates(context:TenantContext,query:AgentResourceCandidatesQuery):Promise<AgentResourceOwnerCandidates>;
read(context:TenantContext,call:AgentResourceCall):Promise<AgentResourceOwnerResult>;
assertAccess(context:TenantContext,selection:AgentResourceOwnerSelection):Promise<void>;
}
export type AgentResearchReader=Pick<ResearchReadOwner,'list'|'timeline'>;
export type AgentResearchStudyReader=Pick<ResearchReadOwner,'resolve'>;
export type AgentDevelopmentReader=Pick<DevelopmentReadOwner,'workspace'|'detail'>;
export type AgentListingReader=Pick<ListingReadOwner,'catalog'|'getWorkspace'|'listVersions'>;
export type AgentOrderReader=Pick<OrderReadOwner,'list'|'get'>;
export type AgentFinanceReader=Pick<FinanceProfitReadOwner,'getProfitRun'|'recent'>;
export type AgentAdvertisingReader=Pick<AdvertisingReadOwner,'accounts'|'history'|'record'>;
