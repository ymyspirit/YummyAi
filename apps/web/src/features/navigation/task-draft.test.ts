import { afterEach, describe, expect, it, vi } from "vitest";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { AGENT_NATIVE_V3_CLEAR_EVENT, AGENT_NATIVE_V3_INTENT_PREFIX, AGENT_NATIVE_V3_PREPARATION_INTENT_PREFIX } from "@yummyai/contracts/ai/agent-native-v3";
import { AGENT_DEPENDENCY_PLAN_CLEAR_EVENT, AGENT_DEPENDENCY_PLAN_INTENT_PREFIX, AgentDependencyPlanIntentSchema } from "@yummyai/contracts/ai/agent-dependency-plan";
import { readAgentDependencyPlanIntents, updateAgentDependencyPlanIntent } from "../ai-tasks/agent-dependency-plan-client";
import { readAgentNativeV3Intents, readAgentNativeV3PreparationIntents, updateAgentNativeV3Intent, updateAgentNativeV3PreparationIntent, type AgentNativeV3Intent, type AgentNativeV3PreparationIntent } from "../ai-tasks/agent-native-v3-intent";
import { clearSessionTaskDrafts, taskDraftStateForKey, updateTaskDraftState } from "./task-draft";
import { AGENT_FULFILLMENT_COMMAND_CLEAR_EVENT, AGENT_FULFILLMENT_COMMAND_INTENT_PREFIX,
  AGENT_FULFILLMENT_COMMAND_VERSION, AgentFulfillmentCommandIntentSchema } from "@yummyai/contracts/ai/agent-fulfillment-command";
import { AGENT_NATIVE_V4_CLEAR_EVENT, AGENT_NATIVE_V4_INTENT_PREFIX, AGENT_NATIVE_V4_PREPARATION_INTENT_PREFIX } from "@yummyai/contracts/ai/agent-native-v4";
import { readAgentNativeV4Intents, readAgentNativeV4PreparationIntents, updateAgentNativeV4Intent, updateAgentNativeV4PreparationIntent } from "../ai-tasks/agent-native-v4-intent";
describe("object-scoped task draft state", () => {
  it("starts the new object from its own saved or initial state", () => {
    const old = { key: "A", value: "unsaved A" };
    expect(taskDraftStateForKey(old, "B", () => "initial B")).toEqual({
      key: "B",
      value: "initial B",
    });
    expect(taskDraftStateForKey(old, "A", () => "unused")).toBe(old);
  });
  it("ignores a late setter from the previous object", () => {
    const current = { key: "B", value: ["selected B"] };
    expect(updateTaskDraftState(current, "A", ["late A"])).toBe(current);
    expect(
      updateTaskDraftState(current, "A", () => {
        throw Error("stale updater executed");
      }),
    ).toBe(current);
  });
  it("preserves sequential functional updates for the current object", () => {
    const first = updateTaskDraftState({ key: "B", value: 1 }, "B", (value) => value + 1);
    expect(updateTaskDraftState(first, "B", (value) => value * 3)).toEqual({ key: "B", value: 6 });
  });
});

function nativeV3RecoveryStorage() {
  const ownerScope = "a".repeat(64), runId = "01990a00-0000-7000-8000-000000000001";
  const intent: AgentNativeV3Intent = { version: 1, ownerScope, requestId: "01990a00-0000-7000-8000-000000000002", requestChecksum: "b".repeat(64), runId: null, state: "unknown", createdAt: "2026-10-23T00:00:00.000Z" };
  const preparation: AgentNativeV3PreparationIntent = { version: 1, ownerScope, runId, itemId: "01990a00-0000-7000-8000-000000000003", proposalChecksum: "c".repeat(64), state: "unknown", createdAt: intent.createdAt };
  const storage: Record<string, unknown> = {
    [AGENT_NATIVE_V3_INTENT_PREFIX + ownerScope + ":" + intent.requestId]: JSON.stringify(intent),
    [AGENT_NATIVE_V3_PREPARATION_INTENT_PREFIX + ownerScope + ":" + runId + ":" + preparation.itemId]: JSON.stringify(preparation),
    "unrelated-page": "retain",
  };
  Object.defineProperties(storage, {
    length: { get: () => Object.keys(storage).length },
    key: { value: (index: number) => Object.keys(storage)[index] ?? null },
    getItem: { value: (key: string) => typeof storage[key] === "string" ? storage[key] : null },
    setItem: { value: (key: string, value: string) => { storage[key] = value; } },
    removeItem: { value: (key: string) => { delete storage[key]; } },
  });
  const surface = new EventTarget(); Object.defineProperty(surface, "sessionStorage", { value: storage });
  vi.stubGlobal("window", surface); vi.stubGlobal("sessionStorage", storage);
  return { ownerScope, runId, intent, preparation, storage, surface };
}

