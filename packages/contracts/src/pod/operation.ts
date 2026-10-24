import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { CatalogAssetPinSchema } from "@yummyai/contracts/catalog/operation";
import { CreatePodArtworkTaskInputSchema } from "./pod.js";
import { PodMethodSnapshotSchema } from "@yummyai/contracts/harness/methods";

export const PodPreparedOperationSchema = z
  .object({
    schemaVersion: z.literal(1),
    productPlanId: EntityIdSchema,
    input: CreatePodArtworkTaskInputSchema,
    assets: z.array(CatalogAssetPinSchema).max(100),
    methodSnapshot: PodMethodSnapshotSchema.optional(),
  })
  .strict();
export type PodPreparedOperation = z.infer<typeof PodPreparedOperationSchema>;
