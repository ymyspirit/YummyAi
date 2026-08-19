import { z } from "zod";

import { EntityIdSchema } from "../common/ids.js";

export const DesignTaskStatusSchema = z.enum(["open", "in_review", "approved", "archived"]);
export const DesignVersionStatusSchema = z.enum(["pending_review", "approved", "rejected"]);
export const DesignFileRoleSchema = z.enum(["source", "effect", "production"]);

export const RightsSourceSchema = z.object({
  kind: z.enum(["owned", "licensed", "commissioned", "ai_generated", "customer_provided", "competitor"]),
  reference: z.string().min(1).max(500),
  licenseExpiresAt: z.iso.datetime().optional(),
});

export const CreateDesignTaskInputSchema = z.object({
  skuId: EntityIdSchema,
  title: z.string().min(1).max(200),
  brief: z.string().min(1).max(8_000),
  dueAt: z.iso.datetime().optional(),
});

export const UploadDesignVersionInputSchema = z.object({
  changeNote: z.string().max(2_000).optional(),
  files: z.array(z.object({ assetId: EntityIdSchema, role: DesignFileRoleSchema })).min(1).max(50)
    .superRefine((files, context) => {
      const pairs = new Set<string>();
      files.forEach((file, index) => {
        const pair = `${file.role}:${file.assetId}`;
        if (pairs.has(pair)) context.addIssue({ code: "custom", path: [index], message: "The same asset cannot be attached twice with the same role" });
        pairs.add(pair);
      });
    }),
});

export const ReviewDesignVersionInputSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  rejectionReason: z.string().min(1).max(2_000).optional(),
}).superRefine((value, context) => {
  if (value.decision === "reject" && !value.rejectionReason) {
    context.addIssue({ code: "custom", path: ["rejectionReason"], message: "A rejection reason is required" });
  }
});

export const ApproveAssetRightsInputSchema = z.object({ rightsSource: RightsSourceSchema });

export type DesignTaskStatus = z.infer<typeof DesignTaskStatusSchema>;
export type DesignVersionStatus = z.infer<typeof DesignVersionStatusSchema>;
export type DesignFileRole = z.infer<typeof DesignFileRoleSchema>;
export type RightsSource = z.infer<typeof RightsSourceSchema>;
export type CreateDesignTaskInput = z.infer<typeof CreateDesignTaskInputSchema>;
export type UploadDesignVersionInput = z.infer<typeof UploadDesignVersionInputSchema>;
export type ReviewDesignVersionInput = z.infer<typeof ReviewDesignVersionInputSchema>;
export type ApproveAssetRightsInput = z.infer<typeof ApproveAssetRightsInputSchema>;
