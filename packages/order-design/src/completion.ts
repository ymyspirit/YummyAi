import { harnessChecksum } from "@yummyai/ai-core";
import { OrderDesignCompletionV1Schema, OrderDesignCompletionRecordSchema, type OrderDesignCompletionRecord, type OrderDesignMethodSnapshot } from "@yummyai/contracts/order/design-harness";
import { DesignAutomationPlanSchema } from "@yummyai/contracts/pod/design-automation";
import { orderDesignAgentSteps as steps, productionEditorRenders as renders, productionEditorVersions as versions, type TenantTransaction } from "@yummyai/database";
import { asc,eq,inArray,and } from "drizzle-orm";
import { orderDesignHarness,orderDesignInputChecksum } from "./harness.js";
import { fingerprint,open } from "./crypto.js";
import type { DesignRun } from "./repository.js";
import type { StepResult } from "./executor.js";
import { OrderDesignError,type OrderDesignSnapshot,type OrderDesignStepCheckpoint } from "./types.js";

export async function sealOrderDesignCompletion(tx:TenantTransaction,run:DesignRun,snapshot:OrderDesignSnapshot,workKey:Uint8Array,projectKey:Uint8Array,quality:DesignRun["qualityDiagnostics"]):Promise<OrderDesignCompletionRecord|null>{
  if(!run.methodSnapshot)return null;
  const plan=DesignAutomationPlanSchema.parse(snapshot.plan);
  const rows=await tx.select().from(steps).where(eq(steps.runId,run.id)).orderBy(asc(steps.position));
  if(rows.length!==plan.steps.length || rows.some((step,index)=>step.status!=="completed" || step.key!==plan.steps[index]!.id || step.inputChecksum!==fingerprint(plan.steps[index])))invalid();
  const proofIds=rows.filter(step=>snapshot.plan.steps.find(input=>input.id===step.key)?.tool==="render_proof").map(step=>step.requestId);
  if(!proofIds.length)invalid();
  const proofs=await tx.select().from(renders).where(and(eq(renders.projectId,run.projectId!),eq(renders.versionId,run.currentEditorVersionId!),inArray(renders.id,proofIds))).orderBy(asc(renders.id)).for("share");
  if(proofs.length!==proofIds.length || proofs.some(proof=>proof.status!=="completed"||!proof.encryptedManifest))invalid();
  const [version]=await tx.select().from(versions).where(and(eq(versions.projectId,run.projectId!),eq(versions.id,run.currentEditorVersionId!)));
  if(!version)invalid();
  const raw={contractVersion:"order-design-completion-v1",runId:run.id,workItemId:run.workItemId,workRevisionId:run.workRevisionId,
    inputChecksum:run.inputChecksum,methodContractChecksum:run.methodSnapshot.executionContract.checksum,
    projectId:run.projectId,editorVersionId:run.currentEditorVersionId,documentChecksum:version.checksum,
    templateVersionId:snapshot.templateVersionId,templateChecksum:snapshot.templateChecksum,
    ruleSnapshotChecksum:snapshot.ruleSnapshot?harnessChecksum(snapshot.ruleSnapshot):null,qualityCheckChecksum:harnessChecksum(quality),resultState:"awaiting_review",
    steps:rows.map(step=>{
      const output=step.encryptedOutput?open<OrderDesignStepCheckpoint>(workKey,step.encryptedOutput):{};
      const tool=snapshot.plan.steps.find(input=>input.id===step.key)!.tool;
      if((tool==="enhance_image"||tool==="cutout_subject")&&(!output.responseReceipt||output.responseReceipt.requestId!==step.requestId||!output.responseReceipt.quarantined))invalid();
      return {id:step.id,key:step.key,requestId:step.requestId,inputChecksum:step.inputChecksum,outputAssetId:step.outputAssetId,outputVersionId:step.outputVersionId,responseChecksum:output.responseReceipt?.checksum??null};
    }),
    proofs:proofs.map(proof=>{
      const manifest=open<NonNullable<StepResult["proof"]>>(projectKey,proof.encryptedManifest!);
      return {renderId:proof.id,versionId:proof.versionId,manifestChecksum:fingerprint(proof.encryptedManifest!),files:manifest.files.map(file=>({key:file.key,mediaType:file.mediaType,byteSize:file.byteSize,checksumSha256:file.checksumSha256}))};
    }),requiresBusinessReview:true,automaticProductionApproval:false};
  return sealOrderDesignEvidence(snapshot,run.methodSnapshot,raw);
}

export function sealOrderDesignEvidence(snapshot:OrderDesignSnapshot,method:OrderDesignMethodSnapshot,raw:unknown):OrderDesignCompletionRecord{
  const parsed=OrderDesignCompletionV1Schema.safeParse(raw);if(!parsed.success)invalid();
  const evidence=parsed.data;
  if(evidence.methodContractChecksum!==method.executionContract.checksum || evidence.inputChecksum!==orderDesignInputChecksum(snapshot,method)
    || evidence.workItemId!==snapshot.workItemId || evidence.workRevisionId!==snapshot.workRevisionId
    || evidence.templateVersionId!==snapshot.templateVersionId || evidence.templateChecksum!==snapshot.templateChecksum)invalid();
  const binding=orderDesignHarness(snapshot.recipe.workflow);
  binding.registry.checkOutput(method.executionContract,binding.skill,binding.toolKey,evidence);
  return {evidence,checksum:harnessChecksum(evidence)};
}

export function readOrderDesignCompletion(run:DesignRun,snapshot:OrderDesignSnapshot):OrderDesignCompletionRecord|null{
  if(run.completionEvidence===null&&run.completionChecksum===null){if(run.methodSnapshot&&run.status==="awaiting_review")invalid();return null;}
  const parsed=OrderDesignCompletionRecordSchema.safeParse({evidence:run.completionEvidence,checksum:run.completionChecksum});if(!parsed.success)invalid();
  const {evidence,checksum}=parsed.data;
  if(harnessChecksum(evidence)!==checksum || evidence.runId!==run.id || evidence.workItemId!==run.workItemId || evidence.workRevisionId!==run.workRevisionId
    || evidence.inputChecksum!==run.inputChecksum || evidence.methodContractChecksum!==run.methodSnapshot?.executionContract.checksum
    || evidence.projectId!==run.projectId || evidence.editorVersionId!==run.currentEditorVersionId
    || evidence.templateVersionId!==snapshot.templateVersionId || evidence.templateChecksum!==snapshot.templateChecksum
    || evidence.ruleSnapshotChecksum!==(snapshot.ruleSnapshot?harnessChecksum(snapshot.ruleSnapshot):null))invalid();
  return parsed.data;
}
function invalid():never{throw new OrderDesignError("agent_completion_invalid");}
