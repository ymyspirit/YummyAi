import { isDeepStrictEqual } from "node:util";
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
  ResearchStudyContentSchema,
  SaveResearchStudyInputSchema,
  type ResearchSourceReference,
  type ResearchSourceSelection,
  type ResearchStudyRevision,
  type ResearchStudyWorkspace,
} from "@yummyai/contracts/research/creative";
import {
  captureSnapshots,
  creativeDesignBatches,
  researchItems,
  researchStudyRevisions,
  withTenant,
  type DatabaseConnection,
  type TenantTransaction,
} from "@yummyai/database";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { AuditService } from "../audit/audit.service.js";

const revisionView = (row: typeof researchStudyRevisions.$inferSelect): ResearchStudyRevision => ({
  id: row.id,
  researchItemId: row.researchItemId,
  snapshotId: row.snapshotId,
  version: row.version,
  content: ResearchStudyContentSchema.parse(row.content),
  createdAt: row.createdAt.toISOString(),
});

/** Called only inside the caller's withTenant transaction. Resolves server-owned versions. */
export async function resolveResearchSources(
  tx: TenantTransaction,
  context: TenantContext,
  selections: ResearchSourceSelection[],
): Promise<ResearchSourceReference[]> {
  if (!selections.length) return [];
  authorize(context, Permission.ResearchRead);
  if (new Set(selections.map((source) => source.researchItemId)).size !== selections.length)
    throw new BadRequestException("研究来源不可重复");
  const references: ResearchSourceReference[] = [];
  for (const selection of selections) {
    const [item] = await tx
      .select()
      .from(researchItems)
      .where(eq(researchItems.id, selection.researchItemId))
      .limit(1);
    if (!item) throw new NotFoundException("研究来源不存在");
    const [study] =
      selection.studyRevisionId === null
        ? []
        : await tx
            .select()
            .from(researchStudyRevisions)
            .where(
              and(
                eq(researchStudyRevisions.researchItemId, item.id),
                selection.studyRevisionId
                  ? eq(researchStudyRevisions.id, selection.studyRevisionId)
                  : undefined,
              ),
            )
            .orderBy(desc(researchStudyRevisions.version))
            .limit(1);
    if (selection.studyRevisionId && !study) throw new NotFoundException("研究结论版本不存在");
    const snapshotId = selection.snapshotId ?? study?.snapshotId;
    const [snapshot] = await tx
      .select()
      .from(captureSnapshots)
      .where(
        and(
          eq(captureSnapshots.researchItemId, item.id),
          snapshotId ? eq(captureSnapshots.id, snapshotId) : undefined,
        ),
      )
      .orderBy(desc(captureSnapshots.capturedAt), desc(captureSnapshots.id))
      .limit(1);
    if (!snapshot) throw new NotFoundException("研究快照不存在");
    if (selection.studyRevisionId && study?.snapshotId !== snapshot.id)
      throw new BadRequestException("研究结论与所选快照不匹配");
    const pinnedStudy = study?.snapshotId === snapshot.id ? study : undefined;
    references.push({
      domain: "research",
      researchItemId: item.id,
      snapshotId: snapshot.id,
      studyRevisionId: pinnedStudy?.id ?? null,
      studyVersion: pinnedStudy?.version ?? 0,
      title: snapshot.title ?? item.latestTitle ?? "未识别标题",
      sourceUrl: item.normalizedUrl,
      platform: item.platform as "amazon" | "etsy",
      capturedAt: snapshot.capturedAt.toISOString(),
      thumbnailUrl:
        snapshot.draft.media.find((media) => media.kind === "image" && media.included)?.sourceUrl ??
        null,
      mediaCount: snapshot.draft.media.filter((media) => media.included).length,
      content: pinnedStudy ? ResearchStudyContentSchema.parse(pinnedStudy.content) : null,
    });
  }
  return references;
}

export async function researchStudySummaries(tx: TenantTransaction, ids: string[]) {
  if (!ids.length)
    return new Map<
      string,
      { status: string; theme: string; version: number; snapshotId: string; creativeCount: number }
    >();
  const revisions = await tx
    .selectDistinctOn([researchStudyRevisions.researchItemId])
    .from(researchStudyRevisions)
    .where(inArray(researchStudyRevisions.researchItemId, ids))
    .orderBy(researchStudyRevisions.researchItemId, desc(researchStudyRevisions.version));
  const projects = await tx
    .select({
      ids: sql<
        string[]
      >`${creativeDesignBatches.canvasWorkflow}->'requirements'->'researchItemIds'`,
    })
    .from(creativeDesignBatches)
    .where(
      sql`${creativeDesignBatches.canvasWorkflow}->'requirements'->'researchItemIds' ?| ARRAY[${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )}]::text[] AND (${creativeDesignBatches.canvasWorkflow}->>'stepIndex')::integer = 0`,
    );
  return new Map(
    ids.map((id) => {
      const revision = revisions.find((row) => row.researchItemId === id);
      return [
        id,
        {
          status: revision?.content.status ?? "unreviewed",
          theme: revision?.content.theme ?? "",
          version: revision?.version ?? 0,
          snapshotId: revision?.snapshotId ?? "",
          creativeCount: projects.filter((project) => project.ids?.includes(id)).length,
        },
      ];
    }),
  );
}

