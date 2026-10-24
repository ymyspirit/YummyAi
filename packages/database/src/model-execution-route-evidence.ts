import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { modelProviderConfigs, modelRoutes } from "./schema/ai.js";
import type { TenantTransaction } from "./tenant-transaction.js";

/** Safe identity hash only. Never return endpoints, credentials or provider keys. */
export async function readModelExecutionRouteFingerprint(tx:TenantTransaction,modelId:string):Promise<string|null>{
 const [route]=await tx.select().from(modelRoutes).where(and(eq(modelRoutes.id,modelId),eq(modelRoutes.status,"enabled")));
 if(!route||route.targets.length!==1||!["studio_analysis","studio_text"].includes(route.taskType))return null;
 const [provider]=await tx.select({id:modelProviderConfigs.id,provider:modelProviderConfigs.provider,endpoint:modelProviderConfigs.endpoint})
  .from(modelProviderConfigs).where(and(eq(modelProviderConfigs.id,route.targets[0]!.providerConfigId),eq(modelProviderConfigs.status,"enabled")));
 if(!provider)return null;
 return createHash("sha256").update(canonicalJson({version:1,routeId:route.id,taskType:route.taskType,targets:route.targets,provider})).digest("hex");
}
