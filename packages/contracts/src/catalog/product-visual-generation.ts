import { z } from "zod";
import { VisualSlotKeySchema } from "@yummyai/contracts/catalog/product-visuals";
import { StudioOriginalInspectionSchema } from "@yummyai/contracts/pod/studio-original";
const Id=z.uuidv7(),Hash=z.string().regex(/^[a-f0-9]{64}$/);
export const PrepareProductVisualImageSchema=z.object({requestId:z.uuid(),slotKey:VisualSlotKeySchema,
  selectionRevision:Hash,artworkVersionId:Id.optional(),prompt:z.string().trim().max(1500).default("")}).strict()
  .refine(v=>v.slotKey==="artwork"?!v.artworkVersionId:!!v.artworkVersionId,"请明确本步骤的已审核图稿版本");
export const ProductVisualImageAddressSchema=z.object({slotKey:VisualSlotKeySchema,requestId:z.uuid()}).strict();
export const CommitProductVisualImageSchema=ProductVisualImageAddressSchema.extend({quoteHash:Hash,confirmed:z.literal(true)}).strict();
export const CancelProductVisualImageSchema=ProductVisualImageAddressSchema.extend({quoteHash:Hash}).strict();
export const ProductVisualImageIndexSchema=z.object({slotKey:VisualSlotKeySchema,cursor:Id.optional(),limit:z.coerce.number().int().min(1).max(40).default(20)}).strict();
export const ProductVisualImageLookupQuerySchema=z.object({slotKey:VisualSlotKeySchema}).strict();
export const ProductVisualImageOriginalSchema=z.object({scope:Id,slotKey:VisualSlotKeySchema,requestId:z.uuid(),generationId:Id,
  key:z.string().regex(/^image:[0-9a-f-]{36}$/),inspection:StudioOriginalInspectionSchema}).strict()
  .refine(v=>v.key===`image:${v.generationId}`,"原件范围不一致");
export type PrepareProductVisualImage=z.infer<typeof PrepareProductVisualImageSchema>;
export type ProductVisualImageAddress=z.infer<typeof ProductVisualImageAddressSchema>;
export type ProductVisualImageOriginal=z.infer<typeof ProductVisualImageOriginalSchema>;
