export async function logisticsRequest(path:string,input?:unknown,signal?:AbortSignal) {
  const response=await fetch(`/api/logistics/${path}`,{method:input===undefined?"GET":"POST",cache:"no-store",signal,headers:input===undefined?undefined:{"content-type":"application/json"},body:input===undefined?undefined:JSON.stringify(input)});
  const data=await response.json();if(!response.ok)throw new Error(typeof data?.message==="string"?data.message:"物流请求失败");return data;
}
export const logisticsError=(e:unknown)=>e instanceof Error?e.message:"物流操作未完成";
export const localDate=(s:string)=>{const d=new Date(s);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
const diagnostics:Record<string,string>={
  PROVIDER_ORDER_NOT_CONFIRMED:"物流平台尚未确认原订单，请核对原请求结果",NO_PURCHASE_TO_RECONCILE:"尚无购单记录，请先询价并执行已核验规则",
  NO_ELIGIBLE_CHANNEL:"没有同时满足交期、预算和服务条件的渠道，请人工核对",PRICE_OR_SERVICE_CHANGED:"复核报价或服务条件已变化，请重新核对",
  DAILY_BUDGET_EXCEEDED:"本日费用额度不足",PROVIDER_RESULT_REQUIRES_RECONCILIATION:"购单结果不确定，请查单后处理",LOGISTICS_EXECUTION_UNAVAILABLE:"物流请求未完成，请核对账户及服务状态",
  REQUESTER_MEMBERSHIP_DISABLED:"派发成员已停用",REQUESTER_PERMISSIONS_REVOKED:"派发成员权限已撤销",ORDER_CANCELLED_OR_HELD:"订单已取消、暂停或收件资料失效",
  ADDRESS_CHANGED_OR_EXPIRED:"收件资料已变更或到期",PRODUCTION_ASSIGNMENT_CHANGED:"工厂、数量、排期或生产版本已变更",ARTWORK_CHANGED_OR_HELD:"审核稿或客户确认状态已变更",
  LABEL_ISSUANCE_NOT_CONFIRMED:"面单申请结果待核实，请先查单",LABEL_UNAVAILABLE:"物流订单已确认，面单尚未取得",LABEL_CONTENT_CHANGED:"同一面单返回不同文件，请人工核对",
  ACTUAL_COST_EXCEEDS_BUDGET:"实际单票费用超过预算，请人工核对",ACTUAL_DAILY_COST_EXCEEDS_BUDGET:"实际每日费用超过预算，请人工核对",QUOTE_UNAVAILABLE:"该渠道报价暂未返回",
  OPERATOR_CANCELLED:"运营已取消尚未购单的本地任务",ORDER_DATA_ERASED:"订单私有资料已到期或清理",
};
export const logisticsDiagnostic=(code:string)=>diagnostics[code]??"物流资料或服务条件需要人工核对";
