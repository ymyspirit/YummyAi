import { Inject,Injectable } from "@nestjs/common";
import type { TenantContext } from "@yummyai/contracts";
import type { AgentResourceCall,AgentResourceCandidatesQuery } from "@yummyai/contracts/ai/agent-resources";
import { AgentResourceOwners as SharedAgentResourceOwners,type AgentResourceOwnerPort,type AgentResourceOwnerSelection } from "@yummyai/workflow-core";
import { ProductDevelopmentService } from "../catalog/product-development.service.js";
import { AdvertisingService } from "../customer-intelligence/advertising.service.js";
import { FinanceService } from "../finance/finance.service.js";
import { ListingService } from "../listings/listing.service.js";
import { OrderService } from "../orders/order.service.js";
import { ResearchStudyService } from "../research/research-study.service.js";
import { ResearchRepository } from "../research/research.repository.js";
import { originalOwnerOperation } from "../shared/original-owner-error.js";
export type { AgentResourceOwnerCandidates,AgentResourceOwnerResult } from "@yummyai/workflow-core";
/** Nest preserves the original service injection contract; facts and projections live in their owners. */
@Injectable()
export class AgentResourceOwners implements AgentResourceOwnerPort {
private readonly owner:SharedAgentResourceOwners;
constructor(
@Inject(ResearchRepository) research:ResearchRepository,
@Inject(ResearchStudyService) studies:ResearchStudyService,
@Inject(ProductDevelopmentService) products:ProductDevelopmentService,
@Inject(ListingService) listings:ListingService,
@Inject(OrderService) orders:OrderService,
@Inject(FinanceService) finance:FinanceService,
@Inject(AdvertisingService) advertising:AdvertisingService,
){this.owner=new SharedAgentResourceOwners(research,studies,products,listings,orders,
{recent:async context=>(await finance.workspace(context)).runs,getProfitRun:(context,id)=>finance.getProfitRun(context,id)},
{accounts:async context=>(await advertising.workspace(context)).accounts,history:(context,query)=>advertising.history(context,query),record:(context,id,query)=>advertising.record(context,id,query)});}
candidates(context:TenantContext,query:AgentResourceCandidatesQuery){return originalOwnerOperation(()=>this.owner.candidates(context,query));}
read(context:TenantContext,call:AgentResourceCall){return originalOwnerOperation(()=>this.owner.read(context,call));}
assertAccess(context:TenantContext,selection:AgentResourceOwnerSelection){return originalOwnerOperation(()=>this.owner.assertAccess(context,selection));}
}
