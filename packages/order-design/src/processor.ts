import { randomBytes } from "node:crypto";
import { assessPaidRequestRecovery, type SecretVault } from "@yummyai/ai-core";
import { createEntityId, ProductionEditorDocumentSchema, type TenantContext } from "@yummyai/contracts";
import { DesignAutomationStepSchema } from "@yummyai/contracts/pod/design-automation";
import { orderDesignAgentRuns as runs, orderDesignAgentSteps as steps, orderWorkItems as works, orderLines,orders,productionEditorProjects as projects,
  productionEditorVersions as versions, productionEditorImages as images, productionEditorRenders as renders, aiBudgetLedger, aiBudgetPolicies,
  withTenant,type DatabaseConnection,type TenantTransaction } from "@yummyai/database";
import { and,eq,inArray,gte,sql } from "drizzle-orm";
import type { Storage } from "@yummyai/storage";
import { ClamAvScanner } from "@yummyai/storage";
import { fingerprint,seal,open } from "./crypto.js";
import { assertExecutionIdentity,assertRunSource,assertOrderDesignRunMethod,executionPermissions,lockWork,paidTool,type DesignRun,type DesignStep } from "./repository.js";
import { orderDesignInputChecksum } from "./harness.js";
import { sealOrderDesignCompletion } from "./completion.js";
import {registerOrderModelSubmission,recordOrderModelResponse,readOrderModelCostProjection,orderModelBudgetAmount} from "./model-costs.js";
import {orderDesignModelCalls as modelCalls} from "@yummyai/database";
import { OrderDesignError,OrderDesignSubmissionNotSentError,type DesignStepInput,type OrderDesignImageGateway,type OrderDesignSuperResolutionGateway,type OrderDesignSnapshot,
  type OrderDesignStepCheckpoint,type OrderDesignResponseReceipt,type OrderDesignResponseCheckpoint } from "./types.js";
import { OrderDesignExecutor, type StepResult } from "./executor.js";

