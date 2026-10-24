import { Inject, Injectable, Optional } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import type { TenantContext } from "@yummyai/contracts";
import { AgentNativeWorkspaceSchema, AgentNativeViewSchema, AgentNativeReceiptSchema, AgentNativeItemReceiptSchema } from "@yummyai/contracts/ai/agent-native";
import type { DatabaseConnection } from "@yummyai/database";
import { agentNativeV1Protocol, type NativePorts } from "@yummyai/workflow-core";
import { AI_ASSIST_VAULT, DATABASE_CONNECTION } from "../platform.tokens.js";
import { AgentToolsService } from "./agent-tools.service.js";
import { AgentCommandService } from "./agent-command.service.js";
import { AgentCommandOwnerAdapter } from "./agent-command-owner.js";
import { AgentPlanDispatcher } from "./agent-plan.service.js";
import { NativeServiceEngine } from "./agent-native-engine.service.js";

export const AGENT_NATIVE_RETENTION_SECONDS = Symbol("AGENT_NATIVE_RETENTION_SECONDS");
@Injectable()
export class AgentNativeService extends NativeServiceEngine {
  constructor(@Inject(DATABASE_CONNECTION) database: DatabaseConnection, @Inject(AI_ASSIST_VAULT) vault: SecretVault,
    @Inject(AgentToolsService) tools: NativePorts["tools"], @Inject(AgentCommandService) commands: AgentCommandService,
    @Inject(AgentCommandOwnerAdapter) owner: AgentCommandOwnerAdapter, @Inject(AgentPlanDispatcher) dispatcher: AgentPlanDispatcher,
    @Optional() @Inject(AGENT_NATIVE_RETENTION_SECONDS) retentionSeconds = 86400) {
    super(agentNativeV1Protocol, database, vault, tools, commands, owner, dispatcher, retentionSeconds);
  }
  override async workspace(context: TenantContext) { return AgentNativeWorkspaceSchema.parse(await super.workspace(context)); }
  override async start(context: TenantContext, raw: unknown) { return AgentNativeViewSchema.parse(await super.start(context, raw)); }
  override async get(context: TenantContext, id: string) { return AgentNativeViewSchema.parse(await super.get(context, id)); }
  override async receipt(context: TenantContext, raw: unknown) { return AgentNativeReceiptSchema.parse(await super.receipt(context, raw)); }
  override async stop(context: TenantContext, id: string, raw: unknown) { return AgentNativeReceiptSchema.parse(await super.stop(context, id, raw)); }
  override async prepareItem(context: TenantContext, runId: string, itemId: string, raw: unknown) { return AgentNativeItemReceiptSchema.parse(await super.prepareItem(context, runId, itemId, raw)); }
  override async itemReceipt(context: TenantContext, runId: string, itemId: string, raw: unknown) { return AgentNativeItemReceiptSchema.parse(await super.itemReceipt(context, runId, itemId, raw)); }
}
