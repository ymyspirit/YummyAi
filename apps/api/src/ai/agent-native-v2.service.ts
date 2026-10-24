import { Inject, Injectable, Optional } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import type { TenantContext } from "@yummyai/contracts";
import { AgentNativeV2WorkspaceSchema, AgentNativeV2ViewSchema, AgentNativeV2ReceiptSchema, AgentNativeV2ItemReceiptSchema } from "@yummyai/contracts/ai/agent-native-v2";
import type { DatabaseConnection } from "@yummyai/database";
import { agentNativeV2Protocol, type NativePorts } from "@yummyai/workflow-core";
import { AI_ASSIST_VAULT, DATABASE_CONNECTION } from "../platform.tokens.js";
import { AgentToolsService } from "./agent-tools.service.js";
import { AgentResourcesService } from "./agent-resources.service.js";
import { AgentCommandService } from "./agent-command.service.js";
import { AgentCommandOwnerAdapter } from "./agent-command-owner.js";
import { AgentPlanDispatcher } from "./agent-plan.service.js";
import { AGENT_NATIVE_RETENTION_SECONDS } from "./agent-native.service.js";
import { NativeServiceEngine } from "./agent-native-engine.service.js";

@Injectable()
export class AgentNativeV2Service extends NativeServiceEngine {
  constructor(@Inject(DATABASE_CONNECTION) database: DatabaseConnection, @Inject(AI_ASSIST_VAULT) vault: SecretVault,
    @Inject(AgentToolsService) tools: NativePorts["tools"], @Inject(AgentResourcesService) resources: NonNullable<NativePorts["resources"]>,
    @Inject(AgentCommandService) commands: AgentCommandService, @Inject(AgentCommandOwnerAdapter) owner: AgentCommandOwnerAdapter,
    @Inject(AgentPlanDispatcher) dispatcher: AgentPlanDispatcher, @Optional() @Inject(AGENT_NATIVE_RETENTION_SECONDS) retentionSeconds = 86400) {
    super(agentNativeV2Protocol, database, vault, tools, commands, owner, dispatcher, retentionSeconds, resources);
  }
  override async workspace(context: TenantContext) { return AgentNativeV2WorkspaceSchema.parse(await super.workspace(context)); }
  override async start(context: TenantContext, raw: unknown) { return AgentNativeV2ViewSchema.parse(await super.start(context, raw)); }
  override async get(context: TenantContext, id: string) { return AgentNativeV2ViewSchema.parse(await super.get(context, id)); }
  override async receipt(context: TenantContext, raw: unknown) { return AgentNativeV2ReceiptSchema.parse(await super.receipt(context, raw)); }
  override async stop(context: TenantContext, id: string, raw: unknown) { return AgentNativeV2ReceiptSchema.parse(await super.stop(context, id, raw)); }
  override async prepareItem(context: TenantContext, runId: string, itemId: string, raw: unknown) { return AgentNativeV2ItemReceiptSchema.parse(await super.prepareItem(context, runId, itemId, raw)); }
  override async itemReceipt(context: TenantContext, runId: string, itemId: string, raw: unknown) { return AgentNativeV2ItemReceiptSchema.parse(await super.itemReceipt(context, runId, itemId, raw)); }
}
