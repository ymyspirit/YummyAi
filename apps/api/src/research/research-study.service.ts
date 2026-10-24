import {
BadRequestException,
ConflictException,
Inject,
Injectable,
NotFoundException,
} from "@nestjs/common";
import { authorize,Permission } from "@yummyai/authz";
import { createEntityId,type TenantContext } from "@yummyai/contracts";
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
import { designReferenceScope,ResearchReadOwner,researchStudySummaries as sharedResearchStudySummaries,resolveResearchSources as sharedResolveResearchSources } from "@yummyai/knowledge-core";
import { and,desc,eq,sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { originalOwnerOperation } from "../shared/original-owner-error.js";
import { currentResearchAuthority,researchOwnerFilter } from "./research-access.js";



const revisionView = (row: typeof researchStudyRevisions.$inferSelect): ResearchStudyRevision => ({
  id: row.id,
  researchItemId: row.researchItemId,
  snapshotId: row.snapshotId,
  version: row.version,
  content: ResearchStudyContentSchema.parse(row.content),
  createdAt: row.createdAt.toISOString(),
});

/** Called only inside the caller's withTenant transaction. Resolves server-owned versions. */
export async function resolveResearchSources(tx:TenantTransaction,context:TenantContext,selections:ResearchSourceSelection[]):Promise<ResearchSourceReference[]>{return originalOwnerOperation(()=>sharedResolveResearchSources(tx,context,selections));}

export async function researchStudySummaries(tx:TenantTransaction,ids:string[],context:TenantContext,current:TenantContext){return originalOwnerOperation(()=>sharedResearchStudySummaries(tx,ids,context,current));}

@Injectable()
export class ResearchStudyService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async resolve(context:TenantContext,sources:ResearchSourceSelection[]){return originalOwnerOperation(()=>new ResearchReadOwner(this.database).resolve(context,sources));}

  async workspace(
    context: TenantContext,
    id: string,
    revisionId?: string,
  ): Promise<ResearchStudyWorkspace> {
    authorize(context, Permission.ResearchRead);
    return withTenant(this.database.db, context, async (tx) => {
      const current = await currentResearchAuthority(tx, context),
        scope = researchOwnerFilter(context, current, Permission.ResearchRead);
      const [item] = await tx
        .select({ id: researchItems.id })
        .from(researchItems)
        .where(and(eq(researchItems.id, id), scope))
        .limit(1)
        .for("share");
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
      const designScope = designReferenceScope(context, current);
      const projects = designScope
        ? await tx
            .select({ id: creativeDesignBatches.id, name: creativeDesignBatches.name })
            .from(creativeDesignBatches)
            .where(
              and(
                designScope.filter,
                sql`${creativeDesignBatches.canvasWorkflow}->'requirements'->'researchItemIds' @> ${JSON.stringify([id])}::jsonb AND (${creativeDesignBatches.canvasWorkflow}->>'stepIndex')::integer = 0`,
              ),
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
      const current = await currentResearchAuthority(tx, context),
        scope = researchOwnerFilter(context, current, Permission.ResearchWrite);
      const [item] = await tx
        .select({ id: researchItems.id })
        .from(researchItems)
        .where(and(eq(researchItems.id, id), scope))
        .limit(1)
        .for("share");
      if (!item) throw new NotFoundException("研究来源不存在");
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
