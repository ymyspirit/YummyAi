import { z } from "zod";
import { PodExecutableToolKeySchema } from "@yummyai/contracts/pod/tool-keys";
import { PodProcessorMediaTypeSchema } from "@yummyai/contracts/pod/processor-result";

const Id = z.uuidv7(), Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const PodCompletionStateSchema = z.enum(["awaiting_review", "partially_succeeded", "blocked"]);
export const PodCompletionV1Schema = z.object({
  contractVersion: z.literal("pod-completion-v1"),
  taskId: Id,
  designTaskId: Id,
  toolKey: PodExecutableToolKeySchema,
  inputFingerprint: Hash,
  methodContractChecksum: Hash.nullable(),
  methodValidation: z.enum(["native_completion", "legacy_owner_view", "legacy_missing"]),
  responseChecksum: Hash,
  decodedWith: z.literal("pod-processor-result-v1"),
  resultVersionId: Id,
  resultState: PodCompletionStateSchema,
  qualityCheckChecksum: Hash,
  outputs: z.array(z.object({
    ordinal: z.int().min(0).max(99),
    assetId: Id,
    assetVersion: z.int().positive(),
    checksumSha256: Hash,
    byteSize: z.int().positive(),
    mediaType: PodProcessorMediaTypeSchema,
    role: z.enum(["effect", "production"]),
  }).strict()).min(1).max(100),
  requiresBusinessReview: z.literal(true),
  automaticProductionApproval: z.literal(false),
}).strict().superRefine((value, context) => {
  if ((value.methodValidation === "legacy_missing") !== (value.methodContractChecksum === null))
    context.addIssue({ code: "custom", path: ["methodValidation"], message: "Completion must retain its original method-presence boundary" });
  if (value.outputs.some((output, index) => output.ordinal !== index) || new Set(value.outputs.map(output => output.assetId)).size !== value.outputs.length)
    context.addIssue({ code: "custom", path: ["outputs"], message: "Completion outputs require unique original assets and contiguous order" });
});
export type PodCompletionV1 = z.infer<typeof PodCompletionV1Schema>;
export const PodCompletionRecordSchema = z.object({ evidence: PodCompletionV1Schema, checksum: Hash }).strict();
export type PodCompletionRecord = z.infer<typeof PodCompletionRecordSchema>;