describe("native v4 three-level recovery clearing",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("stops native readers before legacy recovery can synchronously refresh on focus", () => {
    const { surface } = nativeV3RecoveryStorage();
    let nativePurged = false;
    const readsBeforePurge: string[] = [];
    surface.addEventListener(AGENT_NATIVE_V4_CLEAR_EVENT, () => { nativePurged = true; });
    surface.addEventListener("focus", () => {
      if (!nativePurged) readsBeforePurge.push("private-native-read");
    });
    surface.addEventListener(ASSIST_INTENT_CLEAR_EVENT, () => surface.dispatchEvent(new Event("focus")));

    clearSessionTaskDrafts();

    expect(nativePurged).toBe(true);
    expect(readsBeforePurge).toEqual([]);
  });
  it("preserves an authority refresh but invalidates late parent and preparation receipts before removing logout markers",()=>{
    const {ownerScope,runId,intent,preparation,storage,surface}=nativeV3RecoveryStorage();
    const parentKey=AGENT_NATIVE_V4_INTENT_PREFIX+ownerScope+":"+intent.requestId;
    const itemKey=AGENT_NATIVE_V4_PREPARATION_INTENT_PREFIX+ownerScope+":"+runId+":"+preparation.itemId;
    storage[parentKey]=JSON.stringify(intent);storage[itemKey]=JSON.stringify(preparation);
    const observed:{parent:boolean;item:boolean;detail:boolean}[]=[];
    surface.addEventListener(AGENT_NATIVE_V4_CLEAR_EVENT,event=>observed.push({parent:readAgentNativeV4Intents(ownerScope).length===1,
      item:readAgentNativeV4PreparationIntents(ownerScope).length===1,detail:"detail" in event}));
    clearSessionTaskDrafts({preserveAssistIntents:true});
    expect(observed).toEqual([]);expect(readAgentNativeV4Intents(ownerScope)).toEqual([intent]);
    expect(readAgentNativeV4PreparationIntents(ownerScope)).toEqual([preparation]);
    clearSessionTaskDrafts();
    expect(observed).toEqual([{parent:true,item:true,detail:false}]);
    expect(readAgentNativeV4Intents(ownerScope)).toEqual([]);expect(readAgentNativeV4PreparationIntents(ownerScope)).toEqual([]);
    expect(()=>updateAgentNativeV4Intent({...intent,state:"known",runId})).toThrow(/原请求标识已清除或变化/);
    expect(()=>updateAgentNativeV4PreparationIntent({...preparation,state:"known"})).toThrow(/原准备标识已清除或变化/);
    expect(Object.keys(storage)).toEqual(["unrelated-page"]);
  });
});

describe("native v3 task recovery identity clearing", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("invalidates v3 recovery synchronously before removing both markers and rejects late results", () => {
    const { ownerScope, runId, intent, preparation, storage, surface } = nativeV3RecoveryStorage();
    const observed: { runPresent: boolean; preparationPresent: boolean; carriesDetail: boolean }[] = [];
    surface.addEventListener(AGENT_NATIVE_V3_CLEAR_EVENT, event => observed.push({
      runPresent: readAgentNativeV3Intents(ownerScope).length === 1,
      preparationPresent: readAgentNativeV3PreparationIntents(ownerScope).length === 1,
      carriesDetail: "detail" in event,
    }));
    clearSessionTaskDrafts();
    expect(observed).toEqual([{ runPresent: true, preparationPresent: true, carriesDetail: false }]);
    expect(readAgentNativeV3Intents(ownerScope)).toEqual([]);
    expect(readAgentNativeV3PreparationIntents(ownerScope)).toEqual([]);
    expect(() => updateAgentNativeV3Intent({ ...intent, state: "known", runId })).toThrow(/原请求标识已清除或变化/);
    expect(() => updateAgentNativeV3PreparationIntent({ ...preparation, state: "known" })).toThrow(/原准备标识已清除或变化/);
    expect(Object.keys(storage)).toEqual(["unrelated-page"]);
  });
  it("preserves both v3 recovery markers without a clear event for a same-actor authority refresh", () => {
    const { ownerScope, intent, preparation, surface } = nativeV3RecoveryStorage();
    const cleared = vi.fn(); surface.addEventListener(AGENT_NATIVE_V3_CLEAR_EVENT, cleared);
    clearSessionTaskDrafts({ preserveAssistIntents: true });
    expect(cleared).not.toHaveBeenCalled();
    expect(readAgentNativeV3Intents(ownerScope)).toEqual([intent]);
    expect(readAgentNativeV3PreparationIntents(ownerScope)).toEqual([preparation]);
  });
});

