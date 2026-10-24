import { EntityIdSchema } from "@yummyai/contracts";
import { z } from "zod";

/** Only task identity crosses the queue; all buyer data stays in private storage. */
export const OrderDesignJobPayloadSchema = z.object({ runId: EntityIdSchema }).strict();
export type OrderDesignJobPayload = z.infer<typeof OrderDesignJobPayloadSchema>;
