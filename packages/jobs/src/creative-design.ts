import { EntityIdSchema } from "@yummyai/contracts";
import { z } from "zod";

export const CreativeDesignJobPayloadSchema = z.object({ candidateId: EntityIdSchema }).strict();
export const CreativeDesignAdaptationJobPayloadSchema = z.object({ creativeDesignVersionId: EntityIdSchema }).strict();

export type CreativeDesignJobPayload = z.infer<typeof CreativeDesignJobPayloadSchema>;
export type CreativeDesignAdaptationJobPayload = z.infer<typeof CreativeDesignAdaptationJobPayloadSchema>;
