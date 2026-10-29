import {
  assistHarness,
  assistPromptVersion,
  assistUsesReviewedGuidance,
  HarnessContractError,
  isBenchmarkAssist,
  type AssistContext,
} from "@yummyai/ai-core";
import {
  ASSIST_ACCESS_POLICY_VERSION,
  authorizeAssistRequest,
  ForbiddenError,
  requiredAssistPermissions,
} from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { AssistInputAuthoritySchema } from "@yummyai/contracts/ai/assist";
import {
  aiAssistRuns as runs,
  aiBudgetPolicies,
  memberships,
  membershipRoles,
  roles,
  modelProviderConfigs,
  modelRoutes,
  withTenant,
  captureAssistInputAuthority,
  assertAssistInputAuthority,
  assertAgentMethodSelection,
  type DatabaseConnection,
} from "@yummyai/database";
import { knowledgeExecutionAuthority, assertMethodKnowledge } from "@yummyai/knowledge-core";
import { and, eq } from "drizzle-orm";

export type AssistExecutionRun = typeof runs.$inferSelect;
export type AssistExecutionProviderRow = typeof modelProviderConfigs.$inferSelect;

/** Revalidate the native Assist route and current source authority before execution or adoption. */
export async function selectAssistExecutionProvider(
  database: DatabaseConnection,
  context: TenantContext,
  row: AssistExecutionRun,
  input: AssistContext,
): Promise<AssistExecutionProviderRow> {
  if (
    row.promptVersion !== assistPromptVersion(isBenchmarkAssist(input), row.kind === "order_review")
  )
    throw new Error("assist_execution_version_unsupported");
  const { current, grants, provider, route, policy } = await withTenant(
    database.db,
    context,
    async (tx) => {
      const [current] = await tx
        .select({ status: runs.status, expiresAt: runs.expiresAt })
        .from(runs)
        .where(and(eq(runs.id, row.id), eq(runs.ownerId, context.userId)));
      const grants = await tx
        .select({ permissions: roles.permissions, dataScope: roles.dataScope })
        .from(memberships)
        .innerJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
        .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
        .where(and(eq(memberships.userId, context.userId), eq(memberships.status, "active")));
      const [provider] = await tx
        .select()
        .from(modelProviderConfigs)
        .where(
          and(
            eq(modelProviderConfigs.id, row.modelSnapshot.providerConfigId),
            eq(modelProviderConfigs.status, "enabled"),
          ),
        );
      const [route] = await tx
        .select()
        .from(modelRoutes)
        .where(eq(modelRoutes.id, row.modelSnapshot.id));
      const [policy] = await tx.select().from(aiBudgetPolicies);
      return { current, grants, provider, route, policy };
    },
  );
  if (!current || current.status !== "running") throw new Error("assist_interrupted");
  if (current.expiresAt <= new Date()) throw new Error("assist_expired");
  const dataScope = grants.some((grant) => grant.dataScope === "tenant")
    ? "tenant"
    : grants.some((grant) => grant.dataScope === "team")
      ? "team"
      : "self";
  try {
    authorizeAssistRequest(
      {
        ...context,
        dataScope,
        permissions: [...new Set(grants.flatMap((grant) => [...grant.permissions]))],
      },
      input.request,
      "run",
      {
        hasKnowledge: assistUsesReviewedGuidance(input),
        pinnedDataScope: input.accessPolicy?.dataScope ?? "tenant",
      },
    );
  } catch (error) {
    if (error instanceof ForbiddenError) throw new Error("assist_access_changed");
    throw error;
  }
  if (!provider || !["openai", "openai-compatible"].includes(provider.provider))
    throw new Error("assist_provider_unavailable");
  if (
    !route ||
    route.status !== "enabled" ||
    !["studio_text", "studio_analysis"].includes(route.taskType) ||
    route.targets.length !== 1 ||
    route.targets[0]!.providerConfigId !== provider.id ||
    route.targets[0]!.providerModel !== row.modelSnapshot.model
  )
    throw new Error("assist_provider_unavailable");
  if (policy && row.modelSnapshot.maxTaskCostUsd === null)
    throw new Error("assist_pricing_required");
  if (!input.inputAuthority) throw new Error("assist_authority_snapshot_missing");
  try {
    AssistInputAuthoritySchema.parse(input.inputAuthority);
  } catch {
    throw new Error("assist_authority_snapshot_invalid");
  }
  const authorizedContext: TenantContext = {
    ...context,
    dataScope,
    permissions: [...new Set(grants.flatMap((grant) => [...grant.permissions]))],
  };
  await withTenant(
    database.db,
    authorizedContext,
    async (tx) => {
      const binding = assistHarness(
        row.kind,
        !!input.artworkAudit,
        requiredAssistPermissions(row.kind, "run"),
        ASSIST_ACCESS_POLICY_VERSION,
        isBenchmarkAssist(input),
      );
      const method = await assertAgentMethodSelection(
        tx,
        binding.registry.describeSkill(binding.skill),
        input.methodSelection,
      );
      await assertMethodKnowledge(tx, authorizedContext, method.definition);
      const currentBasis = await captureAssistInputAuthority(
        tx,
        authorizedContext,
        input.request,
        await knowledgeExecutionAuthority(
          tx,
          authorizedContext,
          input.knowledge,
          input.request.kind === "knowledge_answer" ? input.request.evidenceStoreId : null,
        ),
      );
      assertAssistInputAuthority(input.inputAuthority!, currentBasis);
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  const harness = assistHarness(
    row.kind,
    !!input.artworkAudit,
    requiredAssistPermissions(row.kind, "run"),
    ASSIST_ACCESS_POLICY_VERSION,
    isBenchmarkAssist(input),
  );
  try {
    harness.registry.checkInput(
      input.executionContract,
      harness.skill,
      harness.toolKey,
      input.request,
    );
  } catch (error) {
    if (error instanceof HarnessContractError) throw new Error("assist_" + error.code);
    throw error;
  }
  return provider;
}
