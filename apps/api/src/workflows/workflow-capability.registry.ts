import { Inject, Injectable, Optional } from "@nestjs/common";
import { PodExecutableToolKeySchema } from "@yummyai/contracts";
import { enabledPodArtworkTools } from "@yummyai/pod-core";
import { workflowHarnessCapabilities } from "@yummyai/workflow-core";
import { PodWorkbenchService } from "../design/pod-workbench.service.js";

import type {
  WorkflowCapabilityDescriptor,
  WorkflowValidationRegistry,
} from "./workflow-graph.validator.js";

const BASE_CAPABILITIES: WorkflowCapabilityDescriptor[] = [
  ...workflowHarnessCapabilities().map(({ key, inputTypes, outputTypes, requiredPermission, rightsPolicy, executionContract }) => ({ key, enabled: true, executor: "internal" as const, inputTypes, outputTypes, requiredPermission, rightsPolicy, executionContract })),
  {
    key: "external.n8n.webhook",
    enabled: false,
    executor: "external",
    inputTypes: ["any"],
    outputTypes: ["any"],
  },
];

@Injectable()
export class WorkflowCapabilityRegistry {
  private readonly capabilities: Map<string, WorkflowCapabilityDescriptor>;
  constructor(@Optional() @Inject(PodWorkbenchService) workbench?: PodWorkbenchService) {
    const enabled = enabledPodArtworkTools();
    this.capabilities = new Map(BASE_CAPABILITIES.map((item) => {
      if (!item.key.startsWith("pod.")) return [item.key, item];
      const tool = PodExecutableToolKeySchema.parse(item.key.slice(4));
      return [item.key, { ...item, enabled: workbench?.isToolEnabled(tool) ?? enabled.has(tool) }];
    }));
  }
  private readonly conditions = new Set([
    "product.has_verified_facts",
    "product.has_authorized_assets",
    "review.is_approved",
  ]);

  validationRegistry(): WorkflowValidationRegistry {
    return {
      capabilities: this.capabilities,
      conditions: this.conditions,
      externalExecutorEnabled: false,
    };
  }

  list() {
    return [...this.capabilities.values()];
  }

  get(key: string) {
    return this.capabilities.get(key);
  }
}
