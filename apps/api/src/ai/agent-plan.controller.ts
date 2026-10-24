import {BadRequestException,Body,Controller,Get,Header,HttpCode,Inject,Param,Post,Query,Req}from"@nestjs/common";
import {AGENT_PLAN_VERSION,PrepareAgentPlanItemSchema}from"@yummyai/contracts/ai/agent-plan";
import type{AuthenticatedRequest}from"../auth/tenant-context.guard.js";
import {AgentPlanService}from"./agent-plan.service.js";
const ItemQuery=PrepareAgentPlanItemSchema.omit({version:true});
@Controller("v1/agent-plans")
export class AgentPlanController{
 constructor(@Inject(AgentPlanService)private readonly service:AgentPlanService){}
 @Get("workspace")@Header("Cache-Control","private, no-store")
 workspace(@Req()request:AuthenticatedRequest){return this.service.workspace(request.tenantContext!);}
 @Post("runs")@Header("Cache-Control","private, no-store")
 start(@Req()request:AuthenticatedRequest,@Body()raw:unknown){return this.service.start(request.tenantContext!,raw);}
 @Get("runs/:id")@Header("Cache-Control","private, no-store")
 get(@Req()request:AuthenticatedRequest,@Param("id")id:string){return this.service.get(request.tenantContext!,id);}
 @Get("receipts")@Header("Cache-Control","private, no-store")
 receipt(@Req()request:AuthenticatedRequest,@Query()raw:unknown){return this.service.receipt(request.tenantContext!,raw);}
 @Post("runs/:id/stop")@HttpCode(200)@Header("Cache-Control","private, no-store")
 stop(@Req()request:AuthenticatedRequest,@Param("id")id:string,@Body()raw:unknown){return this.service.stop(request.tenantContext!,id,raw);}
 @Post("runs/:id/items/:itemId/prepare")@Header("Cache-Control","private, no-store")
 prepare(@Req()request:AuthenticatedRequest,@Param("id")id:string,@Param("itemId")itemId:string,@Body()raw:unknown){return this.service.prepareItem(request.tenantContext!,id,itemId,raw);}
 @Get("runs/:id/items/:itemId/receipt")@Header("Cache-Control","private, no-store")
 itemReceipt(@Req()request:AuthenticatedRequest,@Param("id")id:string,@Param("itemId")itemId:string,@Query()raw:unknown){
  const parsed=ItemQuery.safeParse(raw);if(!parsed.success)throw new BadRequestException({code:"agent_plan_item_invalid"});
  return this.service.itemReceipt(request.tenantContext!,id,itemId,{version:AGENT_PLAN_VERSION,...parsed.data});
 }
}
