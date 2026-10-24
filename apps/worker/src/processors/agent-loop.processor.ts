import type { TenantContext } from "@yummyai/contracts";
import type { JobEnvelope } from "@yummyai/jobs";
import type { AgentLoopRuntime } from "@yummyai/workflow-core";
import { z } from "zod";

const Payload = z.object({ runId: z.uuidv7(), operation: z.enum(["execute", "expire"]).default("execute") }).strict();

/** The queue carries identity and the original run reference, never grants. */
export class AgentLoopProcessor {
  constructor(private readonly runtime: AgentLoopRuntime) {}

  process(envelope: JobEnvelope) {
    const payload = Payload.parse(envelope.payload);
    const context: TenantContext = { tenantId: envelope.tenantId, userId: envelope.requestedBy, permissions: [], dataScope: "tenant" };
    return this.runtime.process(context, payload.runId, payload.operation);
  }
}
