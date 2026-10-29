import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { assistHarness } from "@yummyai/ai-core";
import { registeredCreativeMethods, registeredPodMethods, supportedPodMethods } from "@yummyai/pod-core";
import { registeredWorkflowMethods } from "@yummyai/workflow-core";
import { registeredOrderDesignMethods, supportedOrderDesignMethods } from "@yummyai/order-design";
import {
  authorize,
  Permission,
  requiredAssistPermissions,
  ASSIST_ACCESS_POLICY_VERSION,
} from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { AssistKindSchema } from "@yummyai/contracts/ai/assist";
import {
  AgentMethodDefinitionSchema,
  AgentMethodHistorySchema,
  AgentMethodWorkspaceSchema,
  AgentMethodActionSchema,
  ChangeAgentMethodSchema,
  SaveAgentMethodSchema,
  AgentMethodSourceQuerySchema,
  AgentMethodSourcesSchema,
  type AgentMethodDefinition,
} from "@yummyai/contracts/harness/methods";
import {
  agentMethods as methods,
  agentMethodVersions as versions,
  agentMethodEvents as events,
  knowledgeVersions,
  knowledgeEntries,
  methodDefinitionChecksum,
  withTenant,
  type DatabaseConnection,
  type TenantTransaction,
} from "@yummyai/database";
import { knowledgeExecutionAuthority } from "@yummyai/knowledge-core";
import { and, asc, desc, eq, gt, ilike, isNull, or, sql } from "drizzle-orm";
import { alias, type PgUpdateSetSource } from "drizzle-orm/pg-core";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";

export function registeredAssistMethods() {
  const original = AssistKindSchema.options.flatMap((kind) =>
    (kind === "artwork_preflight" ? [false, true] : [false]).map((audit) => {
      const bundle = assistHarness(
        kind,
        audit,
        requiredAssistPermissions(kind, "run"),
        ASSIST_ACCESS_POLICY_VERSION,
      );
      return bundle.registry.describeSkill(bundle.skill);
    }),
  );
  const benchmark = assistHarness("knowledge_answer", false, requiredAssistPermissions("knowledge_answer", "run"), ASSIST_ACCESS_POLICY_VERSION, true);
  return [...original, benchmark.registry.describeSkill(benchmark.skill)];
}
const registeredCatalog = [...registeredAssistMethods(), ...registeredWorkflowMethods(), ...registeredPodMethods(), ...registeredOrderDesignMethods(), ...registeredCreativeMethods()];
const supportedCatalog = [...registeredCatalog, ...supportedPodMethods(), ...supportedOrderDesignMethods()];
export function registeredAgentMethods() { return structuredClone(registeredCatalog); }
const view = (row: typeof versions.$inferSelect) => ({
  id: row.id,
  methodId: row.methodId,
  version: row.version,
  checksum: row.checksum,
  definition: row.definition,
  reason: row.reason,
  createdAt: row.createdAt.toISOString(),
});
const commandResult = (event: typeof events.$inferSelect) => ({
  methodId: event.methodId,
  version: event.version,
  revision: event.revision,
  eventId: event.id,
});
function methodKnowledgeReference(source: typeof knowledgeVersions.$inferSelect) {
  return {
    sourceId: `knowledge:${source.id}`,
    entryId: source.entryId,
    versionId: source.id,
    version: source.version,
    title: source.fields.title,
    excerpt: source.fields.body.slice(0, 4000),
    sourceLabel: source.fields.sourceLabel,
    sourceUrl: source.fields.sourceUrl,
    verifiedOn: source.fields.verifiedOn,
    reviewDueOn: source.fields.reviewDueOn,
    checksum: source.checksum,
    href: `/knowledge?entry=${source.entryId}&version=${source.version}`,
    score: 0,
  };
}
async function availability(
  tx: TenantTransaction,
  context: TenantContext,
  version: typeof versions.$inferSelect,
) {
  const issues: string[] = [];
  let supported = true;
  try {
    assertSupported(version.definition);
    if (methodDefinitionChecksum(version.definition) !== version.checksum)
      throw new ConflictException();
  } catch (error) {
    if (!(error instanceof BadRequestException || error instanceof ConflictException)) throw error;
    supported = false;
    issues.push("当前执行版本不支持此方法，请保存并复核新版本");
  }
  const proof = await knowledgeExecutionAuthority(
    tx,
    context,
    version.definition.knowledgeReferences,
  );
  const sourceStates = version.definition.knowledgeReferences.map((ref, index) => ({
    versionId: ref.versionId,
    usable: proof[index]?.count === 1,
  }));
  const sourcesUsable = sourceStates.every((source) => source.usable);
  if (!sourcesUsable) issues.push("引用知识已停用、过期或存在冲突，请核对来源");
  return { supported, sourcesUsable, eligible: supported && sourcesUsable, issues, sourceStates };
}
async function assertSources(
  tx: TenantTransaction,
  context: TenantContext,
  definition: AgentMethodDefinition,
) {
  if (
    (await knowledgeExecutionAuthority(tx, context, definition.knowledgeReferences)).some(
      (row) => row.count !== 1,
    )
  )
    throw new ConflictException("方法知识来源已失效、撤销或存在冲突，请重新核对");
}
function registered(key: string) {
  const method = registeredCatalog.find((row) => row.methodKey === key);
  if (!method) throw new BadRequestException("当前代码不支持该方法，请核对部署版本");
  return structuredClone(method);
}
function assertSupported(definition: AgentMethodDefinition) {
  const current = supportedCatalog.find(method => method.methodKey === definition.methodKey && method.executionContract.checksum === definition.executionContract.checksum);
  if (!current) throw new ConflictException("注册方法已经变化，请创建并复核受支持版本");
  if (
    methodDefinitionChecksum({
      ...current,
      notes: definition.notes,
      knowledgeReferences: definition.knowledgeReferences,
    }) !== methodDefinitionChecksum(definition)
  )
    throw new ConflictException("注册方法已经变化，请创建并复核新版本");
}

