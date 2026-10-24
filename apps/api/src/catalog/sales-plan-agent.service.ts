import { randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { authorize, ForbiddenError, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import type { CreateAssist } from "@yummyai/contracts/ai/assist";
import {
  PreparationAnalyzeSchema, PreparationBasisSchema, PreparationCommandSchema,
  PreparationRunSchema, PreparationStartSchema, type PreparationRun, type PreparationView,
} from "@yummyai/contracts/catalog/sales-plan-agent";
import { developmentEvents, withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { AssistService, authorizeAssist } from "../ai/assist.service.js";
import { SalesPlanService } from "./sales-plan.service.js";
import { SalesPlanLaunchService } from "./sales-plan-launch.service.js";
import { fingerprint, lockDevelopment } from "./development-data.js";
import { preparationDecision } from "./sales-plan-agent-policy.js";

const START = "sales_plan.preparation_started";
const EVENT = "sales_plan.preparation_checkpoint";
const GOAL = "准备当前销售方案至可提交刊登审核" as const;
const LEASE_MS = 60_000;
type Intent = { kind: "draft"; input: { expectedRevision: number; expectedListingVersionId: string | null; idempotencyKey: string } } |
  { kind: "analysis"; input: CreateAssist };
type StoredRun = PreparationRun & { sourceFingerprint: string; lease: { token: string; until: string } | null; intent: Intent | null };

function access(context: TenantContext, write = false) {
  for (const permission of [Permission.ProductRead, Permission.DesignRead, Permission.AssetRead, Permission.ListingRead]) authorize(context, permission);
  if (context.dataScope !== "tenant") throw new ForbiddenError(Permission.ProductRead);
  if (write) { authorize(context, Permission.ProductWrite); authorize(context, Permission.ListingWrite); }
}
const liveLease = (run: StoredRun) => !!run.lease && Date.parse(run.lease.until) > Date.now();

/** Durable, bounded business-tool coordinator. The existing catalog event ledger
 * owns checkpoints; domain services own every artifact and business mutation.
 * Reads never advance a run. Paid analysis is separately previewed/authorized. */
@Injectable()
export class SalesPlanPreparationService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(SalesPlanService) private readonly plans: SalesPlanService,
    @Inject(SalesPlanLaunchService) private readonly launch: SalesPlanLaunchService,
    @Inject(AssistService) private readonly assists: AssistService,
  ) {}

  async snapshot(context: TenantContext, planId: string) {
    const basis = await this.plans.assistBasis(context, planId);
    const detail = await this.plans.get(context, planId);
    const launch = await this.launch.get(context, planId);
    if (basis.plan.revision !== detail.plan.revision || launch.revision !== detail.plan.revision)
      throw new ConflictException("销售方案正在变化，请刷新后重试");
    const decision = preparationDecision(detail, launch);
    const evidence: PreparationRun["evidence"] = [
      { kind: "sales_plan", id: planId, version: String(detail.plan.revision) },
      ...basis.specifications.map(s => ({ kind: "specification" as const, id: s.id, version: s.versionId })),
      ...detail.plan.fields.artworkVersionIds.map(id => ({ kind: "artwork" as const, id, version: id })),
      ...(decision.listing ? [{ kind: "listing" as const, id: decision.listing.id, version: decision.listing.versionId }] : []),
    ];
    return { detail, decision, evidence, fingerprint: fingerprint({ basis: basis.fingerprint,
      steps: decision.steps, listings: detail.listings }) };
  }

  async list(context: TenantContext, planId: string) {
    access(context);
    await this.plans.get(context, planId);
    return withTenant(this.database.db, context, async tx => {
      const starts = await tx.select().from(developmentEvents).where(and(
        eq(developmentEvents.resourceId, planId), eq(developmentEvents.action, START),
        eq(developmentEvents.createdBy, context.userId),
      )).orderBy(desc(developmentEvents.createdAt), desc(developmentEvents.id)).limit(10);
      const runs = [];
      for (const start of starts) runs.push(PreparationRunSchema.parse(await this.read(tx, context, planId, (start.result.run as StoredRun).id)));
      return { runs };
    });
  }

  async get(context: TenantContext, planId: string, id: string): Promise<PreparationView> {
    access(context);
    const detail = await this.plans.get(context, planId);
    const { run, history } = await withTenant(this.database.db, context, async tx => {
      const run = await this.read(tx, context, planId, id);
      const rows = await tx.select({ at: developmentEvents.createdAt, message: developmentEvents.reason })
        .from(developmentEvents).where(this.where(context, planId, id))
        .orderBy(desc(sql`(${developmentEvents.result}->'run'->>'revision')::integer`)).limit(30);
      return { run, history: rows.reverse().map(r => ({ at: r.at.toISOString(), message: r.message })) };
    });
    let sourceChanged = true;
    if (!detail.plan.archived) {
      try { sourceChanged = run.sourceFingerprint !== (await this.snapshot(context, planId)).fingerprint; }
      catch (error) { if (!(error instanceof ConflictException)) throw error; }
    }
    const latest = run.analyses.at(-1);
    let analysis: PreparationView["analysis"] = null;
    if (latest) {
      authorizeAssist(context, latest.kind);
      const result = await this.assists.get(context, latest.id);
      analysis = { id: result.id, kind: latest.kind, status: result.status, stale: result.stale,
        costUsd: result.costUsd,
        href: `/sales-plans?plan=${planId}&view=tasks&preparation=${id}&kind=${latest.kind}&launchRun=${result.id}` };
    }
    return { run: PreparationRunSchema.parse(run), currentPlanRevision: detail.plan.revision,
      sourceChanged, busy: liveLease(run), history, analysis,
      canContinue: !detail.plan.archived && run.status !== "cancelled" && !liveLease(run) &&
        context.permissions.includes(Permission.ProductWrite) && context.permissions.includes(Permission.ListingWrite) };
  }

  async start(context: TenantContext, planId: string, raw: unknown) {
    access(context, true);
    const input = PreparationStartSchema.parse(raw);
    const commandHash = fingerprint({ owner: context.userId, planId, action: "start", input });
    const replay = await withTenant(this.database.db, context, tx => this.command(tx, context, input.idempotencyKey, commandHash));
    if (replay) return this.get(context, planId, replay.id);
    const source = await this.snapshot(context, planId);
    if (source.detail.plan.revision !== input.expectedRevision) throw new ConflictException("请按当前销售方案版本开始任务");
    const claimed = await withTenant(this.database.db, context, async tx => {
      await lockDevelopment(tx, context, `preparation:${planId}:${context.userId}`);
      const prior = await this.command(tx, context, input.idempotencyKey, commandHash);
      if (prior) return { run: prior, execute: false };
      const [start] = await tx.select().from(developmentEvents).where(and(
        eq(developmentEvents.resourceId, planId), eq(developmentEvents.action, START), eq(developmentEvents.createdBy, context.userId),
      )).orderBy(desc(developmentEvents.createdAt), desc(developmentEvents.id)).limit(1);
      if (start) {
        const previous = await this.read(tx, context, planId, (start.result.run as StoredRun).id);
        if (!["ready", "cancelled"].includes(previous.status)) return { run: previous, execute: false };
      }
      const now = new Date().toISOString();
      const run: StoredRun = { id: createEntityId(), planId, revision: 1, planRevision: input.expectedRevision,
        status: "running", goal: GOAL, message: "已建立任务，开始核对当前资料", steps: source.decision.steps, evidence: source.evidence,
        listingId: null, listingVersionId: null, analyses: [], toolCalls: 0, createdAt: now, updatedAt: now,
        sourceFingerprint: source.fingerprint, lease: this.lease(), intent: null };
      await this.append(tx, context, run, input.idempotencyKey, commandHash, START);
      return { run, execute: true };
    });
    if (claimed.execute) await this.drive(context, claimed.run);
    return this.get(context, planId, claimed.run.id);
  }

  async resume(context: TenantContext, planId: string, id: string, raw: unknown) {
    access(context, true);
    const input = PreparationCommandSchema.parse(raw);
    const hash = fingerprint({ owner: context.userId, planId, id, action: "resume", input });
    const replay = await withTenant(this.database.db, context, tx => this.command(tx, context, input.idempotencyKey, hash));
    if (replay) return this.get(context, planId, id);
    const source = await this.snapshot(context, planId);
    if (source.detail.plan.revision !== input.expectedRevision) throw new ConflictException("方案版本已变化，请刷新后按当前版本继续");
    const claim = await this.claim(context, planId, id, input, "resume", run => ({ ...run,
      planRevision: input.expectedRevision, sourceFingerprint: source.fingerprint, status: "running",
      message: run.planRevision === input.expectedRevision ? "从原任务检查点继续" : "已确认当前方案版本，重新核对受影响步骤",
      lease: this.lease() }));
    if (claim.execute) await this.drive(context, claim.run);
    return this.get(context, planId, id);
  }

  async cancel(context: TenantContext, planId: string, id: string, raw: unknown) {
    access(context, true);
    const input = PreparationCommandSchema.parse(raw);
    await this.plans.get(context, planId);
    await this.claim(context, planId, id, input, "cancel", run => ({ ...run, status: "cancelled", lease: null,
      message: "任务已停止，已创建的草稿与分析保留在原业务记录中" }), true);
    return this.get(context, planId, id);
  }

  async basis(context: TenantContext, planId: string, id: string, raw: unknown) {
    access(context, true);
    const input = PreparationBasisSchema.parse(raw);
    const run = await withTenant(this.database.db, context, tx => this.read(tx, context, planId, id));
    this.assertCommand(run, input.expectedRunRevision);
    if (run.planRevision !== input.expectedRevision) throw new ConflictException("请先按当前方案版本继续任务，再读取分析依据");
    if (run.intent) throw new ConflictException("请先继续原任务，核对尚未确认的执行结果");
    if (run.analyses.length >= 2) throw new ConflictException("本任务已达到两次分析上限，请核对已有结果");
    const previous = run.analyses.at(-1);
    if (previous && ["queued", "running"].includes((await this.assists.get(context, previous.id)).status))
      throw new ConflictException("原分析任务仍在执行，请等待结果");
    return this.launch.basis(context, planId, { kind: input.kind, expectedRevision: input.expectedRevision, taskGoal: GOAL });
  }

  async analyze(context: TenantContext, planId: string, id: string, raw: unknown) {
    access(context, true);
    const input = PreparationAnalyzeSchema.parse(raw);
    authorizeAssist(context, input.kind, true);
    // Replaying a committed command must return its original record, even after
    // the model completed or the business inputs changed.
    const hash = fingerprint({ owner: context.userId, planId, id, action: "analyze", input });
    const prior = await withTenant(this.database.db, context, tx => this.command(tx, context, input.idempotencyKey, hash));
    if (prior) return this.get(context, planId, id);
    const basis = await this.basis(context, planId, id, { kind: input.kind,
      expectedRevision: input.expectedRevision, expectedRunRevision: input.expectedRunRevision });
    if (basis.fingerprint !== input.expectedFingerprint) throw new ConflictException("分析依据已变化，请重新读取并确认");
    const claim = await this.claim(context, planId, id, input, "analyze", run => {
      if (run.intent || run.analyses.length >= 2) throw new ConflictException("先核对原任务结果，再开始新的分析");
      return { ...run, status: "running", lease: this.lease(), message: "已记录本次分析授权，交给现有分析任务执行",
        intent: { kind: "analysis", input: { ...basis.input, requestId: randomUUID(), modelId: input.modelId } as CreateAssist } };
    });
    if (claim.execute) await this.drive(context, claim.run);
    return this.get(context, planId, id);
  }

  private async drive(context: TenantContext, initial: StoredRun) {
    let run = initial;
    const token = run.lease!.token;
    try {
      // Bound each turn; polling and bookkeeping do not count as tool calls.
      for (let turn = 0; turn < 4; turn++) {
        await this.assertLease(context, run, token);
        if (run.intent) {
          if (run.intent.kind === "analysis") {
            const result = await this.assists.create(context, run.intent.input);
            run = await this.checkpoint(context, run, token, { analyses: [...run.analyses, { id: result.id, kind: run.intent.input.kind as "creative" | "sku_package" }],
              intent: null, status: "waiting", lease: null, toolCalls: run.toolCalls + 1,
              message: "分析已交给后台执行，完成后请核对并采纳建议，再继续此任务" });
            return;
          }
          await this.plans.draft(context, run.planId, run.intent.input);
          run = await this.checkpoint(context, run, token, { intent: null, toolCalls: run.toolCalls + 1, message: "本地刊登草稿已保存，开始检查实际结果" });
        }
        const source = await this.snapshot(context, run.planId);
        if (source.detail.plan.revision !== run.planRevision) throw new ConflictException("方案已更新，请确认当前版本后继续");
        const d = source.decision;
        const patch = { steps: d.steps, evidence: source.evidence, sourceFingerprint: source.fingerprint, listingId: d.listing?.id ?? null,
          listingVersionId: d.listing?.versionId ?? null, toolCalls: run.toolCalls + 1 };
        if (d.action === "sync_draft") {
          run = await this.checkpoint(context, run, token, { ...patch, message: d.message,
            intent: { kind: "draft", input: { expectedRevision: run.planRevision,
              expectedListingVersionId: d.listing?.versionId ?? null, idempotencyKey: randomUUID() } } });
          continue;
        }
        await this.checkpoint(context, run, token, { ...patch, status: d.ready ? "ready" : "blocked", message: d.message, lease: null });
        return;
      }
      await this.checkpoint(context, run, token, { status: "blocked", lease: null, message: "本轮已达到执行上限，请核对进展后继续" });
    } catch (error) {
      const current = await withTenant(this.database.db, context, tx => this.read(tx, context, run.planId, run.id));
      if (current.status === "cancelled" || current.lease?.token !== token) return;
      // Preserve the intent for an idempotent reconciliation after an uncertain
      // response. Never generate a new request ID just because a call failed.
      await this.checkpoint(context, current, token, { status: "blocked", lease: null,
        ...(error instanceof ConflictException && current.intent?.kind === "draft" ? { intent: null } : {}),
        message: error instanceof ConflictException ? error.message.slice(0, 400) :
          error instanceof ForbiddenError ? "执行权限已变化，请核对账号权限" : "本步结果尚未确认，继续任务会先核对同一个请求" });
    }
  }

  private lease() { return { token: randomUUID(), until: new Date(Date.now() + LEASE_MS).toISOString() }; }
  private where(context: TenantContext, planId: string, id: string) {
    return and(eq(developmentEvents.resourceId, planId), eq(developmentEvents.createdBy, context.userId),
      inArray(developmentEvents.action, [START, EVENT]), sql`${developmentEvents.result}->'run'->>'id' = ${id}`);
  }
  private async read(tx: TenantTransaction, context: TenantContext, planId: string, id: string): Promise<StoredRun> {
    // Revisions are serialized under the plan/creator lock. Transaction timestamps
    // can tie or precede lock waits, so wall-clock ordering is not authoritative.
    const [row] = await tx.select().from(developmentEvents).where(this.where(context, planId, id))
      .orderBy(desc(sql`(${developmentEvents.result}->'run'->>'revision')::integer`)).limit(1);
    if (!row) throw new NotFoundException("上架准备任务不存在或无权读取");
    return row.result.run as StoredRun;
  }
  private async command(tx: TenantTransaction, context: TenantContext, key: string, hash: string) {
    const [row] = await tx.select().from(developmentEvents).where(eq(developmentEvents.idempotencyKey, key));
    if (!row) return null;
    if (row.createdBy !== context.userId || row.requestHash !== hash) throw new ConflictException("请求编号已使用，请刷新后重试");
    return row.result.run as StoredRun;
  }
  private async append(tx: TenantTransaction, context: TenantContext, run: StoredRun, key: string = randomUUID(), hash = fingerprint(run), action = EVENT) {
    await tx.insert(developmentEvents).values({ id: createEntityId(), tenantId: context.tenantId, createdBy: context.userId,
      resourceId: run.planId, action, reason: run.message, idempotencyKey: key, requestHash: hash, result: { run } });
  }
  private assertCommand(run: StoredRun, expected: number, cancel = false) {
    if (run.revision !== expected) throw new ConflictException("任务已推进，请刷新后重试");
    if (run.status === "cancelled") throw new ConflictException("已取消任务不能恢复，请建立新任务");
    if (!cancel && liveLease(run)) throw new ConflictException("原任务仍在执行，请稍后查看结果");
  }
  private async claim(context: TenantContext, planId: string, id: string,
    input: { expectedRunRevision: number; idempotencyKey: string }, action: string,
    change: (run: StoredRun) => StoredRun, cancel = false) {
    return withTenant(this.database.db, context, async tx => {
      await lockDevelopment(tx, context, `preparation:${planId}:${context.userId}`);
      const hash = fingerprint({ owner: context.userId, planId, id, action, input });
      const prior = await this.command(tx, context, input.idempotencyKey, hash);
      if (prior) return { run: prior, execute: false };
      const current = await this.read(tx, context, planId, id);
      this.assertCommand(current, input.expectedRunRevision, cancel);
      const run = { ...change(current), revision: current.revision + 1, updatedAt: new Date().toISOString() };
      await this.append(tx, context, run, input.idempotencyKey, hash);
      return { run, execute: true };
    });
  }
  private async assertLease(context: TenantContext, run: StoredRun, token: string) {
    const current = await withTenant(this.database.db, context, tx => this.read(tx, context, run.planId, run.id));
    if (current.status === "cancelled" || current.lease?.token !== token || !liveLease(current))
      throw new ConflictException("任务执行权已变化，请读取原任务");
  }
  private async checkpoint(context: TenantContext, run: StoredRun, token: string, patch: Partial<StoredRun>) {
    return withTenant(this.database.db, context, async tx => {
      await lockDevelopment(tx, context, `preparation:${run.planId}:${context.userId}`);
      const current = await this.read(tx, context, run.planId, run.id);
      if (current.status === "cancelled" || current.lease?.token !== token) throw new ConflictException("任务执行权已变化");
      const next = { ...current, ...patch, revision: current.revision + 1, updatedAt: new Date().toISOString() };
      await this.append(tx, context, next);
      return next;
    });
  }
}
