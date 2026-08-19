import { z } from "zod";

const EntityIdSchema = z.uuidv7();
const VersionNumberSchema = z.int().positive();

export const CreateListingArtifactBindingInputSchema = z.object({
  listingVersionId: EntityIdSchema,
  assetId: EntityIdSchema,
  assetVersion: VersionNumberSchema,
  contentKind: z.enum(["image", "title"]),
  slotKey: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/),
});

export const ListingArtifactBindingSchema = CreateListingArtifactBindingInputSchema.extend({
  id: EntityIdSchema,
  status: z.enum(["candidate", "approved", "rejected"]),
  createdBy: EntityIdSchema.optional(),
  createdAt: z.iso.datetime(),
});

export const ListingArtifactBindingListSchema = z.object({
  items: z.array(ListingArtifactBindingSchema).max(500),
}).strict();

export const PodListingArtifactOptionsViewSchema = z.object({
  listingVersions: z.array(z.object({
    id: EntityIdSchema,
    listingId: EntityIdSchema,
    versionNumber: VersionNumberSchema,
    platform: z.enum(["amazon", "etsy"]),
    locale: z.string().min(1),
    status: z.enum(["draft", "approved", "superseded"]),
  }).strict()).max(500),
  assets: z.array(z.object({
    id: EntityIdSchema,
    version: VersionNumberSchema,
    fileName: z.string().min(1),
    mediaType: z.string().min(1),
  }).strict()).max(500),
  bindings: z.array(ListingArtifactBindingSchema).max(500),
}).strict();

export type CreateListingArtifactBindingInput = z.infer<typeof CreateListingArtifactBindingInputSchema>;
export type ListingArtifactBinding = z.infer<typeof ListingArtifactBindingSchema>;
export type ListingArtifactBindingList = z.infer<typeof ListingArtifactBindingListSchema>;
export type PodListingArtifactOptionsView = z.infer<typeof PodListingArtifactOptionsViewSchema>;
