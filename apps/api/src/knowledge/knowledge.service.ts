import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  ChangeKnowledgeSchema,
  KnowledgeFieldsSchema,
  KnowledgeHistorySchema,
  KnowledgeVersionSchema,
  KnowledgeWorkspaceSchema,
  SaveKnowledgeSchema,
  type KnowledgeAction,
} from "@yummyai/contracts/knowledge";
import {
  knowledgeEntries as entries,
  knowledgeVersions as versions,
  knowledgeEvents as events,
  spus,
  productPlans,
  knowledgeDocuments,
  knowledgeSourceSnapshots,
  knowledgeEvidenceLinks,
  type TenantTransaction,
  withTenant,
  type DatabaseConnection,
} from "@yummyai/database";
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { AuditService } from "../audit/audit.service.js";
import {
  knowledgeEvidenceIssues,
  knowledgeBlockingConflicts,
  recordKnowledgeConflicts,
  redactKnowledgeText,
  KnowledgeSearchOwner,
  KnowledgeSearchOwnerError,
} from "@yummyai/knowledge-core";
import { knowledgeToday } from "./knowledge-retriever.js";

const checksum = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function view(row: typeof versions.$inferSelect) {
  return KnowledgeVersionSchema.parse({
    ...row.fields,
    id: row.id,
    entryId: row.entryId,
    version: row.version,
    checksum: row.checksum,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  });
}
@Injectable()
export class KnowledgeService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async workspace(context: TenantContext) {
    authorize(context, Permission.WorkflowRead);
    return withTenant(this.database.db, context, async (tx) => {
      const visible = context.permissions.includes(Permission.ProductRead)
        ? undefined
        : sql`NOT EXISTS (
        SELECT 1 FROM ${versions} WHERE ${versions.entryId}=${entries.id} AND ${versions.scopeSpuId} IS NOT NULL)`;
      const latest = alias(versions, "knowledge_latest");
      const active = alias(versions, "knowledge_active");
      const rows = await tx
        .select({ entry: entries, latest, active })
        .from(entries)
        .innerJoin(
          latest,
          and(eq(latest.entryId, entries.id), eq(latest.version, entries.latestVersion)),
        )
        .leftJoin(
          active,
          and(eq(active.entryId, entries.id), eq(active.version, entries.activeVersion)),
        )
        .where(and(isNull(entries.archivedAt), visible))
        .orderBy(desc(entries.updatedAt), desc(entries.id))
        .limit(501);
      if (rows.length > 500)
        throw new BadRequestException("知识超过 500 条，请先归档不再使用的内容");
      const products = context.permissions.includes(Permission.ProductRead)
        ? await tx
            .select({ id: spus.id, code: spus.code, name: spus.name })
            .from(spus)
            .innerJoin(productPlans, eq(productPlans.id, spus.productPlanId))
            .where(and(sql`${spus.status}<>'archived'`, sql`${productPlans.status}<>'archived'`))
            .orderBy(asc(spus.code))
        : [];
      return KnowledgeWorkspaceSchema.parse({
        entries: rows.map(({ entry, latest: latestVersion, active: activeVersion }) => ({
          ...entry,
          updatedAt: entry.updatedAt.toISOString(),
          archivedAt: entry.archivedAt?.toISOString() ?? null,
          latest: view(latestVersion),
          active: activeVersion ? view(activeVersion) : null,
        })),
        spus: products,
        canManage: context.permissions.includes(Permission.WorkflowManage),
        canPublish: context.permissions.includes(Permission.WorkflowApprove),
      });
    });
  }
  async history(context: TenantContext, id: string) {
    authorize(context, Permission.WorkflowRead);
    return withTenant(this.database.db, context, async (tx) => {
      if (!(await tx.select({ id: entries.id }).from(entries).where(eq(entries.id, id)))[0])
        throw new NotFoundException("知识不存在");
      const history = await tx
        .select()
        .from(versions)
        .where(eq(versions.entryId, id))
        .orderBy(desc(versions.version));
      if (history.some((version) => version.scopeSpuId)) authorize(context, Permission.ProductRead);
      const changes = await tx
        .select()
        .from(events)
        .where(eq(events.entryId, id))
        .orderBy(desc(events.createdAt), desc(events.id));
      return KnowledgeHistorySchema.parse({
        versions: history.map(view),
        events: changes.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      });
    });
  }
  async save(context: TenantContext, id: string | null, raw: unknown) {
    return withTenant(this.database.db, context, (tx) =>
      this.saveInTransaction(tx, context, id, raw),
    );
  }
  async saveInTransaction(
    tx: TenantTransaction,
    context: TenantContext,
    id: string | null,
    raw: unknown,
  ) {
    authorize(context, Permission.WorkflowManage);
    const input = SaveKnowledgeSchema.parse(raw),
      digest = checksum({ id, input });
    const text = [input.fields.title, input.fields.summary, input.fields.body].join("\n");
    if (redactKnowledgeText(text).text !== text)
      throw new BadRequestException(
        "知识正文含可识别的身份或凭证信息，请先移除；账户报告请使用脱敏证据入口",
      );
    {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`knowledge:${context.tenantId}:${input.requestId}`},0))`,
      );
      const [prior] = await tx
        .select()
        .from(versions)
        .where(eq(versions.requestId, input.requestId));
      if (prior) {
        if (prior.requestChecksum !== digest)
          throw new ConflictException("同一保存请求的内容已变化，请重新保存");
        return { id: prior.entryId, version: prior.version };
      }
      if (
        (
          await tx
            .select({ id: events.id })
            .from(events)
            .where(eq(events.requestId, input.requestId))
        )[0]
      )
        throw new ConflictException("该请求标识已用于其他知识操作");
      if (input.fields.spuId) {
        authorize(context, Permission.ProductRead);
        if (
          !(
            await tx
              .select({ id: spus.id })
              .from(spus)
              .innerJoin(productPlans, eq(productPlans.id, spus.productPlanId))
              .where(
                and(
                  eq(spus.id, input.fields.spuId),
                  sql`${spus.status}<>'archived'`,
                  sql`${productPlans.status}<>'archived'`,
                ),
              )
          )[0]
        )
          throw new NotFoundException("适用 SPU 不存在或已归档");
      }
      for (const documentId of input.fields.documentIds ?? []) {
        const [document] = await tx
          .select()
          .from(knowledgeDocuments)
          .where(eq(knowledgeDocuments.id, documentId));
        if (!document || document.kind !== "reference" || document.state !== "confirmed")
          throw new BadRequestException("仅可关联本租户已确认的参考资料，账户证据有独立入口");
        if (document.fields.spuId) authorize(context, Permission.ProductRead);
      }
      for (const snapshotId of input.fields.sourceSnapshotIds ?? []) {
        if (
          !(
            await tx
              .select({ id: knowledgeSourceSnapshots.id })
              .from(knowledgeSourceSnapshots)
              .where(eq(knowledgeSourceSnapshots.id, snapshotId))
          )[0]
        )
          throw new NotFoundException("来源快照不存在");
      }
      const entryId = id ?? createEntityId();
      let version = 1;
      if (id) {
        const [current] = await tx.select().from(entries).where(eq(entries.id, id)).for("update");
        if (!current || current.archivedAt) throw new NotFoundException("知识不存在或已归档");
        if (
          !context.permissions.includes(Permission.ProductRead) &&
          (
            await tx
              .select({ id: versions.id })
              .from(versions)
              .where(and(eq(versions.entryId, id), isNotNull(versions.scopeSpuId)))
              .limit(1)
          )[0]
        )
          authorize(context, Permission.ProductRead);
        if (current.revision !== input.expectedRevision)
          throw new ConflictException("知识已更新，请刷新后重新编辑");
        version = current.latestVersion + 1;
        await tx
          .update(entries)
          .set({
            latestVersion: version,
            state: "draft",
            revision: current.revision + 1,
            updatedAt: new Date(),
          })
          .where(eq(entries.id, id));
      } else {
        if (input.expectedRevision !== 0) throw new ConflictException("新知识不能带历史修订号");
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`knowledge-cap:${context.tenantId}`},0))`,
        );
        const [size] = await tx
          .select({ total: sql<number>`count(*)::integer` })
          .from(entries)
          .where(isNull(entries.archivedAt));
        if (size!.total >= 500)
          throw new BadRequestException("知识已达到 500 条，请先归档不再使用的内容");
        await tx
          .insert(entries)
          .values({ id: entryId, tenantId: context.tenantId, createdBy: context.userId });
      }
      const [savedVersion] = await tx
        .insert(versions)
        .values({
          id: createEntityId(),
          tenantId: context.tenantId,
          entryId,
          version,
          fields: input.fields,
          scopeSpuId: input.fields.spuId,
          checksum: checksum(input.fields),
          reason: input.reason,
          requestId: input.requestId,
          requestChecksum: digest,
          createdBy: context.userId,
        })
        .returning();
      for (const documentId of input.fields.documentIds ?? [])
        await tx
          .insert(knowledgeEvidenceLinks)
          .values({
            id: createEntityId(),
            tenantId: context.tenantId,
            versionId: savedVersion!.id,
            documentId,
          });
      for (const snapshotId of input.fields.sourceSnapshotIds ?? [])
        await tx
          .insert(knowledgeEvidenceLinks)
          .values({
            id: createEntityId(),
            tenantId: context.tenantId,
            versionId: savedVersion!.id,
            snapshotId,
          });
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${"knowledge-governance:" + context.tenantId},0))`,
      );
      await recordKnowledgeConflicts(tx, context.tenantId, savedVersion!);
      await tx.insert(events).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        entryId,
        version,
        action: id ? "revise" : "create",
        reason: input.reason,
        requestId: input.requestId,
        requestChecksum: digest,
        createdBy: context.userId,
      });
      await this.audit.recordInTransaction(tx, context, {
        action: "knowledge.save",
        resourceType: "knowledge",
        resourceId: entryId,
        result: "success",
        metadata: { version },
      });
      return { id: entryId, version };
    }
  }
  async change(
    context: TenantContext,
    id: string,
    action: Exclude<KnowledgeAction, "create" | "revise">,
    raw: unknown,
  ) {
    authorize(
      context,
      action === "submit" || action === "archive"
        ? Permission.WorkflowManage
        : Permission.WorkflowApprove,
    );
    const input = ChangeKnowledgeSchema.parse(raw),
      digest = checksum({ id, action, input });
    return withTenant(this.database.db, context, async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`knowledge:${context.tenantId}:${input.requestId}`},0))`,
      );
      const [prior] = await tx.select().from(events).where(eq(events.requestId, input.requestId));
      if (prior) {
        if (prior.requestChecksum !== digest)
          throw new ConflictException("同一操作请求的内容已变化");
        return { id };
      }
      const [current] = await tx.select().from(entries).where(eq(entries.id, id)).for("update");
      if (!current || current.archivedAt) throw new NotFoundException("知识不存在或已归档");
      if (
        !context.permissions.includes(Permission.ProductRead) &&
        (
          await tx
            .select({ id: versions.id })
            .from(versions)
            .where(and(eq(versions.entryId, id), isNotNull(versions.scopeSpuId)))
            .limit(1)
        )[0]
      )
        authorize(context, Permission.ProductRead);
      if (
        current.revision !== input.expectedRevision ||
        (action === "disable" ? current.activeVersion : current.latestVersion) !== input.version
      )
        throw new ConflictException("知识版本或状态已更新，请刷新");
      if (
        (action === "submit" && current.state !== "draft") ||
        ((action === "publish" || action === "reject") && current.state !== "in_review")
      )
        throw new ConflictException("请先保存草稿并提交审核");
      if (action === "archive" && current.activeVersion)
        authorize(context, Permission.WorkflowApprove);
      if (action === "publish") {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${"knowledge-governance:" + context.tenantId},0))`,
        );
        const [version] = await tx
          .select()
          .from(versions)
          .where(and(eq(versions.entryId, id), eq(versions.version, input.version)));
        const fields = KnowledgeFieldsSchema.parse(version!.fields),
          today = knowledgeToday();
        if (fields.verifiedOn > today || fields.reviewDueOn < today)
          throw new ConflictException("核对日期在未来或知识已到复查期，请修订后审核");
        const issues = await knowledgeEvidenceIssues(tx, fields);
        if (issues.length) throw new ConflictException(issues.join("；"));
        if ((await knowledgeBlockingConflicts(tx, version!.id)).length)
          throw new ConflictException("存在尚未裁决的阻断级主张冲突，请先处理冲突风险");
      }
      await tx
        .update(entries)
        .set({
          revision: current.revision + 1,
          updatedAt: new Date(),
          ...(action === "submit"
            ? { state: "in_review" as const }
            : action === "publish"
              ? { state: "published" as const, activeVersion: input.version }
              : action === "reject"
                ? { state: "draft" as const }
                : action === "disable"
                  ? {
                      activeVersion: null,
                      state: current.state === "published" ? ("draft" as const) : current.state,
                    }
                  : { activeVersion: null, archivedAt: new Date() }),
        })
        .where(eq(entries.id, id));
      await tx.insert(events).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        entryId: id,
        version: input.version,
        action,
        reason: input.reason,
        requestId: input.requestId,
        requestChecksum: digest,
        createdBy: context.userId,
      });
      await this.audit.recordInTransaction(tx, context, {
        action: `knowledge.${action}`,
        resourceType: "knowledge",
        resourceId: id,
        result: "success",
        metadata: { version: input.version },
      });
      return { id };
    });
  }
  async search(context: TenantContext, raw: unknown) {
    try { return await new KnowledgeSearchOwner(this.database).search(context, raw); }
    catch (error) {
      if (error instanceof KnowledgeSearchOwnerError) throw new NotFoundException(error.body);
      throw error;
    }
  }
}
