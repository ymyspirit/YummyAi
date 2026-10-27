import { assessPaidRequestRecovery, type SecretVault } from "@yummyai/ai-core";
import { authorize, ForbiddenError, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { OrderDesignAgentViewSchema, OrderDesignAgentActionSchema, OrderDesignResponseRecoveryEvidenceSchema,
  type OrderDesignResponseRecoveryEvidence } from "@yummyai/contracts/order/design-agent";
import { DesignAutomationPlanSchema, PillowContourEvidenceSchema, type PillowContourEvidence } from "@yummyai/contracts/pod/design-automation";
import { OrderRuleSnapshotSchema } from "@yummyai/contracts/rules";
import { pinnedRuleDiagnostics } from "./rules.js";
import { orderDesignAgentRuns as runs, orderDesignAgentSteps as steps, orderDesignAgentOutbox as outbox, orderDesignAgentCommands as commands,
  orderWorkItems as works, orderLines, orders, amazonOrderReportLines, memberships, membershipRoles, roles, orderDesignDispatchTenants, aiBudgetLedger, orderDesignModelCalls as modelCalls,
  productionEditorProjects as projects, productionEditorVersions as versions, productionEditorRenders as renders,
  withTenant, type TenantTransaction, type DatabaseConnection } from "@yummyai/database";
import { and, eq, gt, inArray, isNull, lte, asc, desc, sql } from "drizzle-orm";
import { fingerprint, seal, open } from "./crypto.js";
import { OrderDesignError, type OrderDesignSnapshot, type OrderDesignDispatcher, type OrderDesignStepCheckpoint } from "./types.js";
import { responseRecoveryTarget } from "./response-recovery.js";
import { selectOrderDesignMethod, assertOrderDesignMethod, orderDesignInputChecksum } from "./harness.js";
import { readOrderDesignCompletion } from "./completion.js";
import { loadCurrentMembershipContext } from "@yummyai/database";

export type DesignRun=typeof runs.$inferSelect;
export type DesignStep=typeof steps.$inferSelect;
export const executionPermissions=[Permission.OrderRead,Permission.OrderWrite,Permission.OrderPiiRead,Permission.DesignRead,Permission.DesignWrite,Permission.AssetRead];
export const paidTool=(tool:string)=>tool==="enhance_image" || tool==="cutout_subject";
export async function lockWork(tx:TenantTransaction,id:string) {await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`order-work:${id}`},0))`);}
export async function assertExecutionIdentity(tx:TenantTransaction,context:TenantContext) {
  const current=await loadCurrentMembershipContext(tx,context,{lock:true});
  const rows=await tx.select({permissions:roles.permissions,dataScope:roles.dataScope}).from(memberships).innerJoin(membershipRoles,eq(membershipRoles.membershipId,memberships.id)).innerJoin(roles,eq(roles.id,membershipRoles.roleId))
    .where(and(eq(memberships.userId,context.userId),eq(memberships.status,"active")));
  const grants=new Set(rows.filter(row=>row.dataScope==="tenant").flatMap(row=>row.permissions));
  if(executionPermissions.some(permission=>!grants.has(permission))) throw new OrderDesignError("agent_membership_unavailable");
  return current;
}
export async function assertRunSource(tx:TenantTransaction,run:DesignRun) {
  const [source]=await tx.select({work:works,order:orders}).from(works).innerJoin(orderLines,eq(orderLines.id,works.id)).innerJoin(orders,eq(orders.id,orderLines.orderId)).where(eq(works.id,run.workItemId));
  if(!source?.work.encryptedDataKey || source.work.expiresAt<=new Date() || source.order.addressStatus==="anonymized") throw new OrderDesignError("agent_source_expired");
  if(source.work.held || source.work.archivedAt || source.order.sideState==="cancelled") throw new OrderDesignError("agent_order_unavailable");
  if(source.work.pushedRevisionId!==run.workRevisionId || !["queued","starting","in_progress","changes_requested"].includes(source.work.artwork)) throw new OrderDesignError("agent_work_changed");
  if(source.work.reportLineId) {
    const [report]=await tx.select().from(amazonOrderReportLines).where(eq(amazonOrderReportLines.id,source.work.reportLineId));
    const noCustomization=report?.state==="none" && report.currentVersionId===null && report.reviewedVersionId===null && source.work.sourceVersionId===null;
    const reviewedCustomization=!!report && source.work.sourceVersionId!==null && ["ready","partial"].includes(report.state) && report.currentVersionId===source.work.sourceVersionId && report.reviewedVersionId===source.work.sourceVersionId;
    if(!report || report.expiresAt<=new Date() || (!noCustomization && !reviewedCustomization)) throw new OrderDesignError("agent_source_changed");
  }
  return source.work;
}

export async function assertOrderDesignRunMethod(tx:TenantTransaction,context:TenantContext,run:DesignRun,key:Uint8Array){
  const snapshot=open<OrderDesignSnapshot>(key,run.encryptedSnapshot);
  if(orderDesignInputChecksum(snapshot,run.methodSnapshot)!==run.inputChecksum)throw new OrderDesignError("agent_snapshot_invalid");
  await assertOrderDesignMethod(tx,context,snapshot,run.methodSnapshot,{lock:true});
  return snapshot;
}

/** Called in the same short transaction as the reviewed order's push. */
export async function registerOrderDesignRun(tx:TenantTransaction,context:TenantContext,snapshot:OrderDesignSnapshot,key:Uint8Array) {
  const plan=DesignAutomationPlanSchema.parse(snapshot.plan);
  await tx.insert(orderDesignDispatchTenants).values({tenantId:context.tenantId}).onConflictDoNothing();
  const [prior]=await tx.select().from(runs).where(and(eq(runs.workItemId,snapshot.workItemId),eq(runs.workRevisionId,snapshot.workRevisionId)));
  if(prior) return prior.id;
  const methodSnapshot=await selectOrderDesignMethod(tx,context,snapshot);
  const id=createEntityId();
  const ruleDiagnostics=pinnedRuleDiagnostics(snapshot);
  const ruleConflict=ruleDiagnostics.some(issue=>issue.severity==="error");
  await tx.insert(runs).values({id,tenantId:context.tenantId,workItemId:snapshot.workItemId,workRevisionId:snapshot.workRevisionId,
    executorKey:`strict-${snapshot.recipe.workflow}`,recipeVersion:snapshot.recipe.pillowPipeline?.version??"1",policyVersion:"order-design-v1",modelRouteId:snapshot.model?.routeId??null,
    encryptedSnapshot:seal(key,snapshot),inputChecksum:orderDesignInputChecksum(snapshot,methodSnapshot),methodSnapshot,requestedBy:context.userId,
    status:plan.status==="ready" && !snapshot.blockers?.length && !ruleConflict?"queued":"needs_attention",errorCode:ruleConflict?"agent_rule_conflict":snapshot.blockers?.[0]??plan.blockers[0]??null,
    qualityDiagnostics:[...ruleDiagnostics,...(snapshot.preparationDiagnostics??[])],
    estimatedCostUsd:plan.budget.estimatedCostUsd===null?null:String(plan.budget.estimatedCostUsd),actualCostUsd:plan.plannedModelCalls?null:"0",
    costStatus:plan.plannedModelCalls?(plan.budget.estimatedCostUsd===null?"unknown":"estimated"):"not_required",
  });
  for(const [position,input] of plan.steps.entries()) await tx.insert(steps).values({id:createEntityId(),tenantId:context.tenantId,runId:id,key:input.id,label:stepLabel(input.tool),position,requestId:createEntityId(),encryptedInput:seal(key,input),inputChecksum:fingerprint(input)});
  if(plan.status==="ready" && !snapshot.blockers?.length && !ruleConflict) await tx.insert(outbox).values({id:createEntityId(),tenantId:context.tenantId,runId:id,requestedBy:context.userId});
  return id;
}

/** A completion is evidence for reviewing this exact unapproved project version. */
export async function assertOrderDesignCandidate(tx:TenantTransaction,context:TenantContext,run:DesignRun,vault:SecretVault,versionId:string) {
  for(const permission of [Permission.OrderRead,Permission.OrderWrite,Permission.OrderPiiRead,Permission.DesignReview])authorize(context,permission);
  await lockWork(tx,run.workItemId);
  const [current]=await tx.select().from(runs).where(and(eq(runs.id,run.id),eq(runs.workItemId,run.workItemId))).for("update");
  if(!current || current.revision!==run.revision || current.status!=="awaiting_review" || current.currentEditorVersionId!==versionId)
    throw new OrderDesignError("agent_editor_changed");
  const [work]=await tx.select().from(works).where(eq(works.id,current.workItemId));
  const [project]=current.projectId?await tx.select().from(projects).where(eq(projects.id,current.projectId)).for("update"):[];
  if(!work?.encryptedDataKey || work.preparation!=="pushed" || work.held || work.archivedAt || work.expiresAt<=new Date() ||
    work.pushedRevisionId!==current.workRevisionId || work.editorProjectId!==current.projectId ||
    !project?.encryptedDataKey || project.status!=="active" || project.archivedAt || project.expiresAt && project.expiresAt<=new Date() ||
    project.sourceWorkItemId!==work.id || project.sourceWorkRevisionId!==work.pushedRevisionId || project.currentVersionId!==versionId)
    throw new OrderDesignError("agent_work_changed");
  const key=vault.withSecret(work.encryptedDataKey,value=>Buffer.from(value,"base64"));
  try {
    const snapshot=open<OrderDesignSnapshot>(key,current.encryptedSnapshot);
    const completion=readOrderDesignCompletion(current,snapshot);
    if(orderDesignInputChecksum(snapshot,current.methodSnapshot)!==current.inputChecksum || !completion)
      throw new OrderDesignError("agent_completion_invalid");
    const [version]=await tx.select().from(versions).where(and(eq(versions.id,versionId),eq(versions.projectId,project.id)));
    if(!version?.encryptedDocument || version.checksum!==completion.evidence.documentChecksum)
      throw new OrderDesignError("agent_completion_invalid");
    const proofs=await tx.select().from(renders).where(and(eq(renders.projectId,project.id),eq(renders.versionId,versionId),
      inArray(renders.id,completion.evidence.proofs.map(proof=>proof.renderId)))).for("share");
    if(proofs.length!==completion.evidence.proofs.length || completion.evidence.proofs.some(receipt=>{
      const proof=proofs.find(row=>row.id===receipt.renderId);
      return !proof || proof.status!=="completed" || !proof.encryptedManifest || fingerprint(proof.encryptedManifest)!==receipt.manifestChecksum;
    }))throw new OrderDesignError("agent_completion_invalid");
  } finally {key.fill(0);}
}

/** Shared by the explicit Agent command and an operator's rejection of its exact proof. */
export async function takeOverOrderDesignRun(tx:TenantTransaction,context:TenantContext,run:DesignRun,vault:SecretVault,options:{rejectedCandidateVersionId?:string}={}) {
  for(const permission of [Permission.OrderWrite,Permission.OrderPiiRead,options.rejectedCandidateVersionId?Permission.DesignReview:Permission.DesignWrite]) authorize(context,permission);
  await lockWork(tx,run.workItemId);
  const [current]=await tx.select().from(runs).where(and(eq(runs.id,run.id),eq(runs.workItemId,run.workItemId))).for("update");
  if(!current || current.revision!==run.revision)throw new OrderDesignError("agent_revision_changed");
  if(options.rejectedCandidateVersionId)await assertOrderDesignCandidate(tx,context,current,vault,options.rejectedCandidateVersionId);
  const [work]=await tx.select().from(works).where(eq(works.id,run.workItemId));
  const key=work?.encryptedDataKey?vault.withSecret(work.encryptedDataKey,value=>Buffer.from(value,"base64")):null;
  try {
    const active=await tx.select().from(steps).where(and(eq(steps.runId,run.id),inArray(steps.status,["pending","running"])));
    for(const step of active) {
      const input=key?open<{tool:string}>(key,step.encryptedInput):null;
      const output=key && step.encryptedOutput?open<OrderDesignStepCheckpoint>(key,step.encryptedOutput):{};
      const recovery=assessPaidRequestRecovery({submissionState:output.submissionState,
        hasResponseReceipt:!!output.responseReceipt,hasResponseCheckpoint:!!output.responseCheckpoint,
        provenNotSubmitted:step.status==="pending" && step.attempt===0});
      const uncertain=(!input || paidTool(input.tool)) && recovery.action==="reconcile";
      await tx.update(steps).set({status:uncertain?"uncertain":"skipped",errorCode:uncertain?`agent_model_${recovery.reason}`:"agent_manual_takeover",updatedAt:new Date()}).where(eq(steps.id,step.id));
      if(uncertain && !output.responseReceipt)await tx.update(runs).set({costStatus:"unknown",actualCostUsd:null}).where(eq(runs.id,run.id));
      else if(input && paidTool(input.tool) && recovery.reservation==="release")await tx.update(aiBudgetLedger).set({state:"released"}).where(and(eq(aiBudgetLedger.requestId,step.requestId),eq(aiBudgetLedger.state,"reserved")));
    }
  } finally {key?.fill(0);}
  await tx.update(runs).set({status:"cancelled",revision:current.revision+1,processingToken:null,leaseUntil:null,errorCode:"agent_manual_takeover",updatedAt:new Date()}).where(eq(runs.id,run.id));
}

export class OrderDesignRepository {
  constructor(readonly database:DatabaseConnection,readonly vault:SecretVault){}
  /** All attempts remain charge evidence, including cancelled or superseded runs. */
  async costEvidence(context: TenantContext, workItemIds: string[]) {
    authorize(context, Permission.OrderRead); authorize(context, Permission.OrderPiiRead);
    if (context.dataScope !== "tenant") throw new ForbiddenError(Permission.OrderRead, "outside_data_scope");
    if (!workItemIds.length) return { runs: [], truncated: false };
    return withTenant(this.database.db, context, async tx => {
      const rows = await tx.select({ id: runs.id, lineId: runs.workItemId, recipeVersion: runs.recipeVersion,
        costStatus: runs.costStatus, estimatedCostUsd: runs.estimatedCostUsd, actualCostUsd: runs.actualCostUsd,
        createdAt: runs.createdAt, errorCode: runs.errorCode, status: runs.status,
      }).from(runs).where(inArray(runs.workItemId, workItemIds)).orderBy(asc(runs.createdAt), asc(runs.id)).limit(1001);
      return { runs: rows.slice(0, 1000), truncated: rows.length > 1000 };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }
  async view(context:TenantContext,workItemId:string,options:{includePrivate?:boolean}={}) {
    authorize(context,Permission.OrderRead);authorize(context,Permission.OrderPiiRead);
    if(context.dataScope!=="tenant")throw new ForbiddenError(Permission.OrderRead,"outside_data_scope");
    return withTenant(this.database.db,context,async tx=>{
      const includePrivate=options.includePrivate!==false;
      const authority=()=>tx.select({id:works.id,encryptedDataKey:includePrivate?works.encryptedDataKey:sql<null>`null`,
        privateAvailable:sql<boolean>`${works.encryptedDataKey} is not null and ${works.expiresAt}>clock_timestamp() and ${orders.addressStatus}<>'anonymized'`})
        .from(works).innerJoin(orderLines,eq(orderLines.id,works.id)).innerJoin(orders,eq(orders.id,orderLines.orderId)).where(eq(works.id,workItemId)).limit(1);
      const [work]=await authority();
      if(!work) throw new OrderDesignError("agent_work_not_found");
      const [run]=await tx.select().from(runs).where(eq(runs.workItemId,workItemId)).orderBy(desc(runs.createdAt)).limit(1);
      if(!run) return {run:null};
      const rows=includePrivate&&work.privateAvailable?await tx.select().from(steps).where(eq(steps.runId,run.id)).orderBy(steps.position):[];
      if(includePrivate&&run.methodSnapshot?.methodSelection.mode==="published")authorize(context,Permission.WorkflowRead);
      const callRows=await tx.select({id:modelCalls.id,stepId:modelCalls.stepId,requestId:modelCalls.requestId,attempt:modelCalls.attempt,
        submittedAt:modelCalls.submittedAt,receivedAt:modelCalls.receivedAt,costReportState:modelCalls.costReportState,reportedCostUsd:modelCalls.reportedCostUsd,
        budgetState:aiBudgetLedger.state,budgetAmountUsd:aiBudgetLedger.amountUsd}).from(modelCalls).innerJoin(aiBudgetLedger,eq(aiBudgetLedger.id,modelCalls.budgetLedgerId))
        .where(eq(modelCalls.runId,run.id)).orderBy(desc(modelCalls.submittedAt),desc(modelCalls.id)).limit(1001);
      let ruleSnapshot=null;
      let recoveryTarget=null;
      let recoveryBlockedCode:string|null=null;
      const responseRecoveries=new Map<string,OrderDesignResponseRecoveryEvidence>();
      const contourEvidence=new Map<string,PillowContourEvidence>();
      let completion=null;
      if(includePrivate&&work.encryptedDataKey && work.privateAvailable) {
        const key=this.vault.withSecret(work.encryptedDataKey,value=>Buffer.from(value,"base64"));
        try {
          const snapshot=open<OrderDesignSnapshot>(key,run.encryptedSnapshot);
          if(orderDesignInputChecksum(snapshot,run.methodSnapshot)!==run.inputChecksum)throw new OrderDesignError("agent_snapshot_invalid");
          completion=readOrderDesignCompletion(run,snapshot);
          ruleSnapshot=snapshot.ruleSnapshot?OrderRuleSnapshotSchema.parse(snapshot.ruleSnapshot):null;
          for(const step of rows) {
            if(!step.encryptedOutput)continue;
            const output=open<{responseRecovery?:unknown}>(key,step.encryptedOutput);
            if(output.responseRecovery)responseRecoveries.set(step.id,OrderDesignResponseRecoveryEvidenceSchema.parse(output.responseRecovery));
          }
          if(run.status==="needs_attention" && rows.some(step=>step.status==="uncertain")) {
            try {recoveryTarget=(await responseRecoveryTarget(tx,context,run,rows,key)).target;}
            catch(error) {if(!(error instanceof OrderDesignError))throw error;recoveryBlockedCode=error.code;}
          }
          if(snapshot.recipe.pillowPipeline?.contour.workflow)for(const step of rows) {
            if(step.key!=="optimize_contour" || step.status!=="completed" || !step.encryptedOutput)continue;
            const output=open<{contourEvidence?:unknown}>(key,step.encryptedOutput);
            if(output.contourEvidence)contourEvidence.set(step.id,PillowContourEvidenceSchema.parse(output.contourEvidence));
          }
        }
        finally {key.fill(0);}
      }
      const [latest]=await authority();const privateEvidenceState=latest?.privateAvailable?"available":"expired";
      const exposePrivate=includePrivate&&work.privateAvailable&&latest?.privateAvailable&&work.encryptedDataKey===latest.encryptedDataKey;
      return OrderDesignAgentViewSchema.parse({run:{...run,ruleSnapshot:exposePrivate?ruleSnapshot:null,methodSnapshot:exposePrivate?run.methodSnapshot:null,completion:exposePrivate?completion:null,privateEvidenceState,privateEvidenceOmitted:!exposePrivate,createdAt:run.createdAt.toISOString(),updatedAt:run.updatedAt.toISOString(),
        modelCalls:callRows.slice(0,1000).map(call=>({...call,submittedAt:call.submittedAt.toISOString(),receivedAt:call.receivedAt?.toISOString()??null})),modelCallsTruncated:callRows.length>1000,
        responseRecoveryTarget:exposePrivate?recoveryTarget:null,responseRecoveryBlockedCode:exposePrivate?recoveryBlockedCode:null,qualityDiagnostics:exposePrivate?run.qualityDiagnostics:[],
        estimatedCostUsd:run.estimatedCostUsd===null?null:Number(run.estimatedCostUsd),actualCostUsd:run.actualCostUsd===null?null:Number(run.actualCostUsd),
        canResume:!!exposePrivate&&canResumeDesignRun(run,rows),
        canTakeOver:!!exposePrivate&&run.status!=="cancelled",steps:exposePrivate?rows.map(step=>({...step,responseRecovery:responseRecoveries.get(step.id)??null,contourEvidence:contourEvidence.get(step.id)??null,startedAt:step.startedAt?.toISOString()??null,completedAt:step.completedAt?.toISOString()??null})):[]}});
    });
  }
  async command(context:TenantContext,workItemId:string,action:"resume"|"takeover",raw:unknown) {
    for(const permission of [Permission.OrderWrite,Permission.OrderPiiRead,Permission.DesignWrite]) authorize(context,permission);
    const input=OrderDesignAgentActionSchema.parse(raw),digest=fingerprint({action,...input});
    await withTenant(this.database.db,context,async tx=>{
      await lockWork(tx,workItemId);
      const [run]=await tx.select().from(runs).where(and(eq(runs.id,input.runId),eq(runs.workItemId,workItemId))).for("update");
      if(!run) throw new OrderDesignError("agent_run_not_found");
      const [prior]=await tx.select().from(commands).where(and(eq(commands.runId,run.id),eq(commands.idempotencyKey,input.idempotencyKey)));
      if(prior) {if(prior.requestChecksum!==digest) throw new OrderDesignError("agent_command_conflict");return;}
      if(run.revision!==input.expectedRevision) throw new OrderDesignError("agent_revision_changed");
      if(action==="resume") {
        const work=await assertRunSource(tx,run);
        const key=this.vault.withSecret(work.encryptedDataKey!,value=>Buffer.from(value,"base64"));
        try{const snapshot=open<OrderDesignSnapshot>(key,run.encryptedSnapshot);if(orderDesignInputChecksum(snapshot,run.methodSnapshot)!==run.inputChecksum)throw new OrderDesignError("agent_snapshot_invalid");await assertOrderDesignMethod(tx,context,snapshot,run.methodSnapshot,{lock:true});}finally{key.fill(0);}
        const rows=await tx.select().from(steps).where(eq(steps.runId,run.id));
        if(!canResumeDesignRun(run,rows)) throw new OrderDesignError("agent_resume_not_safe");
        await tx.update(steps).set({status:"pending",errorCode:null,updatedAt:new Date()}).where(and(eq(steps.runId,run.id),eq(steps.status,"failed")));
        await tx.insert(outbox).values({id:createEntityId(),tenantId:context.tenantId,runId:run.id,requestedBy:run.requestedBy});
        await tx.update(runs).set({status:"queued",revision:run.revision+1,processingToken:null,leaseUntil:null,errorCode:null,updatedAt:new Date()}).where(eq(runs.id,run.id));
      } else await takeOverOrderDesignRun(tx,context,run,this.vault);
      await tx.insert(commands).values({id:createEntityId(),tenantId:context.tenantId,runId:run.id,idempotencyKey:input.idempotencyKey,action,requestChecksum:digest,requestedBy:context.userId});
    });
    return this.view(context,workItemId);
  }
}

/** Routing IDs only are enumerated under the application role. Every business
 * lookup still enters a separate tenant RLS transaction; no owner query is used. */
export async function dispatchOrderDesignOutbox(database:DatabaseConnection,dispatcher:OrderDesignDispatcher) {
  let cursor:string|undefined;let count=0;
  for(;;) {
    const tenants=await database.db.transaction(async tx=>{await tx.execute(sql.raw("set local role yummyai_app"));return tx.select({id:orderDesignDispatchTenants.tenantId}).from(orderDesignDispatchTenants).where(cursor?gt(orderDesignDispatchTenants.tenantId,cursor):undefined).orderBy(orderDesignDispatchTenants.tenantId).limit(50);});
    if(!tenants.length) break;
    for(const tenant of tenants) {
      const scope:TenantContext={tenantId:tenant.id,userId:tenant.id,dataScope:"tenant",permissions:[]};
      // nextAttemptAt is database-generated. Compare and reschedule using that
      // same clock, including on hosts whose container clock is slightly ahead.
      const pending=await withTenant(database.db,scope,tx=>tx.select().from(outbox).where(and(isNull(outbox.dispatchedAt),lte(outbox.nextAttemptAt,sql`now()`))).orderBy(asc(outbox.createdAt)).limit(50));
      for(const event of pending) {
        try {await dispatcher.enqueue({tenantId:tenant.id,requestedBy:event.requestedBy,runId:event.runId,dispatchId:event.id});
          await withTenant(database.db,scope,tx=>tx.update(outbox).set({dispatchedAt:new Date()}).where(eq(outbox.id,event.id)));count+=1;
        } catch {await withTenant(database.db,scope,tx=>tx.update(outbox).set({nextAttemptAt:sql`now() + interval '30 seconds'`}).where(eq(outbox.id,event.id)));}
      }
      // The database also repairs lost Redis jobs and crashed processors. A new
      // dispatch identity avoids relying on the queue's finite dedup retention.
      await withTenant(database.db,scope,async tx=>{
        const stalled=await tx.select().from(runs).where(and(inArray(runs.status,["queued","running"]),lte(runs.updatedAt,new Date(Date.now()-120_000)))).limit(50).for("update",{skipLocked:true});
        for(const run of stalled) {
          if(run.leaseUntil && run.leaseUntil>new Date()) continue;
          const [unpublished]=await tx.select({id:outbox.id}).from(outbox).where(and(eq(outbox.runId,run.id),isNull(outbox.dispatchedAt))).limit(1);
          if(!unpublished) await tx.insert(outbox).values({id:createEntityId(),tenantId:tenant.id,runId:run.id,requestedBy:run.requestedBy});
          await tx.update(runs).set({updatedAt:new Date()}).where(eq(runs.id,run.id));
        }
      });
    }
    cursor=tenants.at(-1)!.id;
  }
  return count;
}
function canResumeDesignRun(run:Pick<DesignRun,"status"|"errorCode">,rows:Pick<DesignStep,"status"|"errorCode">[]){
  const retryable=rows.some(step=>step.status==="failed") || run.errorCode==="agent_method_unavailable"&&rows.some(step=>step.status==="pending");
  return run.status==="needs_attention"&&retryable&&!rows.some(step=>step.status==="uncertain"||["agent_retry_exhausted","agent_model_response_checkpoint_invalid","agent_scan_rejected","agent_model_cost_report_invalid","agent_model_cost_conflict","agent_model_original_budget_exceeded"].includes(step.errorCode??""));
}
function stepLabel(tool:string) {return ({validate_inputs:"核验并准备素材",compose_template:"模板排版",enhance_image:"顾客图片保真美化",cutout_subject:"主体抠图",measure_subject:"测量可见主体",ensure_resolution:"检查并补强实际分辨率",optimize_contour:"制作裁切轮廓",preflight:"质量检查",render_proof:"生成校样",review_required:"等待人工审核"} as Record<string,string>)[tool]??tool;}
