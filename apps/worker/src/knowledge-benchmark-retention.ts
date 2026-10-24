import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { knowledgeBenchmarkRetentionJobs as jobs, knowledgeBenchmarkItems as items, knowledgeBenchmarkAssessments as assessments,
 knowledgeGovernanceEvents as events, withTenant, type DatabaseConnection } from "@yummyai/database";
import { and, asc, eq, sql } from "drizzle-orm";

/** Route on opaque job IDs, then clear through the original owner's forced RLS. */
export async function expireKnowledgeBenchmarkBodiesInTenant(database:DatabaseConnection,tenantId:string):Promise<{expired:number;failed:number}>{
 const routeContext:TenantContext={tenantId,userId:createEntityId(),permissions:[],dataScope:"tenant"};
 const due=await withTenant(database.db,routeContext,tx=>tx.select({id:jobs.id,owner:jobs.createdBy}).from(jobs)
  .where(and(eq(jobs.state,"pending"),sql`${jobs.expiresAt}<=knowledge_benchmark_now()`)).orderBy(asc(jobs.expiresAt),asc(jobs.id)).limit(100));
 let expired=0,failed=0;
 for(const job of due){
  const context:TenantContext={tenantId,userId:job.owner,permissions:[],dataScope:"self"};
  try{
   const completed=await withTenant(database.db,context,async tx=>{
    const [current]=await tx.select().from(jobs).where(and(eq(jobs.id,job.id),eq(jobs.createdBy,job.owner),eq(jobs.state,"pending"),sql`${jobs.expiresAt}<=knowledge_benchmark_now()`)).for("update",{skipLocked:true});
    if(!current)return false;
    if(current.kind==="basis"){
     const [source]=await tx.select({id:items.id,owner:items.createdBy,body:sql<boolean>`${items.encryptedBasis} is not null`}).from(items).where(eq(items.id,current.resourceId)).for("update");
     if(!source||source.owner!==job.owner||!source.body)throw new Error("benchmark_retention_source_unavailable");
     await tx.update(items).set({encryptedBasis:null}).where(eq(items.id,source.id));
    }else{
     const [source]=await tx.select({id:assessments.id,owner:assessments.createdBy,body:sql<boolean>`${assessments.encryptedOutput} is not null`}).from(assessments).where(eq(assessments.id,current.resourceId)).for("update");
     if(!source||source.owner!==job.owner||!source.body)throw new Error("benchmark_retention_source_unavailable");
     await tx.update(assessments).set({encryptedOutput:null}).where(eq(assessments.id,source.id));
    }
    await tx.insert(events).values({id:createEntityId(),tenantId,createdBy:job.owner,resourceId:current.resourceId,action:"benchmark.body.purged",
     reason:"按原保留期清除固定评测私有正文，保留原身份、评分和历史",detail:{kind:current.kind,jobId:current.id}});
    await tx.update(jobs).set({state:"completed",completedAt:sql`knowledge_benchmark_now()`}).where(eq(jobs.id,current.id));
    return true;
   });
   if(completed)expired++;
  }catch{failed++;}
 }
 return {expired,failed};
}