@Injectable()
export class ResearchStudyService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async resolve(context: TenantContext, sources: ResearchSourceSelection[]) {
    authorize(context, Permission.ResearchRead);
    return withTenant(this.database.db, context, (tx) =>
      resolveResearchSources(tx, context, sources),
    );
  }

  async workspace(
    context: TenantContext,
    id: string,
    revisionId?: string,
  ): Promise<ResearchStudyWorkspace> {
    authorize(context, Permission.ResearchRead);
    return withTenant(this.database.db, context, async (tx) => {
      const [item] = await tx
        .select({ id: researchItems.id })
        .from(researchItems)
        .where(eq(researchItems.id, id))
        .limit(1);
      if (!item) throw new NotFoundException("研究来源不存在");
      const [snapshot] = await tx
        .select({ id: captureSnapshots.id })
        .from(captureSnapshots)
        .where(eq(captureSnapshots.researchItemId, id))
        .orderBy(desc(captureSnapshots.capturedAt), desc(captureSnapshots.id))
        .limit(1);
      const [revision] = await tx
        .select()
        .from(researchStudyRevisions)
        .where(
          and(
            eq(researchStudyRevisions.researchItemId, id),
            revisionId ? eq(researchStudyRevisions.id, revisionId) : undefined,
          ),
        )
        .orderBy(desc(researchStudyRevisions.version))
        .limit(1);
      if (revisionId && !revision) throw new NotFoundException("研究结论版本不存在");
      const projects = context.permissions.includes(Permission.DesignRead)
        ? await tx
            .select({ id: creativeDesignBatches.id, name: creativeDesignBatches.name })
            .from(creativeDesignBatches)
            .where(
              sql`${creativeDesignBatches.canvasWorkflow}->'requirements'->'researchItemIds' @> ${JSON.stringify([id])}::jsonb AND (${creativeDesignBatches.canvasWorkflow}->>'stepIndex')::integer = 0`,
            )
            .orderBy(desc(creativeDesignBatches.createdAt))
            .limit(100)
        : [];
      return {
        revision: revision ? revisionView(revision) : null,
        latestSnapshotId: snapshot?.id ?? null,
        projects,
      };
    });
  }

  async save(context: TenantContext, id: string, raw: unknown) {
    authorize(context, Permission.ResearchWrite);
    const parsed = SaveResearchStudyInputSchema.safeParse(raw);
    if (!parsed.success)
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message).join("；"));
    const input = parsed.data;
    const result = await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:research-study:${id}`},0))`,
      );
      const [prior] = await tx
        .select()
        .from(researchStudyRevisions)
        .where(eq(researchStudyRevisions.requestId, input.requestId))
        .limit(1);
      if (prior) {
        if (
          prior.researchItemId !== id ||
          prior.snapshotId !== input.snapshotId ||
          prior.version !== input.expectedVersion + 1 ||
          !isDeepStrictEqual(prior.content, input.content)
        )
          throw new ConflictException("同一保存请求不能用于不同研究内容");
        return revisionView(prior);
      }
      const [snapshot] = await tx
        .select()
        .from(captureSnapshots)
        .where(
          and(eq(captureSnapshots.id, input.snapshotId), eq(captureSnapshots.researchItemId, id)),
        )
        .limit(1);
      if (!snapshot) throw new NotFoundException("研究快照不存在");
      if (
        input.content.annotations.some((note) => !snapshot.draft.media[note.mediaIndex]?.included)
      )
        throw new BadRequestException("批注引用的媒体不在所选快照中");
      const [latest] = await tx
        .select({ version: researchStudyRevisions.version })
        .from(researchStudyRevisions)
        .where(eq(researchStudyRevisions.researchItemId, id))
        .orderBy(desc(researchStudyRevisions.version))
        .limit(1);
      if ((latest?.version ?? 0) !== input.expectedVersion)
        throw new ConflictException("研究结论已被更新，请重新读取后合并修改");
      const [revision] = await tx
        .insert(researchStudyRevisions)
        .values({
          id: createEntityId(),
          tenantId: context.tenantId,
          researchItemId: id,
          snapshotId: input.snapshotId,
          version: input.expectedVersion + 1,
          content: input.content,
          requestId: input.requestId,
          createdBy: context.userId,
        })
        .returning();
      return revisionView(revision!);
    });
    await this.audit.record(context, {
      action: "research.study.save",
      resourceType: "research_study_revision",
      resourceId: result.id,
      result: "success",
    });
    return result;
  }
}
