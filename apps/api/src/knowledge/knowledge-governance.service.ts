import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { authorize, ForbiddenError, Permission } from "@yummyai/authz";
import { catalogOwnerFilter } from "@yummyai/catalog-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  KnowledgeGovernanceViewSchema,
  ReviewKnowledgeSourceSchema,
  SaveKnowledgeNeedSchema,
  SaveKnowledgeSourceSchema,
  ResolveKnowledgeConflictSchema,
  SaveKnowledgeEvaluationSchema,
  ArchiveKnowledgeEvaluationSchema,
} from "@yummyai/contracts/knowledge/governance";
import {
  knowledgeDocuments as documents,
  knowledgeSources as sources,
  knowledgeSourceSnapshots as snapshots,
  knowledgeSourceReviews as reviews,
  knowledgeNeeds as needs,
  knowledgeConflicts as conflicts,
  knowledgeEvaluationCases as evaluations,
  knowledgeVersions as versions,
  knowledgeEntries as entries,
  knowledgeGovernanceEvents as events,
  marketplaceAccounts as stores,
  withTenant,
  type DatabaseConnection,
  type TenantTransaction,
} from "@yummyai/database";
import {
  knowledgeChecksum,
  knowledgeDay,
  knowledgeOfficialUrl,
  checkKnowledgeSource,
  knowledgeScopeMatches,
  knowledgeEvidenceIssues,
  knowledgeBlockingConflicts,
  currentEvaluationContext,
} from "@yummyai/knowledge-core";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { KnowledgeService } from "./knowledge.service.js";
import { recordKnowledgeGovernanceEvent } from "./knowledge-import.service.js";
import {
  assertKnowledgeAccountScope, assertKnowledgeScope, currentKnowledgeContext,
  knowledgeAccountScopeFilter, knowledgeEntryIdsScopeFilter, knowledgeProductScopeFilter,
  knowledgeSearchScopeFilter, knowledgeVersionScopeFilter,
} from "./knowledge-scope.js";

