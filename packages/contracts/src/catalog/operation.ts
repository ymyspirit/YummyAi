import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";

export const CatalogSourcePinSchema = z
  .object({
    researchItemId: EntityIdSchema,
    snapshotId: EntityIdSchema,
    productTypeName: z.string().nullable(),
  })
  .strict();
export const CatalogAssetPinSchema = z
  .object({
    id: EntityIdSchema,
    version: z.int().positive(),
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
    domain: z.string(),
    rightsStatus: z.string(),
    rightsSourceKind: z.string().nullable(),
    fileName: z.string().min(1),
    mediaType: z.string().min(1),
    byteSize: z.int().nonnegative(),
  })
  .strict();
export const CatalogPreparedOperationSchema = z
  .object({
    schemaVersion: z.literal(1),
    operation: z.enum(["profile", "package"]),
    operationId: EntityIdSchema,
    productPlanId: EntityIdSchema,
    basisChecksum: z.string().regex(/^[a-f0-9]{64}$/),
    preparedAt: z.iso.datetime(),
    targetMarketplace: z.string().min(1).max(120),
    mode: z.enum(["draft", "release"]),
    sources: z.array(CatalogSourcePinSchema).max(50),
    assets: z.array(CatalogAssetPinSchema).max(500),
  })
  .strict();
export type CatalogPreparedOperation = z.infer<typeof CatalogPreparedOperationSchema>;
export const CatalogOperationParametersSchema = z.object({
  researchSnapshotId: EntityIdSchema.optional(),
  researchItemId: EntityIdSchema.optional(),
  targetMarketplace: z.string().trim().min(1).max(120).optional(),
  mode: z.enum(["draft", "release"]).optional(),
});