export class OrderDesignProcessor {
  private readonly executor:OrderDesignExecutor;
  constructor(private readonly database:DatabaseConnection,storage:Storage,private readonly vault:SecretVault,gateway:OrderDesignImageGateway,scanner:Pick<ClamAvScanner,"scan">=new ClamAvScanner(),superResolution?:OrderDesignSuperResolutionGateway) {
    this.executor=new OrderDesignExecutor(database,storage,vault,gateway,scanner,superResolution);
  }
  async process(input:{tenantId:string;requestedBy:string;runId:string}) {
    const context:TenantContext={tenantId:input.tenantId,userId:input.requestedBy,dataScope:"tenant",permissions:executionPermissions};
    const token=createEntityId();
    const claimed=await withTenant(this.database.db,context,async tx=>{
      const [found]=await tx.select().from(runs).where(eq(runs.id,input.runId));
      if(!found || !["queued","running"].includes(found.status)) return null;
      await lockWork(tx,found.workItemId);
      const [run]=await tx.select().from(runs).where(eq(runs.id,found.id)).for("update");
      if(!run || !["queued","running"].includes(run.status) || run.leaseUntil && run.leaseUntil>new Date()) return null;
      if(run.requestedBy!==context.userId) throw new OrderDesignError("agent_requester_mismatch");
      try {await assertExecutionIdentity(tx,context);await assertRunSource(tx,run);}
      catch(error) {await tx.update(runs).set({status:"needs_attention",errorCode:safeCode(error),updatedAt:new Date()}).where(eq(runs.id,run.id));return null;}
      const work=await assertRunSource(tx,run),key=this.workKey(work.encryptedDataKey!);
      try {
        const snapshot=open<OrderDesignSnapshot>(key,run.encryptedSnapshot);
        if(orderDesignInputChecksum(snapshot,run.methodSnapshot)!==run.inputChecksum || snapshot.plan.status!=="ready") throw new OrderDesignError("agent_snapshot_invalid");
        try{await assertOrderDesignRunMethod(tx,context,run,key);}catch(error){await tx.update(runs).set({status:"needs_attention",errorCode:safeCode(error),processingToken:null,leaseUntil:null,updatedAt:new Date()}).where(eq(runs.id,run.id));return null;}
        const interrupted=await tx.select().from(steps).where(and(eq(steps.runId,run.id),eq(steps.status,"running")));
        for(const step of interrupted) {
          const task=DesignAutomationStepSchema.parse(open(key,step.encryptedInput));
          const checkpoint=step.encryptedOutput?open<OrderDesignStepCheckpoint>(key,step.encryptedOutput):{};
          const recovery=assessPaidRequestRecovery({submissionState:checkpoint.submissionState,hasResponseReceipt:!!checkpoint.responseReceipt,hasResponseCheckpoint:!!checkpoint.responseCheckpoint});
          if(paidTool(task.tool) && recovery.action==="reconcile") {
            const code=`agent_model_${recovery.reason}`;
            await tx.update(steps).set({status:"uncertain",errorCode:code,updatedAt:new Date()}).where(eq(steps.id,step.id));
            const costEvidence=await readPaidCostEvidence(tx,run.id,snapshot.plan.plannedModelCalls);
            await tx.update(runs).set({status:"needs_attention",processingToken:null,leaseUntil:null,...costEvidence,errorCode:code,updatedAt:new Date()}).where(eq(runs.id,run.id));
            return null;
          }
          if(paidTool(task.tool) && recovery.reservation==="release") await tx.update(aiBudgetLedger).set({state:"released"}).where(and(eq(aiBudgetLedger.requestId,step.requestId),eq(aiBudgetLedger.state,"reserved")));
          await tx.update(steps).set({status:"pending",updatedAt:new Date()}).where(eq(steps.id,step.id));
        }
        let projectId=run.projectId,versionId=run.currentEditorVersionId;
        if(!projectId) {
          projectId=createEntityId();versionId=createEntityId();const projectKey=randomBytes(32);
          const document=ProductionEditorDocumentSchema.parse({...snapshot.document,layers:[],confirmations:{...snapshot.document.confirmations,visualReview:false}});
          try {
            await tx.insert(projects).values({id:projectId,tenantId:context.tenantId,name:document.productType,encryptedDataKey:this.vault.encrypt(projectKey.toString("base64")),sourceWorkItemId:run.workItemId,sourceWorkRevisionId:run.workRevisionId,expiresAt:work.expiresAt,createdBy:context.userId});
            await tx.insert(versions).values({id:versionId!,tenantId:context.tenantId,projectId,versionNumber:1,encryptedDocument:seal(projectKey,document),checksum:fingerprint(document),createdBy:context.userId});
            await tx.update(projects).set({currentVersionId:versionId,versionNumber:1}).where(eq(projects.id,projectId));
            await tx.update(works).set({editorProjectId:projectId,artwork:"in_progress",projectionVersion:sql`${works.projectionVersion}+1`,updatedAt:new Date()}).where(eq(works.id,run.workItemId));
          } finally {projectKey.fill(0);}
        }
        const [current]=await tx.update(runs).set({status:"running",projectId,currentEditorVersionId:versionId,processingToken:token,leaseUntil:new Date(Date.now()+90_000),errorCode:null,updatedAt:new Date()}).where(eq(runs.id,run.id)).returning();
        return {run:current!,snapshot};
      } finally {key.fill(0);}
    });
    if(!claimed) return {disposition:"not_runnable"};
    const controller=new AbortController();
    let heartbeatBusy=false;
    const heartbeat=setInterval(()=>{
      if(heartbeatBusy) return;heartbeatBusy=true;
      void withTenant(this.database.db,context,async tx=>{
        const changed=await tx.update(runs).set({leaseUntil:new Date(Date.now()+90_000),updatedAt:new Date()}).where(and(eq(runs.id,input.runId),eq(runs.processingToken,token),eq(runs.status,"running"))).returning({id:runs.id});
        if(!changed.length) controller.abort();
      }).catch(()=>controller.abort()).finally(()=>{heartbeatBusy=false;});
    },20_000);
    try {
      for(;;) {
        const active=await this.claimStep(context,claimed.run.id,token);
        if(!active) break;
        try {
          const result=await this.executor.execute({context,run:active.run,step:active.step,input:active.input,snapshot:claimed.snapshot,signal:controller.signal,
            responseCheckpoint:active.responseCheckpoint,
            responseRecovery:active.responseRecovery,
            assertActive:()=>this.assertActive(context,active.run.id,token),markSubmitted:()=>this.markSubmitted(context,active.run,active.step,token),
            markReceived:receipt=>this.recordResponse(context,active.run,active.step,token,receipt),
            checkpointResponse:checkpoint=>this.recordResponse(context,active.run,active.step,token,checkpoint)});
          await this.commitStep(context,active.run,active.step,active.input,result,token);
        } catch(error) {
          const retry=await withTenant(this.database.db,context,async tx=>{
            await lockWork(tx,active.run.workItemId);
            const [run]=await tx.select().from(runs).where(and(eq(runs.id,active.run.id),eq(runs.processingToken,token))).for("update");
            if(!run || run.status!=="running") return;
            const work=await tx.select().from(works).where(eq(works.id,run.workItemId));
            const [currentStep]=await tx.select().from(steps).where(eq(steps.id,active.step.id));
            // A lost commit acknowledgement must not turn an already committed step back into pending.
            if(currentStep?.status==="completed")return true;
            const [originalCall]=await tx.select({receivedAt:modelCalls.receivedAt}).from(modelCalls).where(and(eq(modelCalls.stepId,active.step.id),eq(modelCalls.claimToken,token))).limit(1);
            const key=work[0]?.encryptedDataKey?this.workKey(work[0].encryptedDataKey):null;
            let checkpoint:OrderDesignStepCheckpoint={};
            try {
              const prior=key && currentStep?.encryptedOutput?open<OrderDesignStepCheckpoint>(key,currentStep.encryptedOutput):{};
              checkpoint={...prior,...(originalCall?{submissionState:originalCall.receivedAt?"received" as const:"submitted" as const}:!key&&paidTool(active.input.tool)?{submissionState:"submitted" as const}:{})};
              const recoverable=active.input.tool==="ensure_resolution" && error instanceof OrderDesignError && ["agent_upscale_timeout","agent_upscale_process_failed","agent_upscale_busy"].includes(error.code);
              const responseRecoverable=!!prior.responseCheckpoint && error instanceof OrderDesignError &&
                ["agent_scan_unavailable","agent_asset_storage_unavailable","agent_asset_preview_failed"].includes(error.code);
              if((recoverable || responseRecoverable) && key && currentStep && !controller.signal.aborted) {
                const attempt=responseRecoverable?(prior.responseProcessingAttempts??1):currentStep.attempt;
                const retryAllowed=attempt<3;
                await tx.update(steps).set({...(retryAllowed?{status:"pending" as const}:{}),errorCode:safeCode(error),
                  encryptedOutput:seal(key,{...prior,localRecovery:[...(prior.localRecovery??[]),{attempt,code:safeCode(error)}]}),updatedAt:new Date()}).where(eq(steps.id,currentStep.id));
                if(retryAllowed)return true;
              }
            } finally{key?.fill(0);}
            const recovery=assessPaidRequestRecovery({submissionState:checkpoint.submissionState,
              hasResponseReceipt:!!checkpoint.responseReceipt||!!originalCall?.receivedAt || (error instanceof OrderDesignError && error.code==="agent_model_response_uncheckpointed"),
              hasResponseCheckpoint:!!checkpoint.responseCheckpoint,provenNotSubmitted:error instanceof OrderDesignSubmissionNotSentError});
            const hasResponse=recovery.action==="reuse_response";
            const responseCaptureStopped=error instanceof OrderDesignError&&["agent_source_expired","agent_model_cost_report_invalid","agent_model_cost_conflict"].includes(error.code);
            const uncertain=paidTool(active.input.tool) && recovery.action==="reconcile"&&!responseCaptureStopped;
            const exhausted=hasResponse?(checkpoint.responseProcessingAttempts??1)>=3:!paidTool(active.input.tool) && (currentStep?.attempt??0)>=3;
            const code=responseCaptureStopped?safeCode(error):uncertain?`agent_model_${recovery.reason}`:exhausted?"agent_retry_exhausted":
              hasResponse?(error instanceof OrderDesignError?safeCode(error):"agent_model_response_processing_failed"):safeCode(error);
            if(paidTool(active.input.tool) && !responseCaptureStopped&&recovery.reservation==="release")await tx.update(aiBudgetLedger).set({state:"released"}).where(and(eq(aiBudgetLedger.requestId,active.step.requestId),eq(aiBudgetLedger.state,"reserved")));
            await tx.update(steps).set({status:uncertain?"uncertain":"failed",errorCode:code,updatedAt:new Date()}).where(eq(steps.id,active.step.id));
            const costEvidence=paidTool(active.input.tool) && (uncertain || hasResponse||responseCaptureStopped)?await readPaidCostEvidence(tx,run.id,claimed.snapshot.plan.plannedModelCalls):{};
            await tx.update(runs).set({status:"needs_attention",errorCode:code,processingToken:null,leaseUntil:null,...costEvidence,updatedAt:new Date()}).where(eq(runs.id,run.id));
          });
          if(retry)continue;
          break;
        }
      }
    } catch(error) {
      await withTenant(this.database.db,context,tx=>tx.update(runs).set({status:"needs_attention",errorCode:safeCode(error),processingToken:null,leaseUntil:null,updatedAt:new Date()}).where(and(eq(runs.id,input.runId),eq(runs.processingToken,token))));
    } finally {clearInterval(heartbeat);controller.abort();}
    return {disposition:"processed"};
  }
  private async claimStep(context:TenantContext,id:string,token:string) {
    return withTenant(this.database.db,context,async tx=>{
      const [found]=await tx.select().from(runs).where(eq(runs.id,id));if(!found) return null;
      await lockWork(tx,found.workItemId);
      const [run]=await tx.select().from(runs).where(and(eq(runs.id,id),eq(runs.processingToken,token),eq(runs.status,"running"))).for("update");
      if(!run) return null;
      await assertExecutionIdentity(tx,context);const work=await assertRunSource(tx,run);
      const rows=await tx.select().from(steps).where(eq(steps.runId,id)).orderBy(steps.position);
      const step=rows.find(row=>row.status==="pending");
      if(!step) return null;
      const key=this.workKey(work.encryptedDataKey!);
      try {
        await assertOrderDesignRunMethod(tx,context,run,key);
        const input=DesignAutomationStepSchema.parse(open(key,step.encryptedInput));
        if(fingerprint(input)!==step.inputChecksum || input.dependsOn.some(dependency=>!rows.some(row=>row.key===dependency && row.status==="completed"))) throw new OrderDesignError("agent_step_dependency_invalid");
        const checkpoint=step.encryptedOutput?open<OrderDesignStepCheckpoint>(key,step.encryptedOutput):{};
        const responseCheckpoint=paidTool(input.tool)?checkpoint.responseCheckpoint:undefined;
        if(responseCheckpoint && !validResponseCheckpoint(responseCheckpoint,step,context)) {
          await tx.update(steps).set({status:"failed",errorCode:"agent_model_response_checkpoint_invalid",updatedAt:new Date()}).where(eq(steps.id,step.id));
          await tx.update(runs).set({status:"needs_attention",errorCode:"agent_model_response_checkpoint_invalid",processingToken:null,leaseUntil:null,updatedAt:new Date()}).where(eq(runs.id,run.id));
          return null;
        }
        if((step.attempt>=3 && !paidTool(input.tool)) || (responseCheckpoint && (checkpoint.responseProcessingAttempts??1)>=3)) {
          await tx.update(steps).set({status:"failed",errorCode:"agent_retry_exhausted",updatedAt:new Date()}).where(eq(steps.id,step.id));
          await tx.update(runs).set({status:"needs_attention",errorCode:"agent_retry_exhausted",processingToken:null,leaseUntil:null,updatedAt:new Date()}).where(eq(runs.id,run.id));
          return null;
        }
        if(paidTool(input.tool) && !responseCheckpoint && checkpoint.responseReceipt) {
          await tx.update(steps).set({status:"uncertain",errorCode:"agent_model_response_uncheckpointed",updatedAt:new Date()}).where(eq(steps.id,step.id));
          await tx.update(runs).set({status:"needs_attention",errorCode:"agent_model_response_uncheckpointed",processingToken:null,leaseUntil:null,updatedAt:new Date()}).where(eq(runs.id,run.id));
          return null;
        }
        if(paidTool(input.tool) && !responseCheckpoint) {
          try {await reserveModelBudget(tx,context,run,step,open<OrderDesignSnapshot>(key,run.encryptedSnapshot));}
          catch(error){const uncertain=error instanceof OrderDesignError && error.uncertain;await tx.update(steps).set({status:uncertain?"uncertain":"failed",errorCode:safeCode(error),updatedAt:new Date()}).where(eq(steps.id,step.id));await tx.update(runs).set({status:"needs_attention",errorCode:safeCode(error),processingToken:null,leaseUntil:null,...(uncertain?{costStatus:"unknown",actualCostUsd:null}:{}),updatedAt:new Date()}).where(eq(runs.id,run.id));return null;}
        }
        const priorLocal=input.tool==="ensure_resolution"?checkpoint.localRecovery:undefined;
        const output=responseCheckpoint?{...checkpoint,responseProcessingAttempts:(checkpoint.responseProcessingAttempts??1)+1}:
          {submissionState:"not_submitted",...(priorLocal?{localRecovery:priorLocal}:{})};
        await tx.update(steps).set({status:"running",attempt:step.attempt+1,startedAt:new Date(),errorCode:null,encryptedOutput:seal(key,output),updatedAt:new Date()}).where(eq(steps.id,step.id));
        return {run,step,input,responseCheckpoint,responseRecovery:checkpoint.responseRecovery};
      } finally {key.fill(0);}
    });
  }
  private async assertActive(context:TenantContext,id:string,token:string) {
    await withTenant(this.database.db,context,async tx=>{
      const [run]=await tx.select().from(runs).where(and(eq(runs.id,id),eq(runs.processingToken,token),eq(runs.status,"running")));
      if(!run) throw new OrderDesignError("agent_claim_lost");
      await assertExecutionIdentity(tx,context);await assertRunSource(tx,run);
      const [work]=await tx.select().from(works).where(eq(works.id,run.workItemId));
      const key=this.workKey(work!.encryptedDataKey!);try{await assertOrderDesignRunMethod(tx,context,run,key);}finally{key.fill(0);}
      const [project]=await tx.select().from(projects).where(eq(projects.id,run.projectId!));
      if(!project?.encryptedDataKey || project.status!=="active" || project.currentVersionId!==run.currentEditorVersionId) throw new OrderDesignError("agent_editor_changed");
    });
  }
  private async markSubmitted(context:TenantContext,run:DesignRun,step:DesignStep,token:string) {
    await withTenant(this.database.db,context,async tx=>{
      await lockWork(tx,run.workItemId);
      const [current]=await tx.select().from(runs).where(and(eq(runs.id,run.id),eq(runs.processingToken,token),eq(runs.status,"running"))).for("update");
      if(!current)throw new OrderDesignSubmissionNotSentError("agent_claim_lost");
      const work=await assertRunSource(tx,current);await assertExecutionIdentity(tx,context);
      const key=this.workKey(work.encryptedDataKey!);try{await assertOrderDesignRunMethod(tx,context,current,key);await registerOrderModelSubmission(tx,context,current,step,token);await tx.update(steps).set({encryptedOutput:seal(key,{submissionState:"submitted"}),updatedAt:new Date()}).where(eq(steps.id,step.id));}finally{key.fill(0);}
    });
  }
  private async recordResponse(context:TenantContext,run:DesignRun,step:DesignStep,token:string,receipt:OrderDesignResponseReceipt|OrderDesignResponseCheckpoint) {
    const fee=await recordOrderModelResponse(this.database,context,run,step,token,receipt);
    if(fee.state==="invalid")throw new OrderDesignError("agent_model_cost_report_invalid");
    await withTenant(this.database.db,context,async tx=>{
      await lockWork(tx,run.workItemId);
      const [current]=await tx.select().from(runs).where(and(eq(runs.id,run.id),eq(runs.processingToken,token),eq(runs.status,"running"))).for("update");
      if(!current)throw new OrderDesignError("agent_claim_lost");
      // Capture only the already submitted original response; current execution authority is rechecked before adoption.
      if(current.requestedBy!==context.userId)throw new OrderDesignError("agent_claim_lost");
      const [work]=await tx.select().from(works).where(and(eq(works.id,current.workItemId),sql`${works.expiresAt}>clock_timestamp()`)).for("share");
      const [source]=await tx.select({addressStatus:orders.addressStatus}).from(orderLines).innerJoin(orders,eq(orders.id,orderLines.orderId)).where(eq(orderLines.id,current.workItemId));
      if(!work?.encryptedDataKey||!source||source.addressStatus==="anonymized")throw new OrderDesignError("agent_source_expired");
      const [active]=await tx.select().from(steps).where(and(eq(steps.id,step.id),eq(steps.status,"running"))).for("update");
      if(!active || receipt.requestId!==step.requestId)throw new OrderDesignError("agent_claim_lost");
      const key=this.workKey(work.encryptedDataKey!);
      try {
        const prior=active.encryptedOutput?open<OrderDesignStepCheckpoint>(key,active.encryptedOutput):{};
        const {objectKey:rawObjectKey,...baseReceipt}={...receipt,...("objectKey" in receipt?{}:{objectKey:undefined})};
        if(prior.responseReceipt && fingerprint(prior.responseReceipt)!==fingerprint(baseReceipt))throw new OrderDesignError("agent_model_response_checkpoint_invalid");
        if(rawObjectKey && !validResponseCheckpoint(receipt as OrderDesignResponseCheckpoint,step,context))throw new OrderDesignError("agent_model_response_checkpoint_invalid");
        const updated:OrderDesignStepCheckpoint={...prior,submissionState:"received",responseReceipt:baseReceipt,
          ...(rawObjectKey?{responseCheckpoint:receipt as OrderDesignResponseCheckpoint,responseProcessingAttempts:1}:{})};
        await tx.update(steps).set({encryptedOutput:seal(key,updated),updatedAt:new Date()}).where(eq(steps.id,step.id));
        if(receipt.actualCostUsd!==undefined) {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:ai-assist-budget`},0))`);
          await tx.update(aiBudgetLedger).set({state:"committed",amountUsd:String(receipt.actualCostUsd)}).where(and(eq(aiBudgetLedger.requestId,step.requestId),eq(aiBudgetLedger.state,"reserved")));
        }
        const snapshot=open<OrderDesignSnapshot>(key,current.encryptedSnapshot);
        const costEvidence=await readPaidCostEvidence(tx,run.id,snapshot.plan.plannedModelCalls);
        await tx.update(runs).set({...costEvidence,updatedAt:new Date()}).where(eq(runs.id,run.id));
      } finally {key.fill(0);}
    });
  }
  private async commitStep(context:TenantContext,run:DesignRun,step:DesignStep,input:DesignStepInput,result:StepResult,token:string) {
    await withTenant(this.database.db,context,async tx=>{
      await lockWork(tx,run.workItemId);
      const [current]=await tx.select().from(runs).where(and(eq(runs.id,run.id),eq(runs.processingToken,token),eq(runs.status,"running"))).for("update");
      if(!current) throw new OrderDesignError("agent_claim_lost");
      await assertExecutionIdentity(tx,context);const work=await assertRunSource(tx,current);
      const [project]=await tx.select().from(projects).where(eq(projects.id,current.projectId!)).for("update");
      if(!project?.encryptedDataKey || project.status!=="active" || project.currentVersionId!==current.currentEditorVersionId) throw new OrderDesignError("agent_editor_changed");
      const projectKey=this.workKey(project.encryptedDataKey),workKey=this.workKey(work.encryptedDataKey!);
      try {
        const snapshot=await assertOrderDesignRunMethod(tx,context,current,workKey);
        for(const asset of result.assets??[]) await tx.insert(images).values(asset);
        let versionId=current.currentEditorVersionId;
        if(result.document) {
          const document=ProductionEditorDocumentSchema.parse({...result.document,confirmations:{...result.document.confirmations,visualReview:false}});
          versionId=createEntityId();
          await tx.insert(versions).values({id:versionId,tenantId:context.tenantId,projectId:project.id,versionNumber:project.versionNumber+1,encryptedDocument:seal(projectKey,document),checksum:fingerprint(document),createdBy:context.userId});
          await tx.update(projects).set({currentVersionId:versionId,versionNumber:project.versionNumber+1,reviewedVersionId:null,reviewedBy:null,reviewedAt:null,updatedAt:new Date()}).where(eq(projects.id,project.id));
        }
        if(result.proof) await tx.insert(renders).values({id:step.requestId,tenantId:context.tenantId,projectId:project.id,versionId:versionId!,status:"completed",requestedBy:context.userId,encryptedOptions:seal(projectKey,{format:result.proofFormat??"png",background:result.proofBackground??"transparent",purpose:"preview",previewFullResolution:true}),encryptedManifest:seal(projectKey,result.proof)});
        if(paidTool(input.tool) && result.actualCostUsd!==undefined) {await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:ai-assist-budget`},0))`);await tx.update(aiBudgetLedger).set({state:"committed",amountUsd:String(result.actualCostUsd)}).where(and(eq(aiBudgetLedger.requestId,step.requestId),eq(aiBudgetLedger.state,"reserved")));}
        const [latestStep]=await tx.select({encryptedOutput:steps.encryptedOutput}).from(steps).where(eq(steps.id,step.id));
        const latest=latestStep?.encryptedOutput?open<OrderDesignStepCheckpoint>(workKey,latestStep.encryptedOutput):{};
        const output={...(result.output as Record<string,unknown>??{}),...(latest.localRecovery?{localRecovery:latest.localRecovery}:{}),
          ...(latest.responseRecovery?{responseRecovery:latest.responseRecovery}:{}),
          ...(latest.responseReceipt?{responseReceipt:latest.responseReceipt}:{}),...(latest.responseCheckpoint?{responseCheckpoint:latest.responseCheckpoint,responseProcessingAttempts:latest.responseProcessingAttempts}:{})};
        await tx.update(steps).set({status:"completed",encryptedOutput:seal(workKey,output),outputAssetId:result.outputAssetId??null,outputVersionId:versionId,completedAt:new Date(),updatedAt:new Date()}).where(eq(steps.id,step.id));
        const blocked=result.qualityDiagnostics?.some(issue=>issue.severity==="error");
        const finished=input.tool==="review_required";
        const costEvidence=await readPaidCostEvidence(tx,run.id,snapshot.plan.plannedModelCalls);
        const completion=finished&&!blocked?await sealOrderDesignCompletion(tx,{...current,currentEditorVersionId:versionId},snapshot,workKey,projectKey,result.qualityDiagnostics??current.qualityDiagnostics):null;
        await tx.update(runs).set({currentEditorVersionId:versionId,...(result.qualityDiagnostics?{qualityDiagnostics:result.qualityDiagnostics}:{}),
          ...(completion?{completionEvidence:completion.evidence,completionChecksum:completion.checksum}:{}),
          ...(snapshot.plan.plannedModelCalls?costEvidence:{}),
          ...(blocked?{status:"needs_attention",errorCode:"agent_quality_failed",processingToken:null,leaseUntil:null}:finished?{status:"awaiting_review",processingToken:null,leaseUntil:null}:{}),updatedAt:new Date()}).where(eq(runs.id,run.id));
      } finally {projectKey.fill(0);workKey.fill(0);}
    });
  }
  private workKey(encrypted:string) {return this.vault.withSecret(encrypted,value=>Buffer.from(value,"base64"));}
}

