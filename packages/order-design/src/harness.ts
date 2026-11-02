import { HarnessRegistry, HarnessContractError, harnessChecksum } from "@yummyai/ai-core";
import { Permission, ForbiddenError } from "@yummyai/authz";
import { ORDER_IMAGE_ENHANCEMENT_POLICY,ORDER_IMAGE_ENHANCEMENT_INSTRUCTION } from "@yummyai/contracts/order/design-policy";
import type { TenantContext } from "@yummyai/contracts";
import { OrderDesignMethodSnapshotSchema, OrderDesignHarnessInputSchema, OrderDesignPinnedPlanHarnessInputV1Schema, OrderDesignCompletionV1Schema, type OrderDesignMethodSnapshot } from "@yummyai/contracts/order/design-harness";
import { assertAgentMethodSelection, selectAgentMethod, AgentMethodAuthorityError, loadCurrentMembershipContext, type TenantTransaction } from "@yummyai/database";
import { assertMethodKnowledge } from "@yummyai/knowledge-core";
import { fingerprint } from "./crypto.js";
import { OrderDesignError, type OrderDesignSnapshot } from "./types.js";

const legacyVersion="order-design-method-2026-10-18-v1",currentVersion="order-design-method-2026-10-27-v2";
const revisionVersion="order-design-candidate-revision-2026-11-02-v1";
const enhancementPolicyChecksum=harnessChecksum({policy:ORDER_IMAGE_ENHANCEMENT_POLICY,instructions:ORDER_IMAGE_ENHANCEMENT_INSTRUCTION});
const bundles=new Map((["template","pillow_photo"] as const).flatMap(workflow=>[legacyVersion,currentVersion,revisionVersion].map(version=>{
  const revision=version===revisionVersion;
  const skill={key:`order.design.${workflow}${revision?".revision":""}`,version},toolKey=`order_design.${workflow}${revision?".revision":""}`;
  const registry=new HarnessRegistry("order_design",[{descriptor:{
    key:toolKey,version,label:workflow==="template"?"订单模板制图":"订单来图抱枕制图",owner:"order_design_owner",effect:"external_request",
    inputSchemaKey:revision?"order-design.candidate-revision-v1":"order-design.pinned-plan-v1",outputSchemaKey:"order-design.completion-v1",
    permissionPolicyVersion:"order-design-current-owner-v1",requiredPermissions:[Permission.OrderRead,Permission.OrderWrite,Permission.OrderPiiRead,Permission.DesignRead,Permission.DesignWrite,Permission.AssetRead,...(revision?[Permission.DesignReview]:[])].sort(),
    resourcePolicy:"order-design.original-work-revision",dataDomains:["order_private","business","authorized_asset"],
    timeout:{mode:"fenced_lease",milliseconds:90_000},maxInputBytes:1024*1024,maxOutputBytes:1024*1024,
    recovery:"original_child_task",approval:"owning_business_flow",
  },inputSchema:revision?OrderDesignHarnessInputSchema:OrderDesignPinnedPlanHarnessInputV1Schema,outputSchema:OrderDesignCompletionV1Schema}],[{
    ...skill,label:workflow==="template"?"订单设计 · 模板排版":"订单设计 · 来图抱枕",
    instructions:revision?"按运营明确反馈修订原可编辑项目的当前候选，只追加新版本，保留所有图层、原图、规则、工艺和费用历史。截图只作反馈参考；裁线修订不调用模型，主体修订只替换固定主体素材。完成后返回运营审核，不批准生产。":`使用原订单、模板、配方、规则和计划完成受控制作；原模型响应与费用先保存再采用结果。方法说明不修改制造数值、客户要求或预算，不授予生产批准。保真美化策略摘要：${enhancementPolicyChecksum}${version===currentVersion?"。若含本次需求解释，固定原字段分组及完整备注，字体颜色选择器不制造文字；未审核顾客稿仅交运营审核，拒绝后沿原owner转交美工。":""}`,
    steps:["authorize_original_order","validate_pinned_recipe_rules_and_plan","execute_existing_bounded_steps","preserve_original_response_and_cost","validate_private_proof","handoff_for_business_review"],tools:[{key:toolKey,version}],
  }]);
  return [`${workflow}:${version}`,{registry,skill,toolKey}] as const;
})));
export function orderDesignHarness(workflow:OrderDesignSnapshot["recipe"]["workflow"],interpreted=false,revision=false){return bundles.get(`${workflow}:${revision?revisionVersion:interpreted?currentVersion:legacyVersion}`)!;}
export function registeredOrderDesignMethods(){return [...(["template","pillow_photo"] as const).map(workflow=>{const value=orderDesignHarness(workflow,true);return value.registry.describeSkill(value.skill);}),(()=>{const value=orderDesignHarness("pillow_photo",true,true);return value.registry.describeSkill(value.skill);})()];}
export function supportedOrderDesignMethods(){return [...registeredOrderDesignMethods(),...(["template","pillow_photo"] as const).map(workflow=>{const value=orderDesignHarness(workflow);return value.registry.describeSkill(value.skill);})];}
/** Resolve the original pinned contract; absence of requirements never upgrades an existing task. */
export function orderDesignHarnessForMethod(snapshot:Pick<OrderDesignSnapshot,"recipe"|"requirements"|"revisionRequest">,method:OrderDesignMethodSnapshot|null){
  try {
    if(!method){
      if(snapshot.requirements||snapshot.revisionRequest)throw new OrderDesignError("agent_method_unavailable");
      return orderDesignHarness(snapshot.recipe.workflow);
    }
    const version=method.executionContract.skill.version;
    if(snapshot.revisionRequest?version!==revisionVersion:version!==legacyVersion&&version!==currentVersion||!!snapshot.requirements&&version!==currentVersion)
      throw new OrderDesignError("agent_method_unavailable");
    const bundle=bundles.get(`${snapshot.recipe.workflow}:${version}`);
    if(!bundle)throw new OrderDesignError("agent_method_unavailable");
    bundle.registry.assertCurrent(method.executionContract,bundle.skill);
    return bundle;
  }catch(error){return methodFailure(error);}
}
export function orderDesignInput(snapshot:OrderDesignSnapshot){return {
  workItemId:snapshot.workItemId,workRevisionId:snapshot.workRevisionId,sourceVersionId:snapshot.sourceVersionId,
  templateVersionId:snapshot.templateVersionId,templateChecksum:snapshot.templateChecksum,businessSnapshotChecksum:fingerprint(snapshot),
  workflow:snapshot.recipe.workflow,recipe:snapshot.recipe,plan:snapshot.plan,
};}
/** Keep the checksum of genuinely missing historical method metadata unchanged. */
export function orderDesignInputChecksum(snapshot:OrderDesignSnapshot,method?:OrderDesignMethodSnapshot|null){return method?harnessChecksum({snapshot,methodSnapshot:method}):fingerprint(snapshot);}
export async function selectOrderDesignMethod(tx:TenantTransaction,context:TenantContext,snapshot:OrderDesignSnapshot){
  try {
    const preferred=orderDesignHarness(snapshot.recipe.workflow,!!snapshot.requirements,!!snapshot.revisionRequest),registered=preferred.registry.describeSkill(preferred.skill);
    const current=orderDesignHarness(snapshot.recipe.workflow,true),supported=snapshot.requirements||snapshot.revisionRequest?[]:[current.registry.describeSkill(current.skill)];
    const selected=await selectAgentMethod(tx,registered,{supported});
    const actual=[registered,...supported].find(candidate=>candidate.executionContract.checksum===selected.selection.contractChecksum);
    if(!actual)throw new OrderDesignError("agent_method_unavailable");
    const method=OrderDesignMethodSnapshotSchema.parse({schemaVersion:"order-design-method-snapshot-v1",executionContract:actual.executionContract,methodSelection:selected.selection});
    const bundle=orderDesignHarnessForMethod(snapshot,method);
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
    const method=parsed?.success?parsed.data:null,bundle=orderDesignHarnessForMethod(snapshot,method);
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
