import { z } from "zod";

// The pinned database source and actor are authoritative; URLs never enter Redis.
export const CaptureMediaJobPayloadSchema = z.object({ mediaId: z.uuidv7(), snapshotId: z.uuidv7() }).strict();
export type CaptureMediaJobPayload = z.infer<typeof CaptureMediaJobPayloadSchema>;
