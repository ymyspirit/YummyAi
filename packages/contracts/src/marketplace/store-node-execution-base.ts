import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";

export const StoreNodeExecutionPinsSchema = z.object({ nodeId: EntityIdSchema, certificateGeneration: z.int().positive(),
  authorizationGeneration: z.uuid(), bindingRevision: z.int().positive() }).strict();
export const StoreNodeExecutionStateSchema = z.enum(["waiting_node", "claimed", "running", "unknown_outcome", "succeeded", "failed", "cancelled", "expired", "authority_changed"]);
export const StoreNodeExecutionPhaseSchema = z.enum(["queued", "credential_ready", "refresh_pending", "credential_checkpointed", "collecting", "finished"]);
export const StoreNodeExecutionErrorSchema = z.enum(["store_node_configuration_invalid", "store_node_policy_rejected", "store_node_operation_unknown",
  "store_node_application_reauthorization_required",
  "store_node_execution_expired", "store_node_authority_changed", "store_node_execution_failed", "store_node_result_too_large", "store_node_secret_output_rejected",
  "store_node_upstream_authorization", "store_node_upstream_validation", "store_node_upstream_rate_limited", "store_node_upstream_retryable", "store_node_upstream_terminal"]);