@Injectable()
export class MethodGovernanceService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}
  async workspace(context: TenantContext) {
    authorize(context, Permission.WorkflowRead);
    return withTenant(this.database.db, context, async (tx) => {
      const latest = alias(versions, "method_latest"),
        active = alias(versions, "method_active");
      const rows = await tx
        .select({ method: methods, latest, active })
        .from(methods)
        .innerJoin(
          latest,
          and(eq(latest.methodId, methods.id), eq(latest.version, methods.latestVersion)),
        )
        .leftJoin(
          active,
          and(eq(active.methodId, methods.id), eq(active.version, methods.activeVersion)),
        )
        .orderBy(desc(methods.updatedAt))
        .limit(101);
      if (rows.length > 100) throw new ConflictException("方法超过当前工作台容量，请联系维护人");
      const methodRows = [];
      for (const { method, latest: recent, active: enabled } of rows)
        methodRows.push({
          ...method,
          adoptedAt: method.adoptedAt?.toISOString() ?? null,
          disabledAt: method.disabledAt?.toISOString() ?? null,
          latest: view(recent),
          active: enabled ? view(enabled) : null,
          latestAvailability: await availability(tx, context, recent),
          activeAvailability: enabled ? await availability(tx, context, enabled) : null,
        });
      return AgentMethodWorkspaceSchema.parse({
        catalog: registeredAgentMethods(),
        methods: methodRows,
        canManage: context.permissions.includes(Permission.WorkflowManage),
        canPublish: context.permissions.includes(Permission.WorkflowApprove),
      });
    });
  }
  async sources(context: TenantContext, raw: unknown) {
    authorize(context, Permission.WorkflowRead);
    const parsed = AgentMethodSourceQuerySchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException("来源查询参数无效");
    const input = parsed.data,
      needle = `%${input.query.replace(/[\\%_]/g, "\\$&")}%`;
    return withTenant(
      this.database.db,
      context,
      async (tx) => {
        const rows = await tx
          .select({ version: knowledgeVersions })
          .from(knowledgeEntries)
          .innerJoin(
            knowledgeVersions,
            and(
              eq(knowledgeVersions.entryId, knowledgeEntries.id),
              eq(knowledgeVersions.version, knowledgeEntries.activeVersion),
            ),
          )
          .where(
            and(
              isNull(knowledgeEntries.archivedAt),
              isNull(knowledgeVersions.scopeSpuId),
              sql`${knowledgeVersions.fields}->>'platform'='all'`,
              sql`${knowledgeVersions.fields}->>'market'='ALL'`,
              input.after ? gt(knowledgeEntries.id, input.after) : undefined,
              input.query
                ? or(
                    ilike(sql`${knowledgeVersions.fields}->>'title'`, needle),
                    ilike(sql`${knowledgeVersions.fields}->>'summary'`, needle),
                  )
                : undefined,
            ),
          )
          .orderBy(asc(knowledgeEntries.id))
          .limit(51);
        const choices = [];
        for (const { version } of rows.slice(0, 50)) {
          const ref = methodKnowledgeReference(version),
            proof = await knowledgeExecutionAuthority(tx, context, [ref]),
            usable = proof[0]?.count === 1;
          choices.push({ ...ref, usable, issues: usable ? [] : ["来源已过期、失效或存在冲突"] });
        }
        return AgentMethodSourcesSchema.parse({
          choices,
          nextCursor: rows.length > 50 ? rows[49]!.version.entryId : null,
        });
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }
  async history(context: TenantContext, id: string) {
    authorize(context, Permission.WorkflowRead);
    return withTenant(this.database.db, context, async (tx) => {
      if (!(await tx.select({ id: methods.id }).from(methods).where(eq(methods.id, id)))[0])
        throw new NotFoundException("方法不存在");
      const history = await tx
        .select()
        .from(versions)
        .where(eq(versions.methodId, id))
        .orderBy(desc(versions.version))
        .limit(1001);
      const changes = await tx
        .select()
        .from(events)
        .where(eq(events.methodId, id))
        .orderBy(desc(events.revision))
        .limit(5001);
      if (history.length > 1000 || changes.length > 5000)
        throw new ConflictException("历史超过当前读取容量，请联系维护人");
      return AgentMethodHistorySchema.parse({
        versions: history.map(view),
        events: changes.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      });
    });
  }
  async save(context: TenantContext, raw: unknown) {
    authorize(context, Permission.WorkflowRead);
    authorize(context, Permission.WorkflowManage);
    const parsed = SaveAgentMethodSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException("方法参数无效；执行内容由服务端注册表解析");
    const input = parsed.data,
      code = registered(input.methodKey),
      requestChecksum = methodDefinitionChecksum({ action: "save", ...input });
    return withTenant(this.database.db, context, async (tx) => {
      await this.lock(tx, context, input.methodKey, input.requestId);
      const replay = await this.replay(tx, input.requestId, requestChecksum);
      if (replay) return replay;
      const [method] = await tx
        .select()
        .from(methods)
        .where(eq(methods.methodKey, input.methodKey))
        .for("update");
      if ((method?.revision ?? 0) !== input.expectedRevision)
        throw new ConflictException("方法已有新版本，请刷新后重试");
      const references = [];
      for (const id of input.knowledgeVersionIds) {
        const [source] = await tx
          .select()
          .from(knowledgeVersions)
          .where(eq(knowledgeVersions.id, id));
        if (
          !source ||
          source.fields.platform !== "all" ||
          source.fields.market !== "ALL" ||
          source.scopeSpuId !== null
        )
          throw new BadRequestException(
            "方法通用依据须来自当前组织已发布的通用知识；店铺或产品资料请在具体任务中选择",
          );
        references.push(methodKnowledgeReference(source));
      }
      const definition = AgentMethodDefinitionSchema.parse({
        ...code,
        notes: input.notes,
        knowledgeReferences: references,
      });
      if (Buffer.byteLength(JSON.stringify(definition)) > 65536)
        throw new BadRequestException("方法及来源超过保存上限，请减少补充说明或引用");
      await assertSources(tx, context, definition);
      const id = method?.id ?? createEntityId(),
        version = (method?.latestVersion ?? 0) + 1,
        revision = (method?.revision ?? 0) + 1;
      if (method)
        await tx
          .update(methods)
          .set({
            revision,
            latestVersion: version,
            state: "draft",
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(methods.id, id));
      else
        await tx.insert(methods).values({
          id,
          tenantId: context.tenantId,
          methodKey: input.methodKey,
          createdBy: context.userId,
        });
      await tx.insert(versions).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        methodId: id,
        version,
        definition,
        checksum: methodDefinitionChecksum(definition),
        reason: input.reason,
        requestId: input.requestId,
        requestChecksum,
        createdBy: context.userId,
      });
      const [event] = await tx
        .insert(events)
        .values({
          id: createEntityId(),
          tenantId: context.tenantId,
          methodId: id,
          version,
          revision,
          action: method ? "revise" : "create",
          reason: input.reason,
          requestId: input.requestId,
          requestChecksum,
          createdBy: context.userId,
        })
        .returning();
      await this.audit.recordInTransaction(tx, context, {
        action: "agent_method.save",
        resourceType: "agent_method",
        resourceId: id,
        result: "success",
        metadata: { version },
      });
      return commandResult(event!);
    });
  }
  async transition(context: TenantContext, id: string, action: unknown, raw: unknown) {
    const parsedAction = AgentMethodActionSchema.safeParse(action),
      parsed = ChangeAgentMethodSchema.safeParse(raw);
    if (!parsedAction.success || !parsed.success) throw new BadRequestException("方法变更参数无效");
    authorize(context, Permission.WorkflowRead);
    authorize(
      context,
      ["publish", "reject", "disable"].includes(parsedAction.data)
        ? Permission.WorkflowApprove
        : Permission.WorkflowManage,
    );
    const input = parsed.data,
      operation = parsedAction.data,
      requestChecksum = methodDefinitionChecksum({ id, operation, ...input });
    return withTenant(this.database.db, context, async (tx) => {
      await this.lock(tx, context, id, input.requestId);
      const replay = await this.replay(tx, input.requestId, requestChecksum);
      if (replay) return replay;
      const [method] = await tx.select().from(methods).where(eq(methods.id, id)).for("update");
      if (!method) throw new NotFoundException("方法不存在");
      if (
        method.revision !== input.expectedRevision ||
        (operation === "disable" ? method.activeVersion : method.latestVersion) !== input.version
      )
        throw new ConflictException("方法或启用状态已经变化，请刷新复核");
      const [version] = await tx
        .select()
        .from(versions)
        .where(and(eq(versions.methodId, id), eq(versions.version, input.version)));
      if (!version) throw new ConflictException("方法版本不可用");
      const revision = method.revision + 1;
      const update: PgUpdateSetSource<typeof methods> = {
        revision,
        updatedAt: sql`clock_timestamp()`,
      };
      if (operation === "submit") {
        if (method.state === "in_review" || (method.state === "published" && !method.disabledAt))
          throw new ConflictException("当前版本无需重复提交");
        assertSupported(version.definition);
        await assertSources(tx, context, version.definition);
        update.state = "in_review";
      } else if (operation === "publish") {
        if (method.state !== "in_review" || input.reviewedChecksum !== version.checksum)
          throw new ConflictException("请先提交并复核当前版本的完整差异");
        assertSupported(version.definition);
        await assertSources(tx, context, version.definition);
        update.state = "published";
        update.activeVersion = input.version;
        update.disabledAt = null;
        if (!method.adoptedAt) update.adoptedAt = sql`clock_timestamp()`;
      } else if (operation === "reject") {
        if (method.state !== "in_review") throw new ConflictException("当前版本不在审核中");
        update.state = "draft";
      } else {
        if (!method.adoptedAt || method.activeVersion === null)
          throw new ConflictException("方法尚未启用");
        update.activeVersion = null;
        update.disabledAt = sql`clock_timestamp()`;
        update.withdrawalGeneration = method.withdrawalGeneration + 1;
      }
      await tx.update(methods).set(update).where(eq(methods.id, id));
      const [event] = await tx
        .insert(events)
        .values({
          id: createEntityId(),
          tenantId: context.tenantId,
          methodId: id,
          version: input.version,
          revision,
          action: operation,
          reason: input.reason,
          requestId: input.requestId,
          requestChecksum,
          createdBy: context.userId,
        })
        .returning();
      await this.audit.recordInTransaction(tx, context, {
        action: `agent_method.${operation}`,
        resourceType: "agent_method",
        resourceId: id,
        result: "success",
        metadata: { version: input.version },
      });
      return commandResult(event!);
    });
  }
  private async lock(
    tx: TenantTransaction,
    context: TenantContext,
    key: string,
    requestId: string,
  ) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`method-request:${context.tenantId}:${requestId}`},0))`,
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`method:${context.tenantId}:${key}`},0))`,
    );
  }
  private async replay(tx: TenantTransaction, requestId: string, checksum: string) {
    const [event] = await tx.select().from(events).where(eq(events.requestId, requestId));
    if (!event) return null;
    if (event.requestChecksum !== checksum)
      throw new ConflictException("同一请求不能更换方法参数或操作");
    return commandResult(event);
  }
}
