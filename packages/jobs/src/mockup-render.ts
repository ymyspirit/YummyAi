import { EntityIdSchema } from "@yummyai/contracts";
import { z } from "zod";

export const MockupTemplateCompileJobPayloadSchema = z.object({ inspectionId: EntityIdSchema }).strict();
export const MockupRenderJobPayloadSchema = z.object({ itemId: EntityIdSchema }).strict();

export type MockupTemplateCompileJobPayload = z.infer<typeof MockupTemplateCompileJobPayloadSchema>;
export type MockupRenderJobPayload = z.infer<typeof MockupRenderJobPayloadSchema>;
