import { HarnessRegistry, HarnessContractError, harnessChecksum } from "@yummyai/ai-core";
import { Permission, ForbiddenError } from "@yummyai/authz";
import { ORDER_IMAGE_ENHANCEMENT_POLICY,ORDER_IMAGE_ENHANCEMENT_INSTRUCTION } from "@yummyai/contracts/order/design-policy";
import type { TenantContext } from "@yummyai/contracts";
import { OrderDesignMethodSnapshotSchema, OrderDesignHarnessInputSchema, OrderDesignCompletionV1Schema, type OrderDesignMethodSnapshot } from "@yummyai/contracts/order/design-harness";
import { assertAgentMethodSelection, selectAgentMethod, AgentMethodAuthorityError, loadCurrentMembershipContext, type TenantTransaction } from "@yummyai/database";
import { assertMethodKnowledge } from "@yummyai/knowledge-core";
import { fingerprint } from "./crypto.js";
import { OrderDesignError, type OrderDesignSnapshot } from "./types.js";

const version="order-design-method-2026-10-18-v1";
const enhancementPolicyChecksum=harnessChecksum({policy:ORDER_IMAGE_ENHANCEMENT_POLICY,instructions:ORDER_IMAGE_ENHANCEMENT_INSTRUCTION});
const bundles=new Map((["template","pillow_photo"] as const).map(workflow=>{
  const skill={key:`order.design.${workflow}`,version},toolKey=`order_design.${workflow}`;
  const registry=new HarnessRegistry("order_design",[{descriptor:{
    key:toolKey,version,label:workflow==="template"?"订单模板制图":"订单来图抱枕制图",owner:"order_design_owner",effect:"external_request",
    inputSchemaKey:"order-design.pinned-plan-v1",outputSchemaKey:"order-design.completion-v1",
    permissionPolicyVersion:"order-design-current-owner-v1",requiredPermissions:[Permission.OrderRead,Permission.OrderWrite,Permission.OrderPiiRead,Permission.DesignRead,Permission.DesignWrite,Permission.AssetRead].sort(),
    resourcePolicy:"order-design.original-work-revision",dataDomains:["order_private","business","authorized_asset"],
    timeout:{mode:"fenced_lease",milliseconds:90_000},maxInputBytes:1024*1024,maxOutputBytes:1024*1024,
    recovery:"original_child_task",approval:"owning_business_flow",
  },inputSchema:OrderDesignHarnessInputSchema,outputSchema:OrderDesignCompletionV1Schema}],[{
    ...skill,label:workflow==="template"?"订单设计 · 模板排版":"订单设计 · 来图抱枕",
    instructions:`使用原订单、模板、配方、规则和计划完成受控制作；原模型响应与费用先保存再采用结果。方法说明不修改制造数值、客户要求或预算，不授予生产批准。保真美化策略摘要：${enhancementPolicyChecksum}`,
    steps:["authorize_original_order","validate_pinned_recipe_rules_and_plan","execute_existing_bounded_steps","preserve_original_response_and_cost","validate_private_proof","handoff_for_business_review"],tools:[{key:toolKey,version}],
  }]);
  return [workflow,{registry,skill,toolKey}] as const;
}));
export function orderDesignHarness(workflow:OrderDesignSnapshot["recipe"]["workflow"]){return bundles.get(workflow)!;}
export function registeredOrderDesignMethods(){return [...bundles.values()].map(value=>value.registry.describeSkill(value.skill));}
export function orderDesignInput(snapshot:OrderDesignSnapshot){return {
  workItemId:snapshot.workItemId,workRevisionId:snapshot.workRevisionId,sourceVersionId:snapshot.sourceVersionId,
  templateVersionId:snapshot.templateVersionId,templateChecksum:snapshot.templateChecksum,businessSnapshotChecksum:fingerprint(snapshot),
  workflow:snapshot.recipe.workflow,recipe:snapshot.recipe,plan:snapshot.plan,
};}
/** Keep the checksum of genuinely missing historical method metadata unchanged. */
export function orderDesignInputChecksum(snapshot:OrderDesignSnapshot,method?:OrderDesignMethodSnapshot|null){return method?harnessChecksum({snapshot,methodSnapshot:method}):fingerprint(snapshot);}
export async function selectOrderDesignMethod(tx:TenantTransaction,context:TenantContext,snapshot:OrderDesignSnapshot){
  try {
    const bundle=orderDesignHarness(snapshot.recipe.workflow),registered=bundle.registry.describeSkill(bundle.skill),selected=await selectAgentMethod(tx,registered);
    const method=OrderDesignMethodSnapshotSchema.parse({schemaVersion:"order-design-method-snapshot-v1",executionContract:registered.executionContract,methodSelection:selected.selection});
    await assertOrderDesignMethod(tx,context,snapshot,method,{lock:true,admission:true});
    bundle.registry.checkInput(method.executionContract,bundle.skill,bundle.toolKey,orderDesignInput(snapshot));
    return method;
  }catch(error){return methodFailure(error);}
}
export async function assertOrderDesignMethod(tx:TenantTransaction,context:TenantContext,snapshot:OrderDesignSnapshot,raw:unknown,options:{lock?:boolean;admission?:boolean}={}){
  try {
    const current=await loadCurrentMembershipContext(tx,context,{lock:options.lock});
    const parsed=raw?OrderDesignMethodSnapshotSchema.safeParse(raw):null;
    if(parsed&&!parsed.success)throw new OrderDesignError("agent_method_unavailable");
    const method=parsed?.success?parsed.data:null,bundle=orderDesignHarness(snapshot.recipe.workflow);
    if(method)bundle.registry.assertCurrent(method.executionContract,bundle.skill);
    const selected=await assertAgentMethodSelection(tx,bundle.registry.describeSkill(bundle.skill),method?.methodSelection,options);
    await assertMethodKnowledge(tx,current,selected.definition,{lock:options.lock});
    if(method)bundle.registry.checkInput(method.executionContract,bundle.skill,bundle.toolKey,orderDesignInput(snapshot));
    return method;
  }catch(error){return methodFailure(error);}
}
function methodFailure(error:unknown):never{
  if(error instanceof HarnessContractError||error instanceof AgentMethodAuthorityError||error instanceof ForbiddenError)throw new OrderDesignError("agent_method_unavailable");
  throw error;
}
