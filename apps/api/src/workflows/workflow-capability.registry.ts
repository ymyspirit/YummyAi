import { Injectable } from "@nestjs/common";
import { PodExecutableToolKeySchema } from "@yummyai/contracts";

import type {
  WorkflowCapabilityDescriptor,
  WorkflowValidationRegistry,
} from "./workflow-graph.validator.js";

const BASE_CAPABILITIES: WorkflowCapabilityDescriptor[] = [
  {
    key: "yummyai.custom_product.generate_provisional_facts",
    enabled: true,
    executor: "internal",
    inputTypes: ["research_snapshot"],
    outputTypes: ["product_facts"],
    requiredPermission: "product:write",
    rightsPolicy: "reference_analysis_only",
  },
  {
    key: "yummyai.custom_product.export_package",
    enabled: true,
    executor: "internal",
    inputTypes: ["product_facts", "design_version"],
    outputTypes: ["product_package"],
    requiredPermission: "product:write",
    rightsPolicy: "authorized_only",
  },
  {
    key: "external.n8n.webhook",
    enabled: false,
    executor: "external",
    inputTypes: ["any"],
    outputTypes: ["any"],
  },
  ...PodExecutableToolKeySchema.options.map((toolKey) => ({
    key: `pod.${toolKey}`,
    enabled: true,
    executor: "internal" as const,
    inputTypes: ["image" as const],
    outputTypes: ["design_version" as const],
    requiredPermission: "design:write",
    rightsPolicy: "authorized_only" as const,
  })),
];

@Injectable()
export class WorkflowCapabilityRegistry {
  private readonly capabilities = new Map(BASE_CAPABILITIES.map((item) => [item.key, item]));
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
