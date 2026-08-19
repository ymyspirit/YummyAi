import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import type { TenantContext, WorkflowNode } from "@yummyai/contracts";

import { WORKFLOW_NODE_ENQUEUER } from "../platform.tokens.js";

export interface WorkflowNodeExecutionInput {
  context: TenantContext;
  runId: string;
  nodeRunId: string;
  node: WorkflowNode;
}

export type WorkflowNodeExecutionResult =
  | { state: "waiting_for_human" }
  | { state: "queued" }
  | { state: "completed"; output: Record<string, unknown> };

export interface WorkflowNodeExecutor {
  execute(input: WorkflowNodeExecutionInput): Promise<WorkflowNodeExecutionResult>;
}

export interface WorkflowNodeEnqueuer {
  enqueue(input: {
    tenantId: string;
    runId: string;
    nodeRunId: string;
    requestedBy: string;
  }): Promise<void>;
}

@Injectable()
export class HumanExecutor implements WorkflowNodeExecutor {
  async execute(): Promise<WorkflowNodeExecutionResult> {
    return { state: "waiting_for_human" };
  }
}

@Injectable()
export class InternalCapabilityExecutor implements WorkflowNodeExecutor {
  constructor(
    @Inject(WORKFLOW_NODE_ENQUEUER) private readonly enqueuer: WorkflowNodeEnqueuer,
  ) {}

  async execute(input: WorkflowNodeExecutionInput): Promise<WorkflowNodeExecutionResult> {
    await this.enqueuer.enqueue({
      tenantId: input.context.tenantId,
      runId: input.runId,
      nodeRunId: input.nodeRunId,
      requestedBy: input.context.userId,
    });
    return { state: "queued" };
  }
}

@Injectable()
export class ExternalWorkflowExecutor implements WorkflowNodeExecutor {
  async execute(): Promise<WorkflowNodeExecutionResult> {
    throw new ServiceUnavailableException("External workflow executor is not enabled in v1");
  }
}

@Injectable()
export class WorkflowExecutorRouter {
  constructor(
    @Inject(HumanExecutor) private readonly human: HumanExecutor,
    @Inject(InternalCapabilityExecutor) private readonly internal: InternalCapabilityExecutor,
    @Inject(ExternalWorkflowExecutor) private readonly external: ExternalWorkflowExecutor,
  ) {}

  forNode(node: WorkflowNode): WorkflowNodeExecutor {
    if (node.kind === "internal_action") return this.internal;
    if (node.kind === "external_action") return this.external;
    return this.human;
  }
}
