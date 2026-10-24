import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { authorize, ForbiddenError, Permission } from "@yummyai/authz";
import { assistInvocationView, modelBillingBudgetAmount } from "@yummyai/ai-core";
import { podInvocationViews } from "@yummyai/pod-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  ModelBillingBasisSchema,
  ModelBillingConfirmSchema,
  ModelBillingCursorSchema,
  ModelBillingListQuerySchema,
  ModelBillingReceiptViewSchema,
  ModelBillingWorkspaceSchema,
  type ModelBillingOwner,
} from "@yummyai/contracts/ai/model-billing";
import { ModelBillingAcknowledgmentSchema } from "@yummyai/contracts/harness";
import {
  aiAssistRuns as runs,
  aiAssistExecutions as executions,
  aiBudgetLedger as ledger,
  modelProviderConfigs,
  podArtworkInvocations as invocations,
  podArtworkTasks as podTasks,
  modelBillingReconciliations as receipts,
  loadCurrentMembershipContext,
  recordAuditInTransaction,
  withTenant,
  type DatabaseConnection,
  type TenantTransaction,
} from "@yummyai/database";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { DATABASE_CONNECTION } from "../platform.tokens.js";

type Receipt = typeof receipts.$inferSelect;
const checksum = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function acknowledgment(row: Receipt) {
  return ModelBillingAcknowledgmentSchema.parse({
    id: row.id,
    sequence: row.sequence,
    amountUsd: row.amountUsd,
    proofChecksum: row.proofChecksum,
    verification: "operator_attested",
    checkedAt: row.checkedAt.toISOString(),
    checkedBy: row.checkedBy,
  });
}
function receiptView(row: Receipt) {
  return ModelBillingReceiptViewSchema.parse({
    ...acknowledgment(row),
    owner: row.owner,
    subjectId: row.subjectId,
    evidenceKind: row.evidenceKind,
    invoiceReference: row.invoiceReference,
    providerRequestId: row.providerRequestId,
    previousId: row.previousId,
    budgetImpact: row.budgetImpact,
  });
}

