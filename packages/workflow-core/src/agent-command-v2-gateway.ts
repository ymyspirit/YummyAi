import { harnessChecksum } from "@yummyai/ai-core";
import { authorize, erpPermissionContext, ForbiddenError, intersectPermissionContexts, Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { AGENT_COMMAND_VERSION } from "@yummyai/contracts/ai/agent-command";
import {
  AGENT_COMMAND_V2_DEFINITION_VERSION, AgentCommandV2DefinitionRequestSchema, AgentCommandV2DefinitionSchema,
  AgentCommandV2DefinitionWorkspaceSchema, agentCommandV2DefinitionPayload,
  type AgentCommandV2Definition, type AgentCommandV2DefinitionWorkspace,
} from "@yummyai/contracts/ai/agent-command-v2-discovery";
import {
  AGENT_FULFILLMENT_COMMAND_VERSION, AgentCommandV2CatalogSchema, type AgentCommandV2Capability,
} from "@yummyai/contracts/ai/agent-fulfillment-command";
import {
  AgentFulfillmentSuggestionOriginalSchema, AgentFulfillmentSuggestionSchema, agentFulfillmentOperatorChecks,
} from "@yummyai/contracts/ai/agent-fulfillment-proposal";
import {
  AGENT_TOOLS_VERSION, AgentToolDefinitionSchema, agentToolDefinitionPayload,
} from "@yummyai/contracts/ai/agent-tools";
import { OriginalOwnerError } from "@yummyai/contracts/common/original-owner-error";
import { loadCurrentMembershipContext, withTenant, type DatabaseConnection } from "@yummyai/database";
import { z } from "zod";
import type { SharedAgentToolsGateway } from "./agent-tools-gateway.js";

export interface AgentCommandV2CapabilitiesPort {
  capabilities(context: TenantContext): AgentCommandV2Capability[];
}

const stamp = (context: TenantContext) => erpSessionAuthority(erpPermissionContext(context));
function failure(status: 400 | 403 | 409 | 502, code: string, message: string): never {
  throw new OriginalOwnerError(status, { code, message });
}
const commonLimitations = [
  "只发现所选命令的建议契约 不准备 确认或执行业务操作",
  "目录资格不授予原对象或来源访问权 实际准备须沿原owner当前权限与原上限复核",
  "schema和引用通过不证明建议的数量 金额 业务判断或实际操作已经正确完成",
];

/** Independent command discovery. Worker composition needs no API or write owner. */
export class SharedAgentCommandV2Gateway {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly legacyDefinitions: Pick<SharedAgentToolsGateway, "definition">,
    private readonly capabilityOwner: AgentCommandV2CapabilitiesPort,
  ) {}

  private async current(caller: TenantContext): Promise<TenantContext> {
    const current = await withTenant(this.database.db, caller, async tx =>
      intersectPermissionContexts(caller, await loadCurrentMembershipContext(tx, caller, { lock: true })),
    { isolationLevel: "repeatable read", accessMode: "read write" });
    try { authorize(current, Permission.WorkflowRead, { ownerId: caller.userId }); }
    catch (error) {
      if (!(error instanceof ForbiddenError)) throw error;
      failure(403, "agent_command_v2_access_denied", "当前成员缺少原命令发现读取权限");
    }
    return current;
  }

  private catalog(context: TenantContext): AgentCommandV2Capability[] {
    const parsed = AgentCommandV2CatalogSchema.safeParse(this.capabilityOwner.capabilities(context));
    if (!parsed.success) failure(502, "agent_command_v2_catalog_invalid", "原命令目录无法核对");
    return parsed.data;
  }

  private async recheck(caller: TenantContext, before: TenantContext, catalog: AgentCommandV2Capability[]) {
    const after = await this.current(caller);
    if (stamp(after) !== stamp(before) || harnessChecksum(this.catalog(after)) !== harnessChecksum(catalog))
      failure(409, "authority_changed", "当前权限或原命令目录已变化");
  }

  async workspace(context: TenantContext): Promise<AgentCommandV2DefinitionWorkspace> {
    const current = await this.current(context), capabilities = this.catalog(current);
    const result = AgentCommandV2DefinitionWorkspaceSchema.parse({ version: AGENT_COMMAND_V2_DEFINITION_VERSION,
      contextAuthority: stamp(current), capabilities });
    await this.recheck(context, current, capabilities);
    return result;
  }

  async definition(context: TenantContext, raw: unknown): Promise<AgentCommandV2Definition> {
    const parsed = AgentCommandV2DefinitionRequestSchema.safeParse(raw);
    if (!parsed.success) failure(400, "agent_command_v2_input_invalid", "所选原命令定义无法核对");
    const current = await this.current(context), capabilities = this.catalog(current);
    const selection = parsed.data.selection, command = selection.command;
    const capability = capabilities.find(item => item.domain === command.domain && item.kind === command.kind);
    if (!capability) failure(409, "agent_command_v2_not_registered", "所选原命令尚未注册");

    let inputSchema: AgentCommandV2Definition["inputSchema"];
    let protocol: AgentCommandV2Definition["protocol"];
    let completion: AgentCommandV2Definition["completion"];
    let operatorChecks: AgentCommandV2Definition["operatorChecks"] = [];
    let limitations: string[];
    let available = capability.available, blockReason = capability.blockReason;
    if (command.domain === "fulfillment") {
      const original = AgentFulfillmentSuggestionOriginalSchema.options.find(option => option.shape.kind.value === command.kind);
      if (!original) failure(409, "agent_command_v2_not_registered", "所选原履约建议尚未注册");
      // safeExtend retains the original strict suggestion's forbidden-field
      // refinement. Only this kind is described; no complete owner DTO or key.
      const suggested = AgentFulfillmentSuggestionSchema.safeExtend({ original });
      inputSchema = z.toJSONSchema(suggested, { io: "input" });
      protocol = AGENT_FULFILLMENT_COMMAND_VERSION;
      completion = "operator_completed_original_request";
      operatorChecks = agentFulfillmentOperatorChecks(command.kind);
      limitations = [...commonLimitations,
        "模型只能建议所选原来源的字段 不得提供本人核对 实物隔离或选择声明 也不得生成请求键或执行凭据",
        "待核对项由服务端派生为pending 本人须在原控件补全核对并固定完整原请求摘要后 才能显式保存原准备",
        "原提案与claims不回写 本人补项或修改的新值不能由原claims自动背书 工厂与实物事实仍须原流程确认",
      ];
    } else {
      const native = AgentToolDefinitionSchema.safeParse(await this.legacyDefinitions.definition(current, {
        version: AGENT_TOOLS_VERSION, selection: { kind: "command", command },
      }));
      if (!native.success || native.data.selection.kind !== "command" || native.data.selection.command.domain !== command.domain ||
        native.data.selection.command.kind !== command.kind || native.data.effect !== "prepare_original_command" ||
        native.data.execution !== "separate_original_preparation_and_confirmation" ||
        native.data.definitionChecksum !== harnessChecksum(agentToolDefinitionPayload(native.data)))
        failure(502, "agent_command_v2_definition_invalid", "原命令定义与摘要无法核对");
      if (native.data.contextAuthority !== stamp(current)) failure(409, "authority_changed", "原命令定义的当前权限已变化");
      inputSchema = native.data.inputSchema;
      protocol = AGENT_COMMAND_VERSION;
      completion = "legacy_original_request";
      available = available && native.data.available;
      if (!available) blockReason = blockReason ?? native.data.blockReason;
      limitations = [...commonLimitations, ...native.data.limitations];
    }
    const contract = { version: AGENT_COMMAND_V2_DEFINITION_VERSION, selection, protocol, inputSchema,
      effect: "suggest_original_command" as const, execution: "separate_original_preparation_and_confirmation" as const,
      completion, operatorChecks, limitations };
    const result = AgentCommandV2DefinitionSchema.parse({ ...contract, contextAuthority: stamp(current), available,
      blockReason: available ? null : blockReason ?? "original_command_permission_required",
      definitionChecksum: harnessChecksum(agentCommandV2DefinitionPayload(contract)) });
    await this.recheck(context, current, capabilities);
    return result;
  }
}

export type AgentCommandV2DefinitionsPort = Pick<SharedAgentCommandV2Gateway, "workspace" | "definition">;