async function reserveModelBudget(tx:TenantTransaction,context:TenantContext,run:DesignRun,step:DesignStep,snapshot:OrderDesignSnapshot) {
  if(!snapshot.plan.budget.allowed || !snapshot.model || !snapshot.recipe.allowOrderImageTransfer || snapshot.plan.budget.estimatedCostPerCallUsd===null) throw new OrderDesignError("agent_model_budget_unavailable");
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:ai-assist-budget`},0))`);
  const [previous]=await tx.select().from(aiBudgetLedger).where(and(eq(aiBudgetLedger.requestId,step.requestId),inArray(aiBudgetLedger.state,["reserved","committed"]))).limit(1);
  if(previous) throw new OrderDesignError("agent_model_submission_unknown",true);
  const [policy]=await tx.select().from(aiBudgetPolicies);
  const unit=snapshot.plan.budget.estimatedCostPerCallUsd;
  const budgetAmount=orderModelBudgetAmount(unit),unitMicros=budgetMicros(budgetAmount);
  const [spent]=await tx.select({amount:sql<string>`coalesce(sum(${aiBudgetLedger.amountUsd}),0)`}).from(aiBudgetLedger).innerJoin(steps,eq(steps.requestId,aiBudgetLedger.requestId)).where(and(eq(steps.runId,run.id),inArray(aiBudgetLedger.state,["reserved","committed"])));
  const originalCap=snapshot.recipe.maxEstimatedCostUsd;
  if(originalCap===null||budgetMicros(spent?.amount??"0")+unitMicros>budgetMicros(orderModelBudgetAmount(originalCap)))throw new OrderDesignError("agent_model_original_budget_exceeded");
  if(policy) {
    const cap=policy.taskCapsUsd.order_design??Number(policy.defaultTaskCapUsd);
    if(snapshot.plan.budget.estimatedCostUsd===null || budgetMicros(orderModelBudgetAmount(snapshot.plan.budget.estimatedCostUsd))>budgetMicros(orderModelBudgetAmount(cap))||budgetMicros(spent?.amount??"0")+unitMicros>budgetMicros(orderModelBudgetAmount(cap)))throw new OrderDesignError("agent_model_task_budget_exceeded");
    const month=new Date();month.setUTCDate(1);month.setUTCHours(0,0,0,0);
    const [total]=await tx.select({amount:sql<string>`coalesce(sum(${aiBudgetLedger.amountUsd}),0)`}).from(aiBudgetLedger).where(and(gte(aiBudgetLedger.createdAt,month),inArray(aiBudgetLedger.state,["reserved","committed"])));
    if(budgetMicros(total?.amount??"0")+unitMicros>budgetMicros(policy.monthlyCapUsd)) throw new OrderDesignError("agent_model_monthly_budget_exceeded");
  }
  await tx.insert(aiBudgetLedger).values({id:createEntityId(),tenantId:context.tenantId,requestId:step.requestId,taskType:"order_design",modelKey:snapshot.model.model,provider:snapshot.model.providerConfigId,amountUsd:budgetAmount,state:"reserved"});
  void run;
}
function safeCode(error:unknown) {return error instanceof OrderDesignError && /^agent_[a-z0-9_]{1,100}$/.test(error.code)?error.code:"agent_execution_failed";}
function budgetMicros(value:string){if(!/^\d+(?:\.\d{1,6})?$/.test(value))throw new OrderDesignError("agent_model_budget_unavailable");const [whole,fraction=""]=value.split(".");return BigInt(whole!)*1_000_000n+BigInt(fraction.padEnd(6,"0"));}
async function readPaidCostEvidence(tx:TenantTransaction,runId:string,plannedModelCalls:number) {
  return readOrderModelCostProjection(tx,runId,plannedModelCalls);
}
function validResponseCheckpoint(value:OrderDesignResponseCheckpoint,step:DesignStep,context:TenantContext) {
  const parts=typeof value.objectKey==="string"?value.objectKey.split("/"):[];
  return value.version===1 && value.quarantined===true && value.requestId===step.requestId
    && /^[a-f0-9]{64}$/.test(value.checksum) && Number.isSafeInteger(value.byteSize) && value.byteSize>0 && value.byteSize<=64*1024*1024
    && Number.isFinite(Date.parse(value.receivedAt)) && (value.actualCostUsd===undefined || Number.isFinite(value.actualCostUsd) && value.actualCostUsd>=0 && value.actualCostUsd<=1_000_000)
    && parts.length===5 && parts[0]==="tenants" && parts[1]===context.tenantId && parts[2]==="order"
    && /^[a-f0-9]{64}$/.test(parts[3]!) && parts[4]===`${step.requestId}-response-quarantine.pe`;
}
