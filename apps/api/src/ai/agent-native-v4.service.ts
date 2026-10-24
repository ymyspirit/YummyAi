import { Inject, Injectable, Optional } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import type { TenantContext } from "@yummyai/contracts";
import {
  AgentNativeV4WorkspaceSchema, AgentNativeV4ViewSchema, AgentNativeV4ReceiptSchema, AgentNativeV4ItemReceiptSchema,
} from "@yummyai/contracts/ai/agent-native-v4";
import type { DatabaseConnection } from "@yummyai/database";
import {
  agentCommandV2Capabilities, agentNativeV4Protocol, SharedAgentCommandV2Gateway,
  type NativePorts, type NativeV4Family,
} from "@yummyai/workflow-core";
import { AI_ASSIST_VAULT, DATABASE_CONNECTION } from "../platform.tokens.js";
import { AgentCommandOwnerAdapter } from "./agent-command-owner.js";
import { AgentCommandService } from "./agent-command.service.js";
import { AgentFulfillmentCommandService } from "./agent-fulfillment-command.service.js";
import { AgentFulfillmentService } from "./agent-fulfillment.service.js";
import { LegacyNativeCommandPreparationPort } from "./agent-native-command-port.js";
import { NativeServiceEngine } from "./agent-native-engine.service.js";
import { AgentNativeV4CommandOwner } from "./agent-native-v4-command-owner.js";
import { AGENT_NATIVE_RETENTION_SECONDS } from "./agent-native.service.js";
import { AgentPlanDispatcher } from "./agent-plan.service.js";
import { AgentResourcesService } from "./agent-resources.service.js";
import { AgentToolsService } from "./agent-tools.service.js";

@Injectable()
export class AgentNativeV4Service extends NativeServiceEngine<NativeV4Family> {
  constructor(@Inject(DATABASE_CONNECTION) database: DatabaseConnection, @Inject(AI_ASSIST_VAULT) vault: SecretVault,
    @Inject(AgentToolsService) tools: NativePorts["tools"], @Inject(AgentResourcesService) resources: NonNullable<NativePorts["resources"]>,
    @Inject(AgentCommandService) commands: AgentCommandService, @Inject(AgentCommandOwnerAdapter) owner: AgentCommandOwnerAdapter,
    @Inject(AgentPlanDispatcher) dispatcher: AgentPlanDispatcher, @Inject(AgentFulfillmentService) fulfillment: NonNullable<NativePorts["fulfillment"]>,
    @Inject(AgentFulfillmentCommandService) fulfillmentCommands: AgentFulfillmentCommandService,
    @Optional() @Inject(AGENT_NATIVE_RETENTION_SECONDS) retentionSeconds = 86400) {
    const preparation = new AgentNativeV4CommandOwner(new LegacyNativeCommandPreparationPort(commands, owner), fulfillmentCommands);
    const definitions = new SharedAgentCommandV2Gateway(database, tools, { capabilities: agentCommandV2Capabilities });
    super(agentNativeV4Protocol, database, vault, tools, commands, owner, dispatcher, retentionSeconds, resources, fulfillment, preparation, definitions);
  }
  override async workspace(context: TenantContext) { return AgentNativeV4WorkspaceSchema.parse(await super.workspace(context)); }
  override async start(context: TenantContext, raw: unknown) { return AgentNativeV4ViewSchema.parse(await super.start(context, raw)); }
  override async get(context: TenantContext, id: string) { return AgentNativeV4ViewSchema.parse(await super.get(context, id)); }
  override async receipt(context: TenantContext, raw: unknown) { return AgentNativeV4ReceiptSchema.parse(await super.receipt(context, raw)); }
  override async stop(context: TenantContext, id: string, raw: unknown) { return AgentNativeV4ReceiptSchema.parse(await super.stop(context, id, raw)); }
  override async prepareItem(context: TenantContext, runId: string, itemId: string, raw: unknown) { return AgentNativeV4ItemReceiptSchema.parse(await super.prepareItem(context, runId, itemId, raw)); }
  override async itemReceipt(context: TenantContext, runId: string, itemId: string, raw: unknown) { return AgentNativeV4ItemReceiptSchema.parse(await super.itemReceipt(context, runId, itemId, raw)); }
}
