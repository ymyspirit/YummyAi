import type { TenantContext } from "@yummyai/contracts";
import { AGENT_NATIVE_VERSION } from "@yummyai/contracts/ai/agent-native";
import { AGENT_NATIVE_V2_VERSION } from "@yummyai/contracts/ai/agent-native-v2";
import { AGENT_NATIVE_V3_VERSION } from "@yummyai/contracts/ai/agent-native-v3";
import { AGENT_NATIVE_V4_VERSION } from "@yummyai/contracts/ai/agent-native-v4";
import { AGENT_PLAN_VERSION } from "@yummyai/contracts/ai/agent-plan";
import { agentPlanRuns, withTenant, type DatabaseConnection } from "@yummyai/database";
import type { AgentPlanRuntime } from "@yummyai/workflow-core";
import { and, eq } from "drizzle-orm";

type Runtime=Pick<AgentPlanRuntime,"process">;
/** Redis keeps its original paid request key; the immutable DB version chooses
 * the protocol. Each selected runtime independently rechecks current authority. */
export function agentPlanRuntimeRouter(database:DatabaseConnection,legacy:Runtime,native:Runtime,nativeV2?:Runtime,nativeV3?:Runtime,nativeV4?:Runtime):Runtime{
  return{async process(context:TenantContext,id:string,operation:"execute"|"expire"="execute"){
    const row=await withTenant(database.db,context,async tx=>{
      const[result]=await tx.select({version:agentPlanRuns.version}).from(agentPlanRuns)
        .where(and(eq(agentPlanRuns.id,id),eq(agentPlanRuns.ownerId,context.userId)));
      return result;
    });
    if(!row)return{id,disposition:"skipped" as const};
    if(row.version===AGENT_PLAN_VERSION)return legacy.process(context,id,operation);
    if(row.version===AGENT_NATIVE_VERSION)return native.process(context,id,operation);
    if(row.version===AGENT_NATIVE_V2_VERSION&&nativeV2)return nativeV2.process(context,id,operation);
    if(row.version===AGENT_NATIVE_V3_VERSION&&nativeV3)return nativeV3.process(context,id,operation);
    if(row.version===AGENT_NATIVE_V4_VERSION&&nativeV4)return nativeV4.process(context,id,operation);
    throw new Error("agent_protocol_unavailable");
  }};
}
