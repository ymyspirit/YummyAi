import { z } from "zod";
import { HarnessExecutionContractSchema } from "@yummyai/contracts/harness";
import { AgentMethodSelectionSchema } from "@yummyai/contracts/harness/methods";
import { DesignAutomationPlanSchema, DesignAutomationRecipeSchema } from "@yummyai/contracts/pod/design-automation";
import { ModelTokenUsageSchema } from "@yummyai/contracts/ai/model-usage";

const Id=z.uuidv7(), Hash=z.string().regex(/^[a-f0-9]{64}$/);
export const OrderDesignMethodSnapshotSchema=z.object({
  schemaVersion:z.literal("order-design-method-snapshot-v1"),
  executionContract:HarnessExecutionContractSchema,
  methodSelection:AgentMethodSelectionSchema,
}).strict().superRefine((value,context)=>{
  if(value.executionContract.executorKey!=="order_design" || value.methodSelection.methodKey!==value.executionContract.skill.key
    || value.methodSelection.contractChecksum!==value.executionContract.checksum)
    context.addIssue({code:"custom",message:"Order design method must bind its original owner and code contract"});
});
export type OrderDesignMethodSnapshot=z.infer<typeof OrderDesignMethodSnapshotSchema>;

/** Bounded business pins only. Full order text and image bytes remain encrypted in their owner. */
export const OrderDesignHarnessInputSchema=z.object({
  workItemId:Id,workRevisionId:Id,sourceVersionId:Id.nullable(),
  templateVersionId:Id,templateChecksum:Hash,businessSnapshotChecksum:Hash,
  workflow:z.enum(["template","pillow_photo"]),recipe:DesignAutomationRecipeSchema,plan:DesignAutomationPlanSchema,
}).strict().superRefine((value,context)=>{
  if(value.workflow!==value.recipe.workflow || JSON.stringify(value.recipe)!==JSON.stringify(value.plan.recipe))
    context.addIssue({code:"custom",message:"Order design recipe and original plan must agree"});
});

export const OrderDesignCompletionV1Schema=z.object({
  contractVersion:z.literal("order-design-completion-v1"),runId:Id,workItemId:Id,workRevisionId:Id,
  inputChecksum:Hash,methodContractChecksum:Hash,projectId:Id,editorVersionId:Id,documentChecksum:Hash,
  templateVersionId:Id,templateChecksum:Hash,ruleSnapshotChecksum:Hash.nullable(),qualityCheckChecksum:Hash,
  resultState:z.literal("awaiting_review"),
  steps:z.array(z.object({id:Id,key:z.string().min(1).max(160),requestId:Id,inputChecksum:Hash,
    outputAssetId:Id.nullable(),outputVersionId:Id.nullable(),responseChecksum:Hash.nullable()}).strict()).min(1).max(108),
  proofs:z.array(z.object({renderId:Id,versionId:Id,manifestChecksum:Hash,
    files:z.array(z.object({key:z.string().min(1).max(160),mediaType:z.enum(["image/png","image/jpeg"]),byteSize:z.int().positive(),checksumSha256:Hash}).strict()).min(1).max(16),
  }).strict()).min(1).max(16),
  requiresBusinessReview:z.literal(true),automaticProductionApproval:z.literal(false),
}).strict().superRefine((value,context)=>{
  if(new Set(value.steps.map(step=>step.id)).size!==value.steps.length || new Set(value.proofs.map(proof=>proof.renderId)).size!==value.proofs.length
    || value.proofs.some(proof=>proof.versionId!==value.editorVersionId || new Set(proof.files.map(file=>file.key)).size!==proof.files.length))
    context.addIssue({code:"custom",message:"Order completion requires unique original steps and proofs of the handed-off version"});
});
export type OrderDesignCompletionV1=z.infer<typeof OrderDesignCompletionV1Schema>;
export const OrderDesignCompletionRecordSchema=z.object({evidence:OrderDesignCompletionV1Schema,checksum:Hash}).strict();
export type OrderDesignCompletionRecord=z.infer<typeof OrderDesignCompletionRecordSchema>;

/** Read-only fee metadata; excludes claim tokens, images, prompts and storage keys. */
export const OrderDesignModelCallViewSchema=z.object({
 id:Id,stepId:Id,requestId:Id,attempt:z.int().positive(),
 submittedAt:z.iso.datetime(),receivedAt:z.iso.datetime().nullable(),
 costReportState:z.enum(["pending","unknown","reported","invalid"]),
 tokenUsage:ModelTokenUsageSchema.nullable().optional(),
 reportedCostUsd:z.string().regex(/^\d+\.\d{8}$/).nullable(),
 budgetState:z.enum(["reserved","committed","released"]),budgetAmountUsd:z.string().regex(/^\d+\.\d{6}$/),
}).strict().superRefine((value,context)=>{
 if((value.costReportState==="reported")!==(value.reportedCostUsd!==null))context.addIssue({code:"custom",message:"Reported cost must retain its amount"});
 if((value.costReportState==="pending")!==(value.receivedAt===null))context.addIssue({code:"custom",message:"Response state must match its recorded receipt time"});
});
