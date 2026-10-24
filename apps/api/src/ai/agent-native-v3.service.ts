import { Inject, Injectable, Optional } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import type { TenantContext } from "@yummyai/contracts";
import { AgentNativeV3WorkspaceSchema, AgentNativeV3ViewSchema, AgentNativeV3ReceiptSchema, AgentNativeV3ItemReceiptSchema } from "@yummyai/contracts/ai/agent-native-v3";
import type { DatabaseConnection } from "@yummyai/database";
import { agentNativeV3Protocol, type NativePorts, type NativeV3Family } from "@yummyai/workflow-core";
import { AI_ASSIST_VAULT, DATABASE_CONNECTION } from "../platform.tokens.js";
import { AgentToolsService } from "./agent-tools.service.js";
import { AgentFulfillmentService } from "./agent-fulfillment.service.js";
import { AgentResourcesService } from "./agent-resources.service.js";
import { AgentCommandService } from "./agent-command.service.js";
import { AgentCommandOwnerAdapter } from "./agent-command-owner.js";
import { AgentPlanDispatcher } from "./agent-plan.service.js";
import { AGENT_NATIVE_RETENTION_SECONDS } from "./agent-native.service.js";
import { NativeServiceEngine } from "./agent-native-engine.service.js";

@Injectable()
export class AgentNativeV3Service extends NativeServiceEngine<NativeV3Family> {
  constructor(@Inject(DATABASE_CONNECTION) database: DatabaseConnection, @Inject(AI_ASSIST_VAULT) vault: SecretVault,
    @Inject(AgentToolsService) tools: NativePorts["tools"], @Inject(AgentResourcesService) resources: NonNullable<NativePorts["resources"]>,
    @Inject(AgentCommandService) commands: AgentCommandService, @Inject(AgentCommandOwnerAdapter) owner: AgentCommandOwnerAdapter,
    @Inject(AgentPlanDispatcher) dispatcher: AgentPlanDispatcher, @Inject(AgentFulfillmentService) fulfillment: NonNullable<NativePorts["fulfillment"]>, @Optional() @Inject(AGENT_NATIVE_RETENTION_SECONDS) retentionSeconds = 86400) {
    super(agentNativeV3Protocol, database, vault, tools, commands, owner, dispatcher, retentionSeconds, resources, fulfillment);
  }
  override async workspace(context: TenantContext) { return AgentNativeV3WorkspaceSchema.parse(await super.workspace(context)); }
  override async start(context: TenantContext, raw: unknown) { return AgentNativeV3ViewSchema.parse(await super.start(context, raw)); }
  override async get(context: TenantContext, id: string) { return AgentNativeV3ViewSchema.parse(await super.get(context, id)); }
  override async receipt(context: TenantContext, raw: unknown) { return AgentNativeV3ReceiptSchema.parse(await super.receipt(context, raw)); }
  override async stop(context: TenantContext, id: string, raw: unknown) { return AgentNativeV3ReceiptSchema.parse(await super.stop(context, id, raw)); }
  override async prepareItem(context: TenantContext, runId: string, itemId: string, raw: unknown) { return AgentNativeV3ItemReceiptSchema.parse(await super.prepareItem(context, runId, itemId, raw)); }
  override async itemReceipt(context: TenantContext, runId: string, itemId: string, raw: unknown) { return AgentNativeV3ItemReceiptSchema.parse(await super.itemReceipt(context, runId, itemId, raw)); }
}