describe("original fulfillment Agent recovery identity clearing", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("keeps exact scalar recovery on same-actor refresh and invalidates before logout purge without touching other product storage", () => {
    const { ownerScope, runId, intent, storage, surface } = nativeV3RecoveryStorage();
    const marker = AgentFulfillmentCommandIntentSchema.parse({ version: AGENT_FULFILLMENT_COMMAND_VERSION, ownerScope,
      orderId: runId, requestId: intent.requestId, requestChecksum: intent.requestChecksum, id: null, state: "unknown", createdAt: intent.createdAt });
    const key = AGENT_FULFILLMENT_COMMAND_INTENT_PREFIX + ownerScope + ":" + marker.requestId;
    storage[key] = JSON.stringify(marker);
    const observed: Array<{ present: boolean; carriesDetail: boolean; nativeStillPresent: boolean }> = [];
    surface.addEventListener(AGENT_FULFILLMENT_COMMAND_CLEAR_EVENT, event => observed.push({ present: storage[key] !== undefined,
      carriesDetail: "detail" in event, nativeStillPresent: readAgentNativeV3Intents(ownerScope).length === 1 }));
    clearSessionTaskDrafts({ preserveAssistIntents: true });
    expect(observed).toEqual([]); expect(AgentFulfillmentCommandIntentSchema.parse(JSON.parse(storage[key] as string))).toEqual(marker);
    clearSessionTaskDrafts();
    expect(observed).toEqual([{ present: true, carriesDetail: false, nativeStillPresent: true }]);
    expect(storage[key]).toBeUndefined(); expect(readAgentNativeV3Intents(ownerScope)).toEqual([]);
    expect(Object.keys(storage)).toEqual(["unrelated-page"]);
  });
});

describe("dependency plan recovery identity clearing", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("preserves a same-actor plan, then invalidates before logout purge and rejects a late mutation receipt", () => {
    const { ownerScope, intent, storage, surface, runId } = nativeV3RecoveryStorage();
    const marker = AgentDependencyPlanIntentSchema.parse({ version: 1, ownerScope, requestId: intent.requestId,
      requestChecksum: intent.requestChecksum, planId: runId, state: "cancel_unknown", createdAt: intent.createdAt });
    storage[AGENT_DEPENDENCY_PLAN_INTENT_PREFIX + ownerScope + ":" + marker.requestId] = JSON.stringify(marker);
    const observed: { present: boolean; carriesDetail: boolean }[] = [];
    surface.addEventListener(AGENT_DEPENDENCY_PLAN_CLEAR_EVENT, event => observed.push({ present: readAgentDependencyPlanIntents(ownerScope).length === 1, carriesDetail: "detail" in event }));
    clearSessionTaskDrafts({ preserveAssistIntents: true });
    expect(observed).toEqual([]); expect(readAgentDependencyPlanIntents(ownerScope)).toEqual([marker]);
    clearSessionTaskDrafts();
    expect(observed).toEqual([{ present: true, carriesDetail: false }]); expect(readAgentDependencyPlanIntents(ownerScope)).toEqual([]);
    expect(() => updateAgentDependencyPlanIntent({ ...marker, state: "known" })).toThrow(/原标识已清除或变化/);
    expect(Object.keys(storage)).toEqual(["unrelated-page"]);
  });
});