@Injectable()
export class ModelBillingService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection) {}

  private async current(tx: TenantTransaction, base: TenantContext, lock = false) {
    const context = await loadCurrentMembershipContext(tx, base, { lock });
    authorize(context, Permission.ModelBillingReconcile);
    if (context.dataScope !== "tenant")
      throw new ForbiddenError(Permission.ModelBillingReconcile, "outside_data_scope");
    const enabled = (process.env.MODEL_BILLING_TENANT_IDS ?? "").split(",").map((v) => v.trim());
    if (!enabled.includes("*") && !enabled.includes(context.tenantId))
      throw new ServiceUnavailableException("模型费用核对尚未启用");
    return context;
  }

  async workspace(context: TenantContext, raw: unknown) {
    const parsed = ModelBillingListQuerySchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException("费用记录筛选格式不正确");
    let cursor: ReturnType<typeof ModelBillingCursorSchema.parse> | null = null;
    if (parsed.data.after) {
      try {
        cursor = ModelBillingCursorSchema.parse(
          JSON.parse(Buffer.from(parsed.data.after, "base64url").toString("utf8")),
        );
      } catch {
        throw new BadRequestException("费用记录位置已失效 请重新读取");
      }
    }
    return withTenant(
      this.database.db,
      context,
      async (tx) => {
        await this.current(tx, context);
        const filter = parsed.data.scope === "all" ? sql`true` : sql`not q.reconciled`;
        const after = cursor
          ? sql`(q.created_at,q.id,q.owner)<(${cursor.at}::timestamptz,${cursor.id}::uuid,${cursor.owner}::text)`
          : sql`true`;
        const rows = await tx.execute(sql`
        select q.owner,q.id,q.state,to_char(q.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",q.model_label as "modelLabel",q.reconciled from (
          select 'assist'::text as owner,r.id,r.status as state,r.created_at,coalesce(r.model_snapshot->>'label',r.model_snapshot->>'model','未记录模型') as model_label,
            exists(select 1 from ${receipts} b where b.owner='assist' and b.assist_run_id=r.id) as reconciled
          from ${runs} r left join ${executions} e on e.run_id=r.id and e.tenant_id=r.tenant_id
          where r.status in ('completed','failed','cancelled') and (r.started_at is not null or r.cost_usd is not null) and (e.run_id is null or e.submission_state<>'not_submitted')
          union all
          select 'pod'::text,i.id,i.phase as state,i.started_at as created_at,coalesce(i.model_key,'未记录模型') as model_label,
            exists(select 1 from ${receipts} b where b.owner='pod' and b.pod_invocation_id=i.id) as reconciled
          from ${invocations} i join ${podTasks} p on p.id=i.task_id and p.tenant_id=i.tenant_id
          where i.phase in ('completed','failed','uncertain') and i.submitted_at is not null and p.status not in ('queued','running')
        ) q where ${filter} and ${after} order by q.created_at desc,q.id desc,q.owner desc limit 21`);
        const items = Array.from(rows).slice(0, 20),
          last = items.at(-1);
        return ModelBillingWorkspaceSchema.parse({
          items,
          nextCursor:
            rows.length > 20 && last
              ? Buffer.from(
                  JSON.stringify({ at: last.createdAt, id: last.id, owner: last.owner }),
                ).toString("base64url")
              : null,
        });
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  private async load(tx: TenantTransaction, owner: ModelBillingOwner, id: string, lock = false) {
    const history = await tx
      .select()
      .from(receipts)
      .where(and(eq(receipts.owner, owner), eq(receipts.subjectId, id)))
      .orderBy(desc(receipts.sequence))
      .limit(21);
    const latest = history[0] ?? null,
      blockers: string[] = [];
    if (owner === "assist") {
      const rq = tx
        .select({
          id: runs.id,
          status: runs.status,
          ownerId: runs.ownerId,
          kind: runs.kind,
          createdAt: runs.createdAt,
          periodStartedAt: sql<string>`to_char(${runs.createdAt} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          startedAt: runs.startedAt,
          completedAt: runs.completedAt,
          costUsd: runs.costUsd,
          inputTokens: runs.inputTokens,
          outputTokens: runs.outputTokens,
          modelSnapshot: runs.modelSnapshot,
        })
        .from(runs)
        .where(eq(runs.id, id));
      const [run] = await (lock ? rq.for("update") : rq);
      if (!run) throw new NotFoundException("原费用调用不存在");
      const eqry = tx
        .select({
          phase: executions.phase,
          submissionState: executions.submissionState,
          attemptCount: executions.attemptCount,
          dispatchCount: executions.dispatchCount,
          submittedAt: executions.submittedAt,
          receivedAt: executions.receivedAt,
          providerRequestId: executions.providerRequestId,
          responseChecksum: executions.responseChecksum,
          leaseExpiresAt: executions.leaseExpiresAt,
          leaseActive: sql<boolean>`coalesce(${executions.leaseExpiresAt}>clock_timestamp(),false)`,
        })
        .from(executions)
        .where(eq(executions.runId, id));
      const [execution] = await (lock ? eqry.for("update") : eqry);
      const bq = tx
        .select({
          id: ledger.id,
          amountUsd: ledger.amountUsd,
          state: ledger.state,
          createdAt: ledger.createdAt,
          periodStartedAt: sql<string>`to_char(${ledger.createdAt} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(ledger)
        .where(eq(ledger.requestId, id))
        .orderBy(asc(ledger.id));
      const budgets = await (lock ? bq.for("update") : bq);
      const pq = tx
        .select({ provider: modelProviderConfigs.provider })
        .from(modelProviderConfigs)
        .where(eq(modelProviderConfigs.id, run.modelSnapshot.providerConfigId));
      const [provider] = await (lock ? pq.for("share") : pq);
      if (!budgets.length && !provider) blockers.push("原渠道类型记录缺失 请先恢复来源再核对预算");
      if (!execution && !run.startedAt && run.costUsd === null)
        blockers.push("历史记录缺少外部调用依据 请先核对原请求");
      if (
        ["queued", "running"].includes(run.status) ||
        (execution && !["completed", "failed", "uncertain"].includes(execution.phase)) ||
        execution?.leaseActive
      )
        blockers.push("原任务尚在处理 请等待终态后核对");
      if (execution?.submissionState === "not_submitted")
        blockers.push("原任务没有跨过外部提交边界 无需补录渠道费用");
      if (budgets.length > 1) blockers.push("原预算存在多笔记录 需先核对账目");
      const source = {
        owner,
        id,
        state: run.status,
        createdAt: run.createdAt,
        modelLabel: run.modelSnapshot.label,
        providerRequestId: execution?.providerRequestId ?? null,
        blockers,
        originalInvocation: assistInvocationView(
          run,
          execution ?? null,
          budgets[0] ?? null,
          null,
          budgets.length > 1,
          latest ? acknowledgment(latest) : null,
        ),
        history,
        assist: { run, budget: budgets[0] ?? null, provider: provider?.provider },
      };
      const fingerprint = checksum({
        owner,
        id,
        state: run.status,
        createdAt: run.createdAt.toISOString(),
        model: {
          provider: run.modelSnapshot.providerConfigId,
          providerKind: provider?.provider ?? null,
          key: run.modelSnapshot.model,
          inputPrice: run.modelSnapshot.inputUsdPerMillion,
          outputPrice: run.modelSnapshot.outputUsdPerMillion,
        },
        execution: execution ?? null,
        budgets: budgets.map((b) => ({
          id: b.id,
          amount: b.amountUsd,
          state: b.state,
          createdAt: b.createdAt.toISOString(),
        })),
        latest: latest?.id ?? null,
      });
      return { ...source, fingerprint };
    }
    const iq = tx.select().from(invocations).where(eq(invocations.id, id));
    const [invocation] = await (lock ? iq.for("update") : iq);
    if (!invocation) throw new NotFoundException("原POD调用证据不存在");
    const pq = tx
      .select({
        id: podTasks.id,
        status: podTasks.status,
        attemptCount: podTasks.attemptCount,
        startedAt: podTasks.startedAt,
        completedAt: podTasks.completedAt,
      })
      .from(podTasks)
      .where(eq(podTasks.id, invocation.taskId));
    const [task] = await (lock ? pq.for("update") : pq);
    if (!task) throw new NotFoundException("原POD任务不存在");
    if (
      !["completed", "failed", "uncertain"].includes(invocation.phase) ||
      ["queued", "running"].includes(task.status)
    )
      blockers.push("原POD调用尚在处理 请等待终态后核对");
    if (!invocation.submittedAt) blockers.push("原POD调用没有跨过外部提交边界 无需补录渠道费用");
    return {
      owner,
      id,
      state: invocation.phase,
      createdAt: invocation.startedAt,
      modelLabel: invocation.modelKey ?? "未记录模型",
      providerRequestId: invocation.providerRequestId,
      blockers,
      originalInvocation: podInvocationViews(
        task,
        [invocation],
        latest ? new Map([[id, acknowledgment(latest)]]) : new Map(),
      )[0]!,
      history,
      assist: null,
      fingerprint: checksum({
        owner,
        id,
        invocation,
        taskState: task.status,
        latest: latest?.id ?? null,
      }),
    };
  }

  async basis(context: TenantContext, owner: ModelBillingOwner, id: string) {
    return withTenant(
      this.database.db,
      context,
      async (tx) => {
        await this.current(tx, context);
        const source = await this.load(tx, owner, id);
        return ModelBillingBasisSchema.parse({
          owner,
          subjectId: id,
          fingerprint: source.fingerprint,
          modelLabel: source.modelLabel,
          state: source.state,
          createdAt: source.createdAt.toISOString(),
          providerRequestId: source.providerRequestId,
          canConfirm: !source.blockers.length,
          blockers: source.blockers,
          originalInvocation: source.originalInvocation,
          history: source.history.slice(0, 20).map(receiptView),
          hasMoreHistory: source.history.length > 20,
        });
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async confirm(context: TenantContext, owner: ModelBillingOwner, id: string, raw: unknown) {
    const parsed = ModelBillingConfirmSchema.safeParse(raw);
    if (!parsed.success)
      throw new BadRequestException(
        "核对资料格式不正确 请填写美元金额、原请求号及凭证摘要并确认匹配",
      );
    const input = parsed.data,
      requestChecksum = checksum({ owner, id, input });
    return withTenant(this.database.db, context, async (tx) => {
      const actor = await this.current(tx, context, true);
      // Same lock as original assist reservations/settlement; proof and budget commit together.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${context.tenantId + ":ai-assist-budget"},0))`,
      );
      const [replayed] = await tx
        .select()
        .from(receipts)
        .where(eq(receipts.commandId, input.commandId));
      if (replayed) {
        if (replayed.requestChecksum !== requestChecksum)
          throw new ConflictException("同一核对请求编号已用于不同内容");
        return { receipt: receiptView(replayed), replayed: true };
      }
      const source = await this.load(tx, owner, id, true);
      if (source.fingerprint !== input.expectedFingerprint)
        throw new ConflictException("调用或预算依据已变化 请重新读取后核对");
      if (source.blockers.length) throw new ConflictException(source.blockers[0]);
      if (source.providerRequestId !== null && source.providerRequestId !== input.providerRequestId)
        throw new ConflictException("凭证请求号与原渠道记录不一致");
      const [duplicate] = await tx
        .select({ id: receipts.id })
        .from(receipts)
        .where(
          and(
            eq(receipts.proofChecksum, input.proofChecksum),
            eq(receipts.invoiceReference, input.invoiceReference),
            eq(receipts.providerRequestId, input.providerRequestId),
            sql`(${receipts.owner}<>${owner} or ${receipts.subjectId}<>${id}::uuid)`,
          ),
        )
        .limit(1);
      if (duplicate) throw new ConflictException("同一凭证原请求已关联其他调用 请核对后处理");
      let budgetImpact: null | {
        ledgerId: string;
        beforeState: "reserved" | "committed" | "released" | null;
        beforeAmountUsd: string | null;
        afterState: "committed";
        afterAmountUsd: string;
        periodStartedAt: string;
      } = null;
      if (source.assist) {
        const { run, budget, provider } = source.assist,
          amount = modelBillingBudgetAmount(input.amountUsd),
          ledgerId = budget?.id ?? createEntityId();
        if (!budget) {
          if (!provider) throw new ConflictException("原渠道类型记录缺失");
          await tx.insert(ledger).values({
            id: ledgerId,
            tenantId: context.tenantId,
            requestId: run.id,
            taskType: run.kind,
            modelKey: run.modelSnapshot.model,
            provider,
            amountUsd: amount,
            state: "committed",
            createdAt: sql`(select ${runs.createdAt} from ${runs} where ${runs.id}=${run.id})`,
          });
        }
        budgetImpact = {
          ledgerId,
          beforeState: budget ? (budget.state as "reserved" | "committed" | "released") : null,
          beforeAmountUsd: budget?.amountUsd ?? null,
          afterState: "committed",
          afterAmountUsd: amount,
          periodStartedAt: budget?.periodStartedAt ?? run.periodStartedAt,
        };
      }
      const previous = source.history[0],
        receiptId = createEntityId();
      const [created] = await tx
        .insert(receipts)
        .values({
          id: receiptId,
          tenantId: context.tenantId,
          owner,
          subjectId: id,
          assistRunId: owner === "assist" ? id : null,
          podInvocationId: owner === "pod" ? id : null,
          sequence: (previous?.sequence ?? 0) + 1,
          previousId: previous?.id ?? null,
          commandId: input.commandId,
          requestChecksum,
          basisFingerprint: source.fingerprint,
          amountUsd: input.amountUsd,
          evidenceKind: input.evidenceKind,
          invoiceReference: input.invoiceReference,
          providerRequestId: input.providerRequestId,
          proofChecksum: input.proofChecksum,
          budgetLedgerId: budgetImpact?.ledgerId ?? null,
          budgetImpact,
          checkedBy: actor.userId,
        })
        .returning();
      await recordAuditInTransaction(tx, actor, {
        action: "model_billing.reconciled",
        resourceType: "model_billing_reconciliation",
        resourceId: receiptId,
        result: "success",
        metadata: {
          owner,
          subjectId: id,
          sequence: created!.sequence,
          proofChecksum: input.proofChecksum,
          amountUsd: input.amountUsd,
          budgetImpact,
        },
      });
      return { receipt: receiptView(created!), replayed: false };
    });
  }
}