@Injectable()
export class KnowledgeGovernanceService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(KnowledgeService) private readonly knowledge: KnowledgeService,
  ) {}
  async workspace(context: TenantContext) {
    authorize(context, Permission.WorkflowRead);
    return withTenant(this.database.db, context, async (tx) => {
      context = await currentKnowledgeContext(tx, context, Permission.WorkflowRead);
      const cards = await this.knowledge.workspaceInTransaction(tx, context);
      const canReadAccount = context.permissions.includes(Permission.FinanceRead) && context.permissions.includes(Permission.StoreRead);
      const docs = await tx
        .select()
        .from(documents)
        .where(
          and(
            sql`${documents.state}<>'archived'`,
            canReadAccount ? undefined : eq(documents.kind, "reference"),
            or(eq(documents.kind, "reference"), knowledgeAccountScopeFilter(context, documents.createdBy, documents.storeId)),
            knowledgeProductScopeFilter(context, sql`${documents.fields}->>'spuId'`),
          ),
        )
        .orderBy(desc(documents.createdAt))
        .limit(200);
      const sourceRows = await tx
        .select()
        .from(sources)
        .where(isNull(sources.archivedAt))
        .orderBy(desc(sources.createdAt))
        .limit(200);
      const reviewRows = await tx
        .select()
        .from(reviews)
        .where(knowledgeEntryIdsScopeFilter(context, reviews.entryIds))
        .orderBy(desc(reviews.createdAt))
        .limit(100);
      const snapIds = [
        ...new Set(
          [
            ...sourceRows.map((s) => s.latestSnapshotId),
            ...reviewRows.flatMap((r) => [r.beforeSnapshotId, r.afterSnapshotId]),
          ].filter((s): s is string => !!s),
        ),
      ];
      const evidence = snapIds.length
        ? await tx.select().from(snapshots).where(inArray(snapshots.id, snapIds))
        : [];
      const snapshotMap = new Map(evidence.map((s) => [s.id, s]));
      const conflictRows = await tx
        .select()
        .from(conflicts)
        .where(and(knowledgeVersionScopeFilter(context, conflicts.leftVersionId), knowledgeVersionScopeFilter(context, conflicts.rightVersionId)))
        .orderBy(desc(conflicts.createdAt))
        .limit(500);
      const conflictVersionIds = [
        ...new Set(conflictRows.flatMap((r) => [r.leftVersionId, r.rightVersionId])),
      ];
      const conflictVersions = conflictVersionIds.length
        ? await tx.select().from(versions).where(inArray(versions.id, conflictVersionIds))
        : [];
      const versionMap = new Map(conflictVersions.map((v) => [v.id, v]));
      const visibleIds = new Set(cards.entries.map((e) => e.id));
      const conflictViews = conflictRows.flatMap((r) => {
        const l = versionMap.get(r.leftVersionId),
          v = versionMap.get(r.rightVersionId);
        if (!l || !v || !visibleIds.has(l.entryId) || !visibleIds.has(v.entryId)) return [];
        const a = l.fields.claims?.find((c) => c.key.toLowerCase() === r.key.toLowerCase()),
          b = v.fields.claims?.find((c) => c.key.toLowerCase() === r.key.toLowerCase());
        if (!a || !b) return [];
        return [
          {
            ...r,
            leftEntryId: l.entryId,
            rightEntryId: v.entryId,
            leftTitle: l.fields.title + " v" + l.version,
            rightTitle: v.fields.title + " v" + v.version,
            leftValue: a.value + " " + a.unit,
            rightValue: b.value + " " + b.unit,
            leftCondition: a.condition + "（" + a.validFrom + "–" + a.validUntil + "）",
            rightCondition: b.condition + "（" + b.validFrom + "–" + b.validUntil + "）",
            leftSource: l.fields.sourceLabel,
            rightSource: v.fields.sourceLabel,
          },
        ];
      });
      const requirements = await tx
        .select()
        .from(needs)
        .where(and(isNull(needs.archivedAt), knowledgeSearchScopeFilter(context, needs.searchScope), knowledgeEntryIdsScopeFilter(context, needs.entryIds)))
        .orderBy(desc(needs.createdAt))
        .limit(500);
      const coverage = [];
      for (const need of requirements) {
        if (need.searchScope.spuIds.length && !context.permissions.includes(Permission.ProductRead))
          continue;
        const related = cards.entries.filter((c) => need.entryIds.includes(c.id));
        let status:
          "covered" | "missing" | "expired" | "in_review" | "scope_mismatch" | "conflict" =
          "missing";
        const reasons: string[] = [];
        let anyInScope = false,
          expired = false,
          pending = false,
          risk = false,
          covered = false;
        for (const card of related) {
          const value = card.active ?? card.latest;
          if (!knowledgeScopeMatches(value, need.searchScope)) {
            reasons.push(value.title + "：范围不匹配");
            continue;
          }
          anyInScope = true;
          if (!card.active) {
            pending = true;
            reasons.push(value.title + "：未发布");
            continue;
          }
          const issues = await knowledgeEvidenceIssues(tx, card.active);
          if (issues.length) {
            expired = true;
            reasons.push(value.title + "：" + issues.join("；"));
            continue;
          }
          if (
            (await knowledgeBlockingConflicts(tx, card.active.id)).length ||
            conflictViews.some(
              (c) =>
                [c.leftVersionId, c.rightVersionId].includes(card.active!.id) &&
                ["open", "needs_evidence"].includes(c.state),
            )
          ) {
            risk = true;
            reasons.push(value.title + "：冲突未裁决");
            continue;
          }
          covered = true;
        }
        status = risk
          ? "conflict"
          : covered
            ? "covered"
            : expired
              ? "expired"
              : pending
                ? "in_review"
                : related.length && !anyInScope
                  ? "scope_mismatch"
                  : "missing";
        if (!related.length) reasons.push("尚未关联可用知识卡");
        coverage.push({
          ...need,
          scope: need.searchScope,
          entryIds: need.entryIds.filter((id) => visibleIds.has(id)),
          status,
          reasons,
        });
      }
      const freshness = [];
      for (const card of cards.entries) {
        const v = card.active ?? card.latest,
          issues = await knowledgeEvidenceIssues(tx, v),
          remaining = (Date.parse(v.reviewDueOn + "T23:59:59+08:00") - Date.now()) / 86400_000;
        freshness.push({
          id: card.id,
          kind: "card",
          label: v.title,
          status: issues.length ? "需复查" : remaining <= 7 ? "临近复查" : "有效",
          due: v.reviewDueOn,
          reason: issues.join("；") || (!card.active ? "卡片尚未发布" : ""),
        });
      }
      for (const source of sourceRows) {
        const snapshot = source.latestSnapshotId ? snapshotMap.get(source.latestSnapshotId) : null;
        freshness.push({
          id: source.id,
          kind: "source",
          label: source.label,
          status: source.lastError
            ? "检查失败"
            : !snapshot
              ? "未检查"
              : snapshot.validUntil <= new Date()
                ? "证据过期"
                : "有效",
          due: snapshot?.validUntil.toISOString() ?? "",
          reason: source.lastError ?? (source.monitoring ? "按配置周期检查" : "自动监控未启用"),
        });
      }
      for (const doc of docs)
        freshness.push({
          id: doc.id,
          kind: "document",
          label: doc.fileName,
          status:
            doc.state !== "confirmed"
              ? "未确认"
              : doc.fields.reviewDueOn < knowledgeDay()
                ? "证据过期"
                : "有效",
          due: doc.fields.reviewDueOn,
          reason:
            doc.kind === "account"
              ? "仅限报告期间 " + doc.account!.periodFrom + "–" + doc.account!.periodUntil
              : "原件保留期与证据复查期分别管理",
        });
      const cases = await tx
        .select()
        .from(evaluations)
        .where(and(isNull(evaluations.archivedAt), isNull(evaluations.benchmarkVersionId),
          knowledgeSearchScopeFilter(context, sql`${evaluations.fields}->'search'`),
          knowledgeEntryIdsScopeFilter(context, sql`${evaluations.fields}->'requiredEntryIds'`)))
        .orderBy(desc(evaluations.createdAt))
        .limit(200);
      const accounts = canReadAccount
        ? await tx
            .select()
            .from(stores)
            .where(and(catalogOwnerFilter(context, Permission.StoreRead, stores.createdBy), catalogOwnerFilter(context, Permission.FinanceRead, stores.createdBy)))
            .orderBy(stores.displayName)
        : [];
      return KnowledgeGovernanceViewSchema.parse({
        canManage: cards.canManage,
        canPublish: cards.canPublish,
        canReadAccount,
        stores: accounts.map((s) => ({ id: s.id, name: s.displayName, platform: s.platform })),
        documents: docs.map((d) => ({
          ...d,
          hasOriginal: !!d.encryptedOriginal && d.rawExpiresAt > new Date(),
          rawExpiresAt: d.rawExpiresAt.toISOString(),
          createdAt: d.createdAt.toISOString(),
        })),
        sources: sourceRows.map((s) => ({
          ...s,
          lastCheckedAt: s.lastCheckedAt?.toISOString() ?? null,
          lastSuccessAt: s.lastSuccessAt?.toISOString() ?? null,
          dueAt: s.nextCheckAt?.toISOString() ?? null,
        })),
        sourceReviews: reviewRows
          .filter((r) => sourceRows.some((s) => s.id === r.sourceId))
          .map((r) => ({
            ...r,
            sourceLabel: sourceRows.find((s) => s.id === r.sourceId)!.label,
            beforeText: "",
            afterText: "",
            createdAt: r.createdAt.toISOString(),
            entryIds: r.entryIds.filter((id) => visibleIds.has(id)),
          })),
        coverage,
        freshness,
        conflicts: conflictViews,
        evaluations: cases.filter(
          (c) =>
            !c.fields.search.spuIds.length || context.permissions.includes(Permission.ProductRead),
        ),
      });
    });
  }
  async addSource(context: TenantContext, raw: unknown) {
    authorize(context, Permission.WorkflowManage);
    const input = SaveKnowledgeSourceSchema.parse(raw),
      digest = knowledgeChecksum(input);
    let url: string;
    try {
      url = knowledgeOfficialUrl(input.url).href;
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : "来源地址无效");
    }
    return withTenant(this.database.db, context, async (tx) => {
      context = await currentKnowledgeContext(tx, context, Permission.WorkflowManage);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${"knowledge-source:" + context.tenantId},0))`,
      );
      const [prior] = await tx.select().from(sources).where(eq(sources.requestId, input.requestId));
      if (prior) {
        if (prior.requestChecksum !== digest) throw new ConflictException("来源请求已变化");
        return { id: prior.id };
      }
      const [count] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(sources)
        .where(isNull(sources.archivedAt));
      if (count!.n >= 200) throw new BadRequestException("来源最多 200 项");
      const id = createEntityId();
      await tx.insert(sources).values({
        id,
        tenantId: context.tenantId,
        ...input,
        url,
        requestChecksum: digest,
        createdBy: context.userId,
        nextCheckAt: input.monitoring ? new Date() : null,
      });
      await recordKnowledgeGovernanceEvent(tx, context, id, "source.register", "登记公开来源", {
        url,
        monitoring: input.monitoring,
      });
      return { id };
    });
  }
  async checkSource(context: TenantContext, id: string) {
    authorize(context, Permission.WorkflowManage);
    try {
      return await checkKnowledgeSource(this.database, context, id, undefined, async tx =>
        context = await currentKnowledgeContext(tx, context, Permission.WorkflowManage));
    } catch (e) {
      // Preserve permission errors; only the original public-source diagnostics
      // are represented as a source-check conflict.
      if (e instanceof ForbiddenError) throw e;
      throw new ConflictException(e instanceof Error ? e.message : "来源检查未完成");
    }
  }
  async reviewDetail(context: TenantContext, id: string) {
    authorize(context, Permission.WorkflowRead);
    return withTenant(this.database.db, context, async (tx) => {
      context = await currentKnowledgeContext(tx, context, Permission.WorkflowRead);
      const [selected] = await tx.select({ review: reviews, sourceLabel: sources.label })
        .from(reviews).innerJoin(sources, eq(sources.id, reviews.sourceId))
        .where(and(eq(reviews.id, id), isNull(sources.archivedAt), knowledgeEntryIdsScopeFilter(context, reviews.entryIds)))
        .for("share", { of: [reviews, sources] });
      if (!selected) throw new NotFoundException("来源变更不存在或不可访问");
      const row = selected.review;
      await assertKnowledgeScope(tx, context, { entryIds: row.entryIds });
      const data = await tx
        .select()
        .from(snapshots)
        .where(
          inArray(snapshots.id, [
            row.afterSnapshotId,
            ...(row.beforeSnapshotId ? [row.beforeSnapshotId] : []),
          ]),
        );
      return {
        ...row,
        sourceLabel: selected.sourceLabel,
        createdAt: row.createdAt.toISOString(),
        beforeText: data.find((s) => s.id === row.beforeSnapshotId)?.body ?? "",
        afterText: data.find((s) => s.id === row.afterSnapshotId)?.body ?? "",
      };
    });
  }
  async controlSource(context: TenantContext, id: string, raw: unknown) {
    authorize(context, Permission.WorkflowManage);
    const input = z
      .object({
        expectedRevision: z.int().positive(),
        monitoring: z.boolean(),
        checkEveryHours: z.int().min(6).max(720),
        freshnessDays: z.int().min(1).max(365),
      })
      .strict()
      .parse(raw);
    return withTenant(this.database.db, context, async (tx) => {
      context = await currentKnowledgeContext(tx, context, Permission.WorkflowManage);
      const [row] = await tx.select().from(sources).where(eq(sources.id, id)).for("update");
      if (!row) throw new NotFoundException("来源不存在");
      if (row.revision !== input.expectedRevision) throw new ConflictException("来源配置已变化");
      await tx
        .update(sources)
        .set({
          revision: row.revision + 1,
          monitoring: input.monitoring,
          checkEveryHours: input.checkEveryHours,
          freshnessDays: input.freshnessDays,
          nextCheckAt: input.monitoring ? new Date() : null,
        })
        .where(eq(sources.id, id));
      await recordKnowledgeGovernanceEvent(
        tx,
        context,
        id,
        "source.monitoring",
        "调整来源监控周期",
        { ...input },
      );
      return { id };
    });
  }
  async reviewSource(context: TenantContext, id: string, raw: unknown) {
    authorize(context, Permission.WorkflowApprove);
    const input = ReviewKnowledgeSourceSchema.parse(raw);
    return withTenant(this.database.db, context, async (tx) => {
      context = await currentKnowledgeContext(tx, context, Permission.WorkflowApprove);
      const [row] = await tx.select().from(reviews).where(eq(reviews.id, id)).for("update");
      if (!row) throw new NotFoundException("来源变更不存在");
      await assertKnowledgeScope(tx, context, { entryIds: row.entryIds });
      if (row.revision !== input.expectedRevision) throw new ConflictException("来源变更已被处理");
      await this.requireEntries(tx, context, input.entryIds);
      if (input.decision === "completed") {
        if (!input.entryIds.length)
          throw new BadRequestException("请关联已修订发布的知识卡；没有业务变化可选择无业务变化");
        for (const entryId of input.entryIds) {
          const [card] = await tx
            .select({ fields: versions.fields })
            .from(entries)
            .innerJoin(
              versions,
              and(eq(versions.entryId, entries.id), eq(versions.version, entries.activeVersion)),
            )
            .where(and(eq(entries.id, entryId), isNull(entries.archivedAt)));
          if (!card?.fields.sourceSnapshotIds?.includes(row.afterSnapshotId))
            throw new ConflictException("关联知识卡尚未审核发布本次来源证据，不能完成变更审核");
        }
      }
      await tx
        .update(reviews)
        .set({
          state: input.decision,
          reason: input.reason,
          entryIds: input.entryIds,
          revision: row.revision + 1,
        })
        .where(eq(reviews.id, id));
      await recordKnowledgeGovernanceEvent(
        tx,
        context,
        id,
        "source_review." + input.decision,
        input.reason,
        { entryIds: input.entryIds, afterSnapshotId: row.afterSnapshotId },
      );
      return { id };
    });
  }
  private async requireEntries(tx: TenantTransaction, context: TenantContext, ids: string[]) {
    await assertKnowledgeScope(tx, context, { entryIds: ids }, true);
  }
  async saveNeed(context: TenantContext, id: string | null, raw: unknown) {
    authorize(context, Permission.WorkflowManage);
    const input = SaveKnowledgeNeedSchema.parse(raw);
    if (input.scope.spuIds.length) authorize(context, Permission.ProductRead);
    return withTenant(this.database.db, context, async (tx) => {
      context = await currentKnowledgeContext(tx, context, Permission.WorkflowManage);
      await assertKnowledgeScope(tx, context, { spuIds: input.scope.spuIds });
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${"knowledge-need:" + context.tenantId},0))`,
      );
      await this.requireEntries(tx, context, input.entryIds);
      const needId = id ?? createEntityId();
      if (id) {
        const [row] = await tx.select().from(needs).where(eq(needs.id, id)).for("update");
        if (!row) throw new NotFoundException("需求不存在");
        await assertKnowledgeScope(tx, context, { spuIds: row.searchScope.spuIds, entryIds: row.entryIds });
        if (row.revision !== input.expectedRevision) throw new ConflictException("需求已变化");
        await tx
          .update(needs)
          .set({
            question: input.question,
            owner: input.owner,
            searchScope: input.scope,
            entryIds: input.entryIds,
            revision: row.revision + 1,
          })
          .where(eq(needs.id, id));
      } else {
        if (input.expectedRevision !== 0) throw new ConflictException("新需求不能带修订号");
        const [prior] = await tx.select().from(needs).where(eq(needs.requestId, input.requestId));
        if (prior) {
          await assertKnowledgeScope(tx, context, { spuIds: prior.searchScope.spuIds, entryIds: prior.entryIds });
          if (
            knowledgeChecksum([prior.question, prior.owner, prior.searchScope, prior.entryIds]) !==
            knowledgeChecksum([input.question, input.owner, input.scope, input.entryIds])
          )
            throw new ConflictException("同一需求请求内容已变化");
          return { id: prior.id };
        }
        const [count] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(needs)
          .where(isNull(needs.archivedAt));
        if (count!.n >= 500) throw new BadRequestException("需求最多 500 项");
        await tx.insert(needs).values({
          id: needId,
          tenantId: context.tenantId,
          question: input.question,
          owner: input.owner,
          searchScope: input.scope,
          entryIds: input.entryIds,
          requestId: input.requestId,
        });
      }
      await recordKnowledgeGovernanceEvent(
        tx,
        context,
        needId,
        "coverage.confirm",
        "确认知识需求及卡片关联",
        { entryIds: input.entryIds },
      );
      return { id: needId };
    });
  }
  async resolveConflict(context: TenantContext, id: string, raw: unknown) {
    authorize(context, Permission.WorkflowApprove);
    const input = ResolveKnowledgeConflictSchema.parse(raw);
    return withTenant(this.database.db, context, async (tx) => {
      context = await currentKnowledgeContext(tx, context, Permission.WorkflowApprove);
      const [row] = await tx.select().from(conflicts).where(eq(conflicts.id, id)).for("update");
      if (!row) throw new NotFoundException("冲突不存在");
      if (row.revision !== input.expectedRevision) throw new ConflictException("冲突已经处理");
      const rows = await tx
        .select({ version: versions, entry: entries })
        .from(versions)
        .innerJoin(entries, eq(entries.id, versions.entryId))
        .where(inArray(versions.id, [row.leftVersionId, row.rightVersionId]));
      await assertKnowledgeScope(tx, context, { entryIds: rows.map(value => value.entry.id) });
      const claims = rows.map((r) =>
        r.version.fields.claims?.find((c) => c.key.toLowerCase() === row.key.toLowerCase()),
      );
      if (
        input.decision === "conditional" &&
        (!claims[0]?.condition ||
          !claims[1]?.condition ||
          claims[0].condition.trim() === claims[1].condition.trim())
      )
        throw new BadRequestException("主张的适用条件没有差异；请修订卡片明确条件或补充证据");
      if (
        input.decision === "superseded" &&
        rows.every((r) => r.entry.activeVersion === r.version.version && !r.entry.archivedAt)
      )
        throw new ConflictException("请先显式停用被取代的知识版本，再裁决为已取代");
      await tx
        .update(conflicts)
        .set({ state: input.decision, reason: input.reason, revision: row.revision + 1 })
        .where(eq(conflicts.id, id));
      await recordKnowledgeGovernanceEvent(
        tx,
        context,
        id,
        "conflict." + input.decision,
        input.reason,
        { leftVersionId: row.leftVersionId, rightVersionId: row.rightVersionId },
      );
      return { id };
    });
  }
  async saveEvaluation(context: TenantContext, id: string | null, raw: unknown) {
    authorize(context, Permission.WorkflowManage);
    const input = SaveKnowledgeEvaluationSchema.parse(raw);
    if (
      !input.fields.expectRefusal &&
      !input.fields.expectedFacts.length &&
      !input.fields.requiredEntryIds.length
    )
      throw new BadRequestException("请至少定义答案要点、必需引用或应拒答场景");
    if (input.fields.search.spuIds.length) authorize(context, Permission.ProductRead);
    return withTenant(this.database.db, context, async (tx) => {
      context = await currentEvaluationContext(tx, context, "manage");
      context = await currentKnowledgeContext(tx, context, Permission.WorkflowManage);
      await assertKnowledgeScope(tx, context, { spuIds: input.fields.search.spuIds });
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${"knowledge-evaluation:" + context.tenantId},0))`,
      );
      await this.requireEntries(tx, context, input.fields.requiredEntryIds);
      const caseId = id ?? createEntityId();
      if (id) {
        const [row] = await tx
          .select()
          .from(evaluations)
          .where(eq(evaluations.id, id))
          .for("update");
        if (!row) throw new NotFoundException("评测问题不存在");
        if (row.benchmarkVersionId) throw new ConflictException("发布样本不可编辑，请建立新的数据集修订");
        await assertKnowledgeScope(tx, context, { spuIds: row.fields.search.spuIds, entryIds: row.fields.requiredEntryIds });
        if (row.revision !== input.expectedRevision) throw new ConflictException("评测问题已变化");
        await tx
          .update(evaluations)
          .set({ fields: input.fields, revision: row.revision + 1 })
          .where(eq(evaluations.id, id));
      } else {
        const [prior] = await tx
          .select()
          .from(evaluations)
          .where(eq(evaluations.requestId, input.requestId));
        if (prior) {
          await assertKnowledgeScope(tx, context, { spuIds: prior.fields.search.spuIds, entryIds: prior.fields.requiredEntryIds });
          if (knowledgeChecksum(prior.fields) !== knowledgeChecksum(input.fields))
            throw new ConflictException("同一评测请求已变化");
          return { id: prior.id };
        }
        if (input.expectedRevision) throw new ConflictException("新评测不能带修订号");
        const [count] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(evaluations)
          .where(and(isNull(evaluations.archivedAt), isNull(evaluations.benchmarkVersionId)));
        if (count!.n >= 200) throw new BadRequestException("评测问题最多 200 项");
        await tx.insert(evaluations).values({
          id: caseId,
          tenantId: context.tenantId,
          fields: input.fields,
          requestId: input.requestId,
        });
      }
      await recordKnowledgeGovernanceEvent(
        tx,
        context,
        caseId,
        "evaluation.save",
        "保存固定评测问题与检查断言",
      );
      return { id: caseId };
    });
  }
  async archive(
    context: TenantContext,
    kind: "source" | "need" | "evaluation",
    id: string,
    raw: unknown,
  ) {
    authorize(context, Permission.WorkflowManage);
    const input = (kind === "evaluation" ? ArchiveKnowledgeEvaluationSchema : z
      .object({ expectedRevision: z.int().positive(), reason: z.string().trim().min(1).max(1000) })
      .strict())
      .parse(raw);
    const table = kind === "source" ? sources : kind === "need" ? needs : evaluations;
    return withTenant(this.database.db, context, async (tx) => {
      if (kind === "evaluation") context = await currentEvaluationContext(tx, context, "manage");
      context = await currentKnowledgeContext(tx, context, Permission.WorkflowManage);
      const [row] = await tx.select().from(table).where(eq(table.id, id)).for("update");
      if (!row) throw new NotFoundException("记录不存在");
      if ("benchmarkVersionId" in row && row.benchmarkVersionId) throw new ConflictException("发布样本不可归档，请保留原发布版本");
      if (row.revision !== input.expectedRevision) throw new ConflictException("记录已变化");
      if ("searchScope" in row) await assertKnowledgeScope(tx, context, { spuIds: row.searchScope.spuIds, entryIds: row.entryIds });
      if ("fields" in row) await assertKnowledgeScope(tx, context, { spuIds: row.fields.search.spuIds, entryIds: row.fields.requiredEntryIds });
      await tx
        .update(table)
        .set({ archivedAt: new Date(), revision: row.revision + 1 })
        .where(eq(table.id, id));
      await recordKnowledgeGovernanceEvent(tx, context, id, kind + ".archive", input.reason);
      return { id };
    });
  }
  async history(context: TenantContext, id: string) {
    authorize(context, Permission.WorkflowRead);
    authorize(context, Permission.WorkflowApprove);
    return withTenant(this.database.db, context, async (tx) => {
      context = await currentKnowledgeContext(tx, context, Permission.WorkflowRead);
      authorize(context, Permission.WorkflowApprove);
      const [doc] = await tx.select().from(documents).where(eq(documents.id, id)).for("share");
      const [source] = await tx.select().from(sources).where(eq(sources.id, id)).for("share");
      const [review] = await tx.select().from(reviews).where(eq(reviews.id, id)).for("share");
      const [need] = await tx.select().from(needs).where(eq(needs.id, id)).for("share");
      const [evaluation] = await tx.select().from(evaluations).where(eq(evaluations.id, id)).for("share");
      const [conflict] = await tx.select().from(conflicts).where(eq(conflicts.id, id)).for("share");
      if (!doc && !source && !review && !need && !evaluation && !conflict)
        throw new NotFoundException("记录不可访问");
      if (doc?.fields.spuId) await assertKnowledgeScope(tx, context, { spuIds: [doc.fields.spuId] });
      if (need) await assertKnowledgeScope(tx, context, { spuIds: need.searchScope.spuIds, entryIds: need.entryIds });
      if (evaluation) await assertKnowledgeScope(tx, context, { spuIds: evaluation.fields.search.spuIds, entryIds: evaluation.fields.requiredEntryIds });
      if (review) await assertKnowledgeScope(tx, context, { entryIds: review.entryIds });
      if (doc?.kind === "account") {
        await assertKnowledgeAccountScope(tx, context, doc.createdBy, doc.storeId);
      }
      if (conflict) {
        const claims = await tx
          .select()
          .from(versions)
          .where(inArray(versions.id, [conflict.leftVersionId, conflict.rightVersionId]));
        await assertKnowledgeScope(tx, context, { entryIds: claims.map(value => value.entryId) });
      }
      const history = await tx
        .select({
          id: events.id,
          action: events.action,
          reason: events.reason,
          detail: events.detail,
          createdAt: events.createdAt,
        })
        .from(events)
        .where(eq(events.resourceId, id))
        .orderBy(desc(events.createdAt));
      // A later revision may remove a product reference. The immutable event
      // still contains its original IDs and must not become a history bypass.
      const historicalIds = history.flatMap(event => [
        ...(Array.isArray(event.detail.entryIds) ? event.detail.entryIds.filter((value): value is string => typeof value === "string") : []),
        ...(typeof event.detail.entryId === "string" ? [event.detail.entryId] : []),
      ]);
      await assertKnowledgeScope(tx, context, { entryIds: historicalIds });
      return history;
    });
  }
}
