import { authorize, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { OrderDesignReviseCandidateSchema, type OrderDesignReviseCandidate } from "@yummyai/contracts/order/design-agent";
import type { SecretVault } from "@yummyai/ai-core";
import { orderDesignAgentRuns as runs,orderDesignAgentSteps as steps,orderDesignAgentCommands as commands,orderDesignAgentOutbox as outbox,
  orderWorkItems as works,productionEditorProjects as projects,productionEditorImages as images,
  orderLines,orders,withTenant,type DatabaseConnection,type TenantTransaction } from "@yummyai/database";
import { ClamAvScanner,objectKey as privateObjectKey,type Storage } from "@yummyai/storage";
import { encryptProductionBytes,decryptProductionBytes } from "@yummyai/production-editor";
import { and,eq,sql } from "drizzle-orm";
import sharp from "sharp";
import { fingerprint,open,seal } from "./crypto.js";
import { assertExecutionIdentity,assertOrderDesignRevisionSource,executionPermissions,lockWork } from "./repository.js";
import { selectOrderDesignMethod,orderDesignInputChecksum } from "./harness.js";
import { buildOrderDesignRevisionPlan,selectOrderDesignRevisionSubject } from "./revision-plan.js";
import { OrderDesignError,type OrderDesignSnapshot,type OrderDesignRevisionFeedbackImage,type OrderDesignRevisionRequest,type OrderDesignRevisionBaseProof,type OrderDesignRevisionProofLocator } from "./types.js";

/** Explicit review decision. The original run, response receipts and versions are retained. */
export class OrderDesignRevisionService {
  constructor(private readonly database:DatabaseConnection,private readonly vault:SecretVault,private readonly storage:Storage,
    private readonly scanner:Pick<ClamAvScanner,"scan">=new ClamAvScanner()){}

  async revise(context:TenantContext,workItemId:string,raw:unknown):Promise<{runId:string}> {
    for(const permission of [...executionPermissions,Permission.DesignReview])authorize(context,permission);
    const input=OrderDesignReviseCandidateSchema.parse(raw);
    const descriptors=input.attachments.map(file=>{
      const bytes=Buffer.from(file.contentBase64,"base64");
      try {
        if(!bytes.length||bytes.toString("base64")!==file.contentBase64)throw new OrderDesignError("agent_revision_attachment_invalid");
        return {name:file.name,checksum:fingerprint(bytes),byteSize:bytes.length};
      }finally{bytes.fill(0);}
    });
    const digest=fingerprint({...input,attachments:descriptors});
    const prepared=await withTenant(this.database.db,context,tx=>this.prepare(tx,context,workItemId,input,digest));
    if("replayRunId" in prepared)return {runId:prepared.replayRunId!};
    const feedbackImages:OrderDesignRevisionFeedbackImage[]=[];
    const childRunId=createEntityId();
    let committed=false;
    const projectKey=this.key(prepared.project.encryptedDataKey!),workKey=this.key(prepared.work.encryptedDataKey!);
    try {
      const seenProofFiles=new Map<string,{checksum:string;byteSize:number;mediaType:string}>();
      const sourceProofs:OrderDesignRevisionBaseProof[]=[];
      for(const proof of prepared.sourceProofs)sourceProofs.push(await this.verifyBaseProof(context,proof,projectKey,"agent_revision_source_proof_unavailable",seenProofFiles));
      const baseProof=await this.verifyBaseProof(context,prepared.proof,projectKey,"agent_revision_current_proof_unavailable",seenProofFiles);
      for(const [index,file] of input.attachments.entries()) {
        const bytes=Buffer.from(file.contentBase64,"base64");
        try {
          const info=await sharp(bytes,{limitInputPixels:40_000_000,failOn:"warning"}).metadata().catch(()=>{throw new OrderDesignError("agent_revision_attachment_invalid");});
          if(!info.width||!info.height||(info.pages??1)!==1||!["png","jpeg","webp"].includes(info.format??""))throw new OrderDesignError("agent_revision_attachment_invalid");
          const mediaType=(info.format==="jpeg"?"image/jpeg":info.format==="webp"?"image/webp":"image/png") as OrderDesignRevisionFeedbackImage["mediaType"];
          if(!(info.format==="jpeg"?/\.jpe?g$/i:new RegExp(`\\.${info.format}$`,"i")).test(file.name))throw new OrderDesignError("agent_revision_attachment_invalid");
          const scan=await this.scanner.scan({body:bytes,fileName:file.name,mediaType}).catch(()=>{throw new OrderDesignError("agent_scan_unavailable");});
          if(scan.result!=="clean"||scan.signatureVersion==="unavailable")throw new OrderDesignError(scan.result==="infected"?"agent_scan_rejected":"agent_scan_unavailable");
          const id=createEntityId(),encrypted=encryptProductionBytes(projectKey,bytes),fileName=`${id}-revision-feedback.pe`;
          const objectKey=privateObjectKey({tenantId:context.tenantId,domain:"order",sha256:fingerprint(encrypted),fileName});
          const pin:OrderDesignRevisionFeedbackImage={id,name:file.name,objectKey,mediaType,byteSize:bytes.length,checksum:descriptors[index]!.checksum,purpose:"operator_revision_feedback"};
          // Record the exact owned key before I/O, including a lost S3 acknowledgement.
          feedbackImages.push(pin);
          const stored=await this.storage.putPrivate(context,{body:encrypted,domain:"order",fileName,mediaType:"application/octet-stream"})
            .catch(()=>{throw new OrderDesignError("agent_revision_feedback_storage_unavailable");});
          if(stored.objectKey!==objectKey)throw new OrderDesignError("agent_revision_feedback_storage_unavailable");
        }finally{bytes.fill(0);}
      }
      const result=await withTenant(this.database.db,context,async tx=>{
        const current=await this.prepare(tx,context,workItemId,input,digest);
        if("replayRunId" in current)return {runId:current.replayRunId!};
        if(current.work.encryptedDataKey!==prepared.work.encryptedDataKey||current.project.encryptedDataKey!==prepared.project.encryptedDataKey
          ||current.version.checksum!==prepared.version.checksum||fingerprint(current.proof)!==fingerprint(prepared.proof)
          ||fingerprint(current.sourceProofs)!==fingerprint(prepared.sourceProofs)
          ||current.source!==prepared.source||current.submittedEventId!==prepared.submittedEventId)throw new OrderDesignError("agent_revision_changed");
        const revisionRequest:OrderDesignRevisionRequest={requestId:input.idempotencyKey,parentRunId:current.run.id,baseProjectId:current.project.id,
          source:current.source,baseProof,sourceProofs,...(current.submittedEventId?{submittedEventId:current.submittedEventId}:{}),
          baseVersionId:current.version.id,baseDocumentChecksum:current.version.checksum,...current.subject,reason:input.reason,mode:input.mode,
          ...(input.contourRoundingPx!==undefined?{contourRoundingPx:input.contourRoundingPx}:{}),feedbackImages};
        const snapshot:OrderDesignSnapshot={...current.snapshot,document:current.document,plan:current.plan,revisionRequest};
        const methodSnapshot=await selectOrderDesignMethod(tx,context,snapshot);
        await tx.insert(runs).values({id:childRunId,tenantId:context.tenantId,parentRunId:current.run.id,workItemId,workRevisionId:current.run.workRevisionId,
          status:"queued",executorKey:"strict-pillow_photo.revision",recipeVersion:current.run.recipeVersion,policyVersion:"order-design-candidate-revision-v1",
          modelRouteId:snapshot.model?.routeId??null,encryptedSnapshot:seal(workKey,snapshot),inputChecksum:orderDesignInputChecksum(snapshot,methodSnapshot),methodSnapshot,
          revisionFeedbackObjects:feedbackImages.map(({id,objectKey})=>({id,objectKey})),
          projectId:current.project.id,currentEditorVersionId:current.version.id,requestedBy:context.userId,
          estimatedCostUsd:current.plan.budget.estimatedCostUsd===null?null:String(current.plan.budget.estimatedCostUsd),
          actualCostUsd:current.plan.plannedModelCalls?null:"0",costStatus:current.plan.plannedModelCalls?(current.plan.budget.estimatedCostUsd===null?"unknown":"estimated"):"not_required"});
        for(const [position,step] of current.plan.steps.entries())await tx.insert(steps).values({id:createEntityId(),tenantId:context.tenantId,runId:childRunId,
          key:step.id,label:({revise_image:"按运营反馈修改主体图",reuse_revision_subject:"保留原图仅修裁线",measure_subject:"核对主体尺寸",ensure_resolution:"检查并补强像素",optimize_contour:"更新独立裁线",preflight:"质量检查",render_proof:"生成新版本校样",review_required:"返回运营审核"} as Record<string,string>)[step.tool]!,
          position,requestId:createEntityId(),encryptedInput:seal(workKey,step),inputChecksum:fingerprint(step)});
        await tx.update(runs).set({status:"cancelled",revision:current.run.revision+1,errorCode:"agent_revision_requested",processingToken:null,leaseUntil:null,updatedAt:new Date()}).where(eq(runs.id,current.run.id));
        await tx.update(projects).set({reviewedVersionId:null,reviewedBy:null,reviewedAt:null,updatedAt:new Date()}).where(eq(projects.id,current.project.id));
        await tx.update(works).set({artwork:"in_progress",approvedEditorVersionId:null,proof:current.snapshot.draft.customerApprovalRequired?"pending":"not_required",
          proofEditorVersionId:null,projectionVersion:sql`${works.projectionVersion}+1`,updatedAt:new Date()}).where(eq(works.id,workItemId));
        await tx.insert(commands).values({id:createEntityId(),tenantId:context.tenantId,runId:current.run.id,idempotencyKey:input.idempotencyKey,
          action:"revise",requestChecksum:digest,requestedBy:context.userId});
        await tx.insert(outbox).values({id:createEntityId(),tenantId:context.tenantId,runId:childRunId,requestedBy:context.userId});
        return {runId:childRunId};
      });
      committed=result.runId===childRunId;
      return result;
    }finally{
      projectKey.fill(0);
      try {
        if(!committed)for(const pin of feedbackImages)await this.discardUnreferenced(context,workItemId,input.runId,pin,workKey);
      }finally{workKey.fill(0);}
    }
  }

  async attachment(context:TenantContext,workItemId:string,runId:string,attachmentId:string) {
    for(const permission of [...executionPermissions,Permission.DesignReview])authorize(context,permission);
    const load=()=>withTenant(this.database.db,context,async tx=>{
      await assertExecutionIdentity(tx,context,[Permission.DesignReview]);
      const [source]=await tx.select({work:works,order:orders}).from(works).innerJoin(orderLines,eq(orderLines.id,works.id)).innerJoin(orders,eq(orders.id,orderLines.orderId)).where(eq(works.id,workItemId));
      const work=source?.work;
      const [run]=await tx.select().from(runs).where(and(eq(runs.id,runId),eq(runs.workItemId,workItemId)));
      if(!work?.encryptedDataKey||work.expiresAt<=new Date()||source?.order.addressStatus==="anonymized"||!run)throw new OrderDesignError("agent_revision_feedback_not_found");
      const key=this.key(work.encryptedDataKey);
      try{
        const snapshot=open<OrderDesignSnapshot>(key,run.encryptedSnapshot);
        if(orderDesignInputChecksum(snapshot,run.methodSnapshot)!==run.inputChecksum)throw new OrderDesignError("agent_snapshot_invalid");
        const pin=snapshot.revisionRequest?.feedbackImages.find(item=>item.id===attachmentId&&item.purpose==="operator_revision_feedback");
        const [project]=await tx.select().from(projects).where(and(eq(projects.id,snapshot.revisionRequest?.baseProjectId??run.projectId!),eq(projects.sourceWorkItemId,workItemId)));
        if(!pin||!project?.encryptedDataKey||project.status!=="active"||project.expiresAt&&project.expiresAt<=new Date())throw new OrderDesignError("agent_revision_feedback_not_found");
        return {pin,projectKey:project.encryptedDataKey,workKey:work.encryptedDataKey};
      }finally{key.fill(0);}
    });
    const prepared=await load();
    const key=this.key(prepared.projectKey);
    let bytes:Buffer|undefined;
    try{
      bytes=decryptProductionBytes(key,await this.storage.readPrivate(context,{id:attachmentId,tenantId:context.tenantId,assetDomain:"order",objectKey:prepared.pin.objectKey},{requiredDomain:"order"}));
      if(bytes.length!==prepared.pin.byteSize||fingerprint(bytes)!==prepared.pin.checksum)throw new OrderDesignError("agent_revision_feedback_checksum_invalid");
      const current=await load();
      if(current.projectKey!==prepared.projectKey||current.workKey!==prepared.workKey||current.pin.objectKey!==prepared.pin.objectKey)throw new OrderDesignError("agent_revision_feedback_not_found");
      const result={bytes,mediaType:prepared.pin.mediaType,name:prepared.pin.name};bytes=undefined;return result;
    }finally{key.fill(0);bytes?.fill(0);}
  }

  private async prepare(tx:TenantTransaction,context:TenantContext,workItemId:string,input:OrderDesignReviseCandidate,digest:string) {
    await lockWork(tx,workItemId);
    await assertExecutionIdentity(tx,context,[Permission.DesignReview]);
    const [run]=await tx.select().from(runs).where(and(eq(runs.id,input.runId),eq(runs.workItemId,workItemId))).for("update");
    if(!run)throw new OrderDesignError("agent_run_not_found");
    const [prior]=await tx.select().from(commands).where(and(eq(commands.runId,run.id),eq(commands.idempotencyKey,input.idempotencyKey)));
    if(prior){
      if(prior.action!=="revise"||prior.requestChecksum!==digest)throw new OrderDesignError("agent_command_conflict");
      const [child]=await tx.select({id:runs.id}).from(runs).where(eq(runs.parentRunId,run.id));
      if(!child)throw new OrderDesignError("agent_revision_changed");
      return {replayRunId:child.id} as const;
    }
    if(run.revision!==input.expectedRevision)throw new OrderDesignError("agent_revision_changed");
    const [child]=await tx.select({id:runs.id}).from(runs).where(eq(runs.parentRunId,run.id));
    if(child)throw new OrderDesignError("agent_revision_already_requested");
    const basis=await assertOrderDesignRevisionSource(tx,context,run,this.vault,input.expectedEditorVersionId);
    const {project,snapshot,document}=basis;
    const projectKey=this.key(project.encryptedDataKey!);
    try{
      const rows=await tx.select().from(images).where(eq(images.projectId,project.id));
      const subject=selectOrderDesignRevisionSubject(document,rows.map(asset=>({id:asset.id,checksum:asset.checksum,
        metadata:open<{kind:string;actualAlpha:boolean;buyerOriginal?:boolean}>(projectKey,asset.encryptedMetadata)})));
      const plan=buildOrderDesignRevisionPlan(snapshot,subject.targetImageId,input.mode);
      if(plan.status!=="ready")throw new OrderDesignError("agent_revision_budget_unavailable");
      return {...basis,subject,plan};
    }finally{projectKey.fill(0);}
  }

  private async verifyBaseProof(context:TenantContext,proof:OrderDesignRevisionProofLocator,projectKey:Buffer,errorCode:string,
    seen:Map<string,{checksum:string;byteSize:number;mediaType:string}>):Promise<OrderDesignRevisionBaseProof>{
    const files:OrderDesignRevisionBaseProof["files"]=[];
    for(const file of proof.files){
      const prior=seen.get(file.objectKey);
      if(prior){
        if(prior.byteSize!==file.byteSize||prior.mediaType!==file.mediaType||file.checksumSha256!==undefined&&prior.checksum!==file.checksumSha256)throw new OrderDesignError(errorCode);
        files.push({...file,checksumSha256:prior.checksum});continue;
      }
      let encrypted:Buffer|undefined,bytes:Buffer|undefined;
      try{
        const parts=file.objectKey.split("/");
        if(parts.length!==5||parts[0]!=="tenants"||parts[1]!==context.tenantId||parts[2]!=="order"||!/^[a-f0-9]{64}$/.test(parts[3]!)
          ||file.objectKey!==privateObjectKey({tenantId:context.tenantId,domain:"order",sha256:parts[3]!,fileName:parts[4]!}))throw new OrderDesignError(errorCode);
        encrypted=Buffer.from(await this.storage.readPrivate(context,{id:proof.renderId,tenantId:context.tenantId,assetDomain:"order",objectKey:file.objectKey},{requiredDomain:"order",maxBytes:file.byteSize+32}));
        if(fingerprint(encrypted)!==parts[3])throw new OrderDesignError(errorCode);
        bytes=decryptProductionBytes(projectKey,encrypted);
        const checksumSha256=fingerprint(bytes);
        if(bytes.length!==file.byteSize||file.checksumSha256!==undefined&&checksumSha256!==file.checksumSha256)throw new OrderDesignError(errorCode);
        const metadata=await sharp(bytes,{limitInputPixels:100_000_000,failOn:"warning"}).metadata();
        const mediaType=metadata.format==="jpeg"?"image/jpeg":metadata.format==="png"?"image/png":metadata.format==="webp"?"image/webp":null;
        if(!metadata.width||!metadata.height||(metadata.pages??1)!==1||mediaType!==file.mediaType)throw new OrderDesignError(errorCode);
        seen.set(file.objectKey,{checksum:checksumSha256,byteSize:file.byteSize,mediaType:file.mediaType});
        files.push({...file,checksumSha256});
      }catch{throw new OrderDesignError(errorCode);}
      finally{bytes?.fill(0);encrypted?.fill(0);}
    }
    return {...proof,files};
  }

  private async discardUnreferenced(context:TenantContext,workItemId:string,parentRunId:string,pin:OrderDesignRevisionFeedbackImage,workKey:Buffer) {
    return withTenant(this.database.db,context,async tx=>{
      await lockWork(tx,workItemId);
      const referenced=async()=>{
        const [child]=await tx.select().from(runs).where(and(eq(runs.parentRunId,parentRunId),eq(runs.workItemId,workItemId)));
        if(!child)return false;
        return !!open<OrderDesignSnapshot>(workKey,child.encryptedSnapshot).revisionRequest?.feedbackImages.some(item=>item.id===pin.id&&item.objectKey===pin.objectKey);
      };
      if(await referenced())return;
      await this.storage.discardOrderDesignFeedback(context,pin.id,pin.objectKey,{assertCurrent:async()=>{if(await referenced())throw new OrderDesignError("agent_revision_feedback_referenced");}});
    }).catch(()=>{throw new OrderDesignError("agent_revision_feedback_cleanup_pending");});
  }
  private key(encrypted:string){return this.vault.withSecret(encrypted,value=>Buffer.from(value,"base64"));}
}
