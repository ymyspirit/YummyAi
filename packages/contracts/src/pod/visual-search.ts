import { z } from "zod";

const EntityIdSchema = z.uuidv7();
const VersionNumberSchema = z.int().positive();

export const VisualSearchInputSchema = z.object({
  assetId: EntityIdSchema,
  assetVersion: VersionNumberSchema.optional(),
  domain: z.enum(["all", "research", "authorized"]).default("all"),
  maxHammingDistance: z.int().min(0).max(512).default(16),
  limit: z.int().min(1).max(100).default(20),
});

export const VisualSearchHitSchema = z.object({
  fingerprintId: EntityIdSchema,
  assetId: EntityIdSchema,
  assetVersion: VersionNumberSchema,
  assetDomain: z.enum(["research", "authorized"]),
  exactChecksumMatch: z.boolean(),
  perceptualSimilarityPermille: z.int().min(0).max(1_000).optional(),
});

export const VisualSearchResultSchema = z.object({
  queryFingerprintId: EntityIdSchema,
  hits: z.array(VisualSearchHitSchema),
});

export type VisualSearchInput = z.infer<typeof VisualSearchInputSchema>;
export type VisualSearchHit = z.infer<typeof VisualSearchHitSchema>;
export type VisualSearchResult = z.infer<typeof VisualSearchResultSchema>;
