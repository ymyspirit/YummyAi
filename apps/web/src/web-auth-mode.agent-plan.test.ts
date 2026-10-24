import {afterEach,describe,expect,it,vi}from"vitest";
import {erpReturnPath}from"./web-auth-mode";
import {clearSessionTaskDrafts}from"./features/navigation/task-draft";
import {AGENT_PLAN_CLEAR_EVENT,AGENT_PLAN_INTENT_PREFIX,AGENT_PLAN_PREPARATION_INTENT_PREFIX}from"@yummyai/contracts/ai/agent-plan";
afterEach(()=>vi.unstubAllGlobals());
describe("personal Agent planning return and logout boundaries",()=>{
 it("restores one canonical plan ID while dropping private or ambiguous query fields",()=>{
  const id="0199a7bf-e321-7a44-8cba-111111111111";
  expect(erpReturnPath(erpReturnPath(`/ai-tasks?agentPlan=${id.toUpperCase()}&goal=private&input=private&token=secret`))).toBe(`/ai-tasks?agentPlan=${id}`);
  expect(erpReturnPath(`/ai-tasks?agentPlan=${id}&agentPlan=${id}`)).toBe("/ai-tasks");
  expect(erpReturnPath("/ai-tasks?agentPlan=invalid")).toBe("/ai-tasks");
  expect(erpReturnPath(`/orders?agentPlan=${id}`)).toBe("/orders");
 });
 it("fences planning before synchronously removing both original marker families on logout",()=>{
  const values:Record<string,string>={[AGENT_PLAN_INTENT_PREFIX+"scope:request"]:"SYNTHETIC",[AGENT_PLAN_PREPARATION_INTENT_PREFIX+"scope:item"]:"SYNTHETIC",unrelated:"KEEP"};
  Object.defineProperty(values,"removeItem",{value:(key:string)=>delete values[key],enumerable:false});
  const events:string[]=[];
  vi.stubGlobal("window",{sessionStorage:values,dispatchEvent:(event:Event)=>{events.push(event.type);if(event.type===AGENT_PLAN_CLEAR_EVENT){expect(values[AGENT_PLAN_INTENT_PREFIX+"scope:request"]).toBe("SYNTHETIC");expect(values[AGENT_PLAN_PREPARATION_INTENT_PREFIX+"scope:item"]).toBe("SYNTHETIC");}return true;}});
  clearSessionTaskDrafts({preserveAssistIntents:true});expect(events).toEqual([]);expect(Object.keys(values)).toHaveLength(3);
  clearSessionTaskDrafts();expect(events).toContain(AGENT_PLAN_CLEAR_EVENT);expect(values).toEqual({unrelated:"KEEP"});
 });
});
