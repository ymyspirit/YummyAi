import { z } from "zod";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";
import { ArtworkModeSchema } from "@yummyai/contracts/catalog/artwork";
import { CustomizationSchema } from "@yummyai/contracts/catalog/product";
import { SpecificationFactsSchema } from "@yummyai/contracts/catalog/development";
import { OrderQueueStageSchema } from "@yummyai/contracts/order/workbench";
import {
  OrderWorkListViewSchema,
  OrderWorkListItemSchema,
  PrintProfileViewSchema,
} from "@yummyai/contracts/order/workspace";
import { OrderDesignAgentViewSchema } from "@yummyai/contracts/order/design-agent";

export const PillowProjectQuerySchema = z
  .object({
    q: z.string().trim().max(200).default(""),
    stage: OrderQueueStageSchema.optional(),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
export const PillowProjectWorkspaceSchema = z.object({
  access: z.object({ catalog: z.boolean(), orders: z.boolean(), details: z.boolean() }),
  specifications: z.array(
    z.object({
      id: Id,
      versionId: Id,
      version: z.int().positive(),
      spuId: Id,
      spuCode: z.string(),
      spuName: z.string(),
      name: z.string(),
      attributes: z.record(z.string(), z.string()),
      facts: SpecificationFactsSchema,
      processProfileVersionId: Id.nullable(),
      processName: z.string(),
      stockItemId: Id.nullable(),
    }),
  ),
  artworks: z.array(
    z.object({
      id: Id,
      versionId: Id,
      version: z.int().positive(),
      code: z.string(),
      name: z.string(),
      mode: ArtworkModeSchema,
      customization: CustomizationSchema,
      instructions: z.string(),
    }),
  ),
  recipes: z.array(
    z.object({
      skuId: Id,
      skuCode: z.string(),
      recipeId: Id,
      version: z.int().positive(),
      artworkVersionId: Id,
      specificationVersionId: Id,
      status: z.enum([
        "pending_adaptation",
        "in_adaptation",
        "ready_for_customization",
        "approved",
      ]),
      needsUpdate: z.boolean(),
    }),
  ),
  orders: OrderWorkListViewSchema.nullable(),
  diagnostics: z.array(z.string()),
});
export const PillowProcessVersionSchema = z.object({
  projectId: Id,
  versionId: Id,
  version: z.int().positive(),
  reviewed: z.boolean(),
  factoryStandardId: z.string().nullable(),
  sizeBasis: z.enum(["unconfirmed", "finished", "cut_contour", "artwork"]),
  minimumNeckBasis: z.enum(["unconfirmed", "finished", "cut_contour"]),
  sideMode: z.enum(["single", "double"]),
  automationEnabled: z.boolean(),
});
export const PillowOrderStageKeySchema = z.enum([
  "requirements",
  "artwork",
  "review",
  "production",
]);
export const PillowOrderStageSchema = z.object({
  key: PillowOrderStageKeySchema,
  label: z.string(),
  status: z.enum(["not_started", "in_progress", "complete", "blocked"]),
  detail: z.string(),
});
export const PillowProjectOrderSchema = z.object({
  line: OrderWorkListItemSchema,
  basis: z.object({
    pinned: z.boolean(),
    artworkVersionId: Id.nullable(),
    specificationVersionId: Id.nullable(),
    recipeVersionId: Id.nullable(),
    artworkName: z.string().nullable(),
    specificationName: z.string().nullable(),
    profile: PrintProfileViewSchema,
  }),
  template: PillowProcessVersionSchema.nullable(),
  currentArtwork: PillowProcessVersionSchema.nullable(),
  formalFile: z
    .object({ id: Id, versionId: Id, status: z.string(), ready: z.boolean() })
    .nullable(),
  agent: OrderDesignAgentViewSchema,
  stages: z.array(PillowOrderStageSchema),
  diagnostics: z.array(z.string()),
});
export type PillowProjectQuery = z.infer<typeof PillowProjectQuerySchema>;
export type PillowProjectWorkspace = z.infer<typeof PillowProjectWorkspaceSchema>;
export type PillowProjectOrder = z.infer<typeof PillowProjectOrderSchema>;
export type PillowOrderStage = z.infer<typeof PillowOrderStageSchema>;
