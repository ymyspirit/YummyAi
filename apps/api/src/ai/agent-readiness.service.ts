import { BadRequestException, ConflictException, Inject, Injectable, Optional } from "@nestjs/common";
import {
  authorize,
  erpPermissionContext,
  ForbiddenError,
  intersectPermissionContexts,
  Permission,
  type PermissionValue,
} from "@yummyai/authz";
import { TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import {
  AGENT_READINESS_VERSION,
  AgentReadinessFamilySchema,
  AgentReadinessSchema,
  type AgentReadiness,
  type AgentReadinessBlocker,
  type AgentReadinessFamily,
} from "@yummyai/contracts/ai/agent-readiness";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import {
  loadCurrentMembershipContext,
  modelProviderConfigs,
  modelRoutes,
  withTenant,
  type DatabaseConnection,
  type TenantTransaction,
} from "@yummyai/database";
import { inArray, sql } from "drizzle-orm";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { AgentLoopService } from "./agent-loop.service.js";
import { AgentPlanService } from "./agent-plan.service.js";
import { AgentNativeService } from "./agent-native.service.js";
import { AgentNativeV2Service } from "./agent-native-v2.service.js";
import { AgentNativeV3Service } from "./agent-native-v3.service.js";
import { AgentNativeV4Service } from "./agent-native-v4.service.js";
import { readAgentReadinessBudget, type AgentReadinessBudgetChecks } from "./agent-readiness-budget.js";

type Workspace = Awaited<ReturnType<
  AgentLoopService["workspace"] | AgentPlanService["workspace"] | AgentNativeService["workspace"]
  | AgentNativeV2Service["workspace"] | AgentNativeV3Service["workspace"] | AgentNativeV4Service["workspace"]
>>;
const stamp = (context: TenantContext) => erpSessionAuthority(erpPermissionContext(context));

function permitted(context: TenantContext, permission: PermissionValue) {
  try {
    authorize(context, permission, permission === Permission.WorkflowRun ? { ownerId: context.userId } : undefined);
    return true;
  } catch (error) {
    if (error instanceof ForbiddenError) return false;
    throw error;
  }
}

/** A metadata sidecar. The original workspace and paid admission remain owners. */
@Injectable()
export class AgentReadinessService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AgentLoopService) private readonly loop: Pick<AgentLoopService, "workspace">,
    @Inject(AgentPlanService) private readonly plan: Pick<AgentPlanService, "workspace">,
    @Inject(AgentNativeService) private readonly nativeV1: Pick<AgentNativeService, "workspace">,
    @Inject(AgentNativeV2Service) private readonly nativeV2: Pick<AgentNativeV2Service, "workspace">,
    @Inject(AgentNativeV3Service) private readonly nativeV3: Pick<AgentNativeV3Service, "workspace">,
    @Optional() @Inject(AgentNativeV4Service) private readonly nativeV4?: Pick<AgentNativeV4Service, "workspace">,
  ) {}

  private async current(tx: TenantTransaction, ceiling: TenantContext) {
    const current = TenantContextSchema.parse(intersectPermissionContexts(
      ceiling, await loadCurrentMembershipContext(tx, ceiling, { lock: true }),
    ));
    authorize(current, Permission.WorkflowRead, { ownerId: ceiling.userId });
    return current;
  }

  private workspace(context: TenantContext, family: AgentReadinessFamily): Promise<Workspace> {
    switch (family) {
      case "loop": return this.loop.workspace(context);
      case "plan": return this.plan.workspace(context);
      case "native_v1": return this.nativeV1.workspace(context);
      case "native_v2": return this.nativeV2.workspace(context);
      case "native_v3": return this.nativeV3.workspace(context);
      case "native_v4": {
        if(!this.nativeV4)throw new ConflictException({code:"agent_protocol_unavailable"});
        return this.nativeV4.workspace(context);
      }
    }
  }

  private originalAvailable(workspace: Workspace, family: AgentReadinessFamily) {
    if (family === "plan" && "commandCapabilities" in workspace)
      return workspace.commandCapabilities.some(item => item.available);
    if (family === "loop" && "readWorkspace" in workspace)
      return workspace.readWorkspace.tools.some(item => item.available);
    if (family.startsWith("native_") && "toolWorkspace" in workspace) {
      const available = workspace.toolWorkspace.tools.some(item => item.available);
      if (family === "native_v1") return available;
      if (!("resourceWorkspace" in workspace)) throw new ConflictException({ code: "agent_readiness_workspace_changed" });
      const resources = workspace.resourceWorkspace.tools.some(item => item.available);
      if (family === "native_v2") return available || resources;
      if (!("fulfillmentWorkspace" in workspace)) throw new ConflictException({ code: "agent_readiness_workspace_changed" });
      return available || resources || workspace.fulfillmentWorkspace.definition.available;
    }
    throw new ConflictException({ code: "agent_readiness_workspace_changed" });
  }

  private async modelBlockers(tx: TenantTransaction): Promise<AgentReadinessBlocker[]> {
    // Deliberately select no endpoint, credential envelope or model prompt.
    const routes = await tx.select({ id: modelRoutes.id, status: modelRoutes.status, targets: modelRoutes.targets })
      .from(modelRoutes).where(inArray(modelRoutes.taskType, ["studio_text", "studio_analysis"]));
    if (!routes.length) return ["model_not_configured"];
    const enabled = routes.filter(route => route.status === "enabled");
    if (!enabled.length) return ["model_routes_disabled"];
    const providerIds = [...new Set(enabled.flatMap(route => route.targets[0] ? [route.targets[0].providerConfigId] : []))];
    const providers = providerIds.length ? await tx.select({
      id: modelProviderConfigs.id, status: modelProviderConfigs.status, provider: modelProviderConfigs.provider,
    }).from(modelProviderConfigs).where(inArray(modelProviderConfigs.id, providerIds)) : [];
    const live = enabled.filter(route => providers.some(provider => provider.id === route.targets[0]?.providerConfigId && provider.status === "enabled"));
    if (!live.length) return [enabled.every(route => providers.some(provider =>
      provider.id === route.targets[0]?.providerConfigId && provider.status !== "enabled"))
      ? "model_routes_disabled" : "model_provider_unsupported"];
    const supported = live.filter(route => route.targets.length === 1 && providers.some(provider =>
      provider.id === route.targets[0]!.providerConfigId && ["openai", "openai-compatible"].includes(provider.provider)));
    if (!supported.length) return ["model_provider_unsupported"];
    const blockers = new Set<AgentReadinessBlocker>();
    for (const route of supported) {
      const pricing = route.targets[0]!.analysisPricing;
      const priced = pricing && Number.isFinite(pricing.inputUsdPerMillion) && pricing.inputUsdPerMillion >= 0
        && Number.isFinite(pricing.outputUsdPerMillion) && pricing.outputUsdPerMillion >= 0;
      const capped = pricing && Number.isFinite(pricing.maxTaskCostUsd) && pricing.maxTaskCostUsd >= 0.000001;
      if (priced && capped) return [];
      if (!priced) blockers.add("model_pricing_missing");
      if (!capped) blockers.add("model_task_cap_missing");
    }
    return [...blockers];
  }

  async get(context: TenantContext, family: AgentReadinessFamily): Promise<AgentReadiness> {
    const parsed = AgentReadinessFamilySchema.safeParse(family);
    if (!parsed.success) throw new BadRequestException({ code: "agent_readiness_input_invalid" });
    family = parsed.data;
    const initial = await withTenant(this.database.db, context, tx => this.current(tx, context));
    const expectedAuthority = stamp(initial);
    const workspace = await this.workspace(initial, family);
    if (workspace.contextAuthority !== expectedAuthority) throw new ConflictException({ code: "authority_changed" });

    const result = await withTenant(this.database.db, initial, async tx => {
      const current = await this.current(tx, initial);
      if (stamp(current) !== expectedAuthority) throw new ConflictException({ code: "authority_changed" });
      const canRun = permitted(current, Permission.WorkflowRun);
      const modelBlockers = await this.modelBlockers(tx);
      const modelAvailable = modelBlockers.length === 0;
      // A concurrent configuration change must not turn an old workspace into a
      // positive diagnostic or manufacture a new model selection.
      if (modelAvailable !== (workspace.models.length > 0))
        throw new ConflictException({ code: "agent_readiness_workspace_changed" });
      const capabilityAvailable = this.originalAvailable(workspace, family);
      if (workspace.canStart !== (canRun && modelAvailable && capabilityAvailable))
        throw new ConflictException({ code: "agent_readiness_workspace_changed" });
      const budget: AgentReadinessBudgetChecks = canRun ? await readAgentReadinessBudget(tx, current, family) : {
        taskBudget: "not_checked", monthlyBudget: "not_checked", concurrency: "not_checked",
      };
      const blockers: AgentReadinessBlocker[] = [
        ...(!canRun ? ["workflow_run_permission_missing" as const] : []),
        ...modelBlockers,
        ...(!capabilityAvailable ? [family === "plan" ? "original_command_unavailable" as const : "original_read_unavailable" as const] : []),
        ...(budget.taskBudget === "below_minimum" ? ["task_budget_below_minimum" as const] : []),
        ...(budget.monthlyBudget === "cost_unknown" ? ["monthly_cost_unknown" as const] : []),
        ...(budget.monthlyBudget === "exhausted" ? ["monthly_budget_exhausted" as const] : []),
        ...(budget.concurrency === "at_limit" ? ["active_task_limit" as const] : []),
      ];
      const [clock] = await tx.execute<{ checkedAt: Date | string }>(sql`select clock_timestamp() as "checkedAt"`);
      if (!clock) throw new Error("agent_readiness_metadata_invalid");
      const checkedAt = clock.checkedAt instanceof Date ? clock.checkedAt : new Date(clock.checkedAt);
      return AgentReadinessSchema.parse({
        version: AGENT_READINESS_VERSION, family, contextAuthority: expectedAuthority, workspaceVersion: workspace.version,
        checkedAt: checkedAt.toISOString(), state: blockers.length ? "blocked" : "no_known_blocker", blockers,
        checks: {
          runPermission: canRun ? "granted" : "missing", model: modelAvailable ? "available" : "unavailable",
          originalCapability: capabilityAvailable ? "available" : "unavailable", ...budget,
        },
        canConfigureModels: permitted(current, Permission.ModelConfigure), metadataOnly: true,
        notChecked: ["request_budget", "selected_sources", "provider_connection", "consumer_readiness"],
        effects: { modelCalls: 0, queueDispatches: 0, budgetReservations: 0, businessWrites: 0 },
      });
    }, { isolationLevel: "repeatable read", accessMode: "read write" });

    // Recheck in a new transaction; do not reuse the repeatable-read membership
    // snapshot after an owner or budget read awaited a concurrent revocation.
    await withTenant(this.database.db, context, async tx => {
      if (stamp(await this.current(tx, context)) !== expectedAuthority)
        throw new ConflictException({ code: "authority_changed" });
    });
    return result;
  }
}
