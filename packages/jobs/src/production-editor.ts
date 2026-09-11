import { EntityIdSchema } from "@yummyai/contracts";
import { z } from "zod";

// Private design text, source files and scene data stay in the tenant database.
export const ProductionEditorRenderJobPayloadSchema = z.object({ renderId: EntityIdSchema }).strict();
export type ProductionEditorRenderJobPayload = z.infer<typeof ProductionEditorRenderJobPayloadSchema>;
