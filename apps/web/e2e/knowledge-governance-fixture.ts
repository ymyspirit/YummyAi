import { Permission } from "../../../packages/authz/src/index";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { AssistResultSchema, type AssistView } from "@yummyai/contracts/ai/assist";
import {
  connectDatabase,
  withTenant,
  modelProviderConfigs,
  marketplaceAccounts,
  knowledgeSources,
  memberships,
  membershipRoles,
  roles,
  type DatabaseConnection,
} from "@yummyai/database";
import {
  createEnvironmentSecretVault,
  OpenAiCompatibleProvider,
} from "../../../packages/ai-core/src/index";
import { JobEnvelopeSchema } from "../../../packages/jobs/src/index";
import { and, eq } from "drizzle-orm";
import { checkKnowledgeSource } from "../../../packages/knowledge-core/src/sources";
import { AiAssistProcessor, assistPricing } from "../../worker/src/processors/ai-assist.processor";
import { centerApi } from "./order-centers-fixture";
import { getApiHeaders } from "../src/server-api";

/** Only the external source/model transport is synthetic. API, RLS, input pins,
 * assistant processor, budgets and browser interactions are the real paths. */
export async function knowledgeGovernanceFixture(
  modelSuffix = "",
  hooks: {
    onModelRequest?: (request: Record<string, unknown>) => void;
    beforeModelResponse?: () => Promise<void>;
  } = {},
) {
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
  if (
    process.env.E2E_ISOLATED_DAILY !== "1" ||
    !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(url.pathname)
  )
    throw new Error("Knowledge fixtures require the disposable acceptance runner");
  const database: DatabaseConnection = connectDatabase(url.href);
  const headers = await getApiHeaders();
  const claims = JSON.parse(
    Buffer.from(headers.authorization!.split(".")[1]!, "base64url").toString(),
  ) as { sub: string };
  const [identity] = await database.client.unsafe<{ tenant_id: string; user_id: string }[]>(
    "select m.tenant_id,m.user_id from memberships m join app_users u on u.id=m.user_id where u.oidc_subject=$1 and m.status='active'",
    [claims.sub],
  );
  if (!identity) {
    await database.client.end();
    throw new Error("Fixture identity unavailable");
  }
  const context: TenantContext = {
    tenantId: identity.tenant_id,
    userId: identity.user_id,
    permissions: Object.values(Permission),
    dataScope: "tenant",
  };
  try {
    const originalRoles = await withTenant(database.db, context, (tx) =>
      tx
        .select({ id: roles.id, dataScope: roles.dataScope, permissions: roles.permissions })
        .from(roles)
        .innerJoin(membershipRoles, eq(membershipRoles.roleId, roles.id))
        .innerJoin(memberships, eq(memberships.id, membershipRoles.membershipId))
        .where(and(eq(memberships.userId, context.userId), eq(memberships.status, "active"))),
    );
    const [provider] = await withTenant(database.db, context, (tx) =>
      tx
        .select()
        .from(modelProviderConfigs)
        .where(eq(modelProviderConfigs.label, "Synthetic acceptance only")),
    );
    if (!provider) throw new Error("Synthetic provider unavailable");
    const modelId = (
      await centerApi<{ id: string }>("ai-assists/models", {
        providerConfigId: provider.id,
        model: `synthetic-knowledge-answer${modelSuffix ? `-${modelSuffix}` : ""}`,
        label: modelSuffix ? `Synthetic ${modelSuffix} browser` : "Synthetic knowledge browser",
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
        maxTaskCostUsd: 1,
      })
    ).id;
    const storeId = createEntityId();
    await withTenant(database.db, context, (tx) =>
      tx.insert(marketplaceAccounts).values({
        id: storeId,
        tenantId: context.tenantId,
        platform: "amazon",
        displayName: modelSuffix ? `Synthetic ${modelSuffix} shop` : "Synthetic knowledge shop",
        region: "NA",
        authorizationMode: "amazon_private",
        createdBy: context.userId,
      }),
    );
    let output: unknown = {};
    let modelCalls = 0;
    const processor = new AiAssistProcessor(
      database,
      createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:model-config"),
      createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist"),
      (row, key, task) =>
        new OpenAiCompatibleProvider({
          providerId: row.id,
          endpoint: "https://synthetic-knowledge.invalid/v1",
          apiKey: key,
          pricing: assistPricing(task.modelSnapshot),
          fetch: async (_url, init) => {
            modelCalls++;
            hooks.onModelRequest?.(JSON.parse(String(init?.body)));
            await hooks.beforeModelResponse?.();
            return Response.json({
              choices: [{ message: { content: JSON.stringify(output) } }],
              usage: { prompt_tokens: 50, completion_tokens: 80 },
            });
          },
        }),
    );
    return {
      modelId,
      modelCalls: () => modelCalls,
      storeId,
      async setPermissions(allowed: readonly string[]) {
        await withTenant(database.db, context, async (tx) => {
          for (const role of originalRoles)
            await tx
              .update(roles)
              .set({ permissions: role.permissions.filter((value) => allowed.includes(value)) })
              .where(eq(roles.id, role.id));
        });
      },
      async setDataScope(dataScope: TenantContext["dataScope"]) {
        await withTenant(database.db, context, async (tx) => {
          for (const role of originalRoles)
            await tx.update(roles).set({ dataScope }).where(eq(roles.id, role.id));
        });
      },
      async analyze(id: string, result: unknown) {
        output = AssistResultSchema.parse(result);
        await processor.process(
          JobEnvelopeSchema.parse({
            jobId: createEntityId(),
            tenantId: context.tenantId,
            requestedBy: context.userId,
            correlationId: id,
            idempotencyKey: createEntityId(),
            payload: { runId: id, operation: "analyze" },
          }),
        );
      },
      async sourceSnapshot(id: string, body: string) {
        await withTenant(database.db, context, (tx) =>
          tx
            .update(knowledgeSources)
            .set({ lastCheckedAt: null })
            .where(eq(knowledgeSources.id, id)),
        );
        return checkKnowledgeSource(database, context, id, async (value) => ({ url: value, body }));
      },
      async answer(id: string) {
        const run = await centerApi<AssistView>("ai-assists/runs/" + id);
        const ref = run.knowledge[0];
        output = AssistResultSchema.parse(
          ref
            ? {
                summary: "先核对资料并保留复核记录。",
                findings: [
                  {
                    title: "核对流程",
                    detail: "先核对资料并保留复核记录。",
                    kind: "fact",
                    severity: "info",
                    evidence: [{ sourceId: ref.sourceId, detail: "本次固定的审核知识段落" }],
                    location: null,
                  },
                ],
                directions: [],
                matches: [],
                missingInformation: [],
              }
            : {
                summary: "没有有效依据，无法回答。",
                findings: [],
                directions: [],
                matches: [],
                missingInformation: ["请补充审核知识"],
              },
        );
        await processor.process(
          JobEnvelopeSchema.parse({
            jobId: createEntityId(),
            tenantId: context.tenantId,
            requestedBy: context.userId,
            correlationId: id,
            idempotencyKey: createEntityId(),
            payload: { runId: id, operation: "analyze" },
          }),
        );
      },
      async close() {
        try {
          await withTenant(database.db, context, async (tx) => {
            for (const role of originalRoles)
              await tx
                .update(roles)
                .set({ dataScope: role.dataScope, permissions: role.permissions })
                .where(eq(roles.id, role.id));
          });
        } finally {
          await database.client.end();
        }
      },
    };
  } catch (error) {
    await database.client.end();
    throw error;
  }
}
