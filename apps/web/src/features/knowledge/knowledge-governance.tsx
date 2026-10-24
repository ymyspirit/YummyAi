"use client";
import { useState } from "react";
import Link from "next/link";
import { Plus, RefreshCw } from "lucide-react";
import {
  KnowledgeGovernanceViewSchema,
  type KnowledgeGovernanceView,
} from "@yummyai/contracts/knowledge/governance";
import type { KnowledgeSearch, KnowledgeWorkspace } from "@yummyai/contracts/knowledge";
import { TaskDrawer, TaskDrawerActions } from "../navigation/task-drawer";
import { governanceApi } from "./knowledge-api";
import { KnowledgeScopeForm, KnowledgeCardChoices } from "./knowledge-shared";
import { KnowledgeImports } from "./knowledge-imports";
import { KnowledgeEvaluations } from "./knowledge-evaluations";
import { KnowledgeBenchmarkWorkspace } from "./knowledge-benchmark-workspace";
const scopeBlank = (): KnowledgeSearch => ({
  query: "",
  topic: "all",
  platform: "all",
  market: "ALL",
  spuIds: [],
});
const names = {
  covered: "已覆盖",
  missing: "缺失",
  expired: "过期",
  in_review: "待审核",
  scope_mismatch: "范围不符",
  conflict: "冲突待处理",
};
const reviewNames = {
  pending: "待审核",
  no_business_change: "无业务变化",
  revision_required: "需修订",
  needs_evidence: "待补证据",
  completed: "已完成",
};
const tabs = [
  ["changes", "变更审核"],
  ["coverage", "覆盖矩阵"],
  ["freshness", "时效监控"],
  ["evaluation", "质量评测"],
  ["benchmark", "固定数据集与实验"],
  ["account", "账户证据"],
  ["conflicts", "冲突风险"],
] as const;
export function KnowledgeGovernance({
  data,
  library,
  onChanged,
}: {
  data: KnowledgeGovernanceView;
  library: KnowledgeWorkspace;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<(typeof tabs)[number][0]>("changes"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [sourceOpen, setSourceOpen] = useState(false),
    [source, setSource] = useState({
      label: "",
      url: "",
      owner: "",
      checkEveryHours: 24,
      freshnessDays: 30,
      monitoring: false,
    });
  const [review, setReview] = useState<KnowledgeGovernanceView["sourceReviews"][number] | null>(
      null,
    ),
    [reviewDecision, setReviewDecision] = useState<
      "no_business_change" | "revision_required" | "needs_evidence" | "completed"
    >("revision_required"),
    [reviewEntries, setReviewEntries] = useState<string[]>([]),
    [reviewReason, setReviewReason] = useState("");
  const [needOpen, setNeedOpen] = useState(false),
    [needId, setNeedId] = useState(""),
    [needRevision, setNeedRevision] = useState(0),
    [question, setQuestion] = useState(""),
    [owner, setOwner] = useState(""),
    [scope, setScope] = useState<KnowledgeSearch>(scopeBlank),
    [needEntries, setNeedEntries] = useState<string[]>([]);
  const [conflict, setConflict] = useState<KnowledgeGovernanceView["conflicts"][number] | null>(
      null,
    ),
    [conflictDecision, setConflictDecision] = useState<
      "conditional" | "superseded" | "needs_evidence"
    >("needs_evidence"),
    [conflictReason, setConflictReason] = useState("");
  const [audit, setAudit] = useState<Array<{
    action: string;
    reason: string;
    createdAt: string;
  }> | null>(null);
  const run = async (action: () => Promise<unknown>, success: string, close?: () => void) => {
    setBusy(true);
    setError("");
    try {
      await action();
      onChanged();
      close?.();
      setNotice(success);
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作未完成");
    } finally {
      setBusy(false);
    }
  };
  const showReview = async (row: KnowledgeGovernanceView["sourceReviews"][number]) => {
    setBusy(true);
    setError("");
    try {
      const value = KnowledgeGovernanceViewSchema.shape.sourceReviews.element.parse(
        await governanceApi("source-reviews/" + row.id),
      );
      setReview(value);
      setReviewEntries(value.entryIds);
      setReviewReason("");
      setReviewDecision("revision_required");
    } catch (e) {
      setError(e instanceof Error ? e.message : "来源差异读取失败");
    } finally {
      setBusy(false);
    }
  };
  const showAudit = async (id: string) => {
    setBusy(true);
    setError("");
    try {
      setAudit(
        (await governanceApi(id + "/history")) as Array<{
          action: string;
          reason: string;
          createdAt: string;
        }>,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "审核记录读取失败");
    } finally {
      setBusy(false);
    }
  };
  const newNeed = () => {
    setNeedId("");
    setNeedRevision(0);
    setQuestion("");
    setOwner("");
    setScope(scopeBlank());
    setNeedEntries([]);
    setNeedOpen(true);
  };
  return (
    <section className="kb-expanded" aria-label="知识治理中心">
      <nav className="kb-tabs kb-subtabs" aria-label="治理功能">
        {tabs.map(([id, title]) => (
          <button
            key={id}
            aria-current={tab === id ? "page" : undefined}
            onClick={() => {
              setTab(id);
              setError("");
            }}
          >
            {title}
          </button>
        ))}
      </nav>
      {error && (
        <p className="kb-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {tab === "changes" && (
        <>
          <div className="kb-section-toolbar">
            <p className="kb-meta">
              官方来源变化只进入待办。审核来源差异、修订知识正文并确认发布后，AI 才使用新版本。
            </p>
            {data.canManage && (
              <button className="oc-button primary" onClick={() => setSourceOpen(true)}>
                <Plus size={14} />
                登记官方来源
              </button>
            )}
          </div>
          {!data.sources.length ? (
            <p className="kb-empty">尚未登记官方来源。请登记需要核对的公开原文地址。</p>
          ) : (
            <div className="kb-rows">
              {data.sources.map((s) => (
                <div key={s.id} className="kb-row">
                  <div>
                    <a href={s.url} target="_blank" rel="noopener noreferrer">
                      {s.label}
                    </a>
                    <p className="kb-meta">
                      负责人 {s.owner} ·{" "}
                      {s.monitoring ? "自动监控，每 " + s.checkEveryHours + " 小时" : "手动检查"} ·
                      证据有效期 {s.freshnessDays} 天
                    </p>
                    <p className="kb-meta">
                      成功检查：
                      {s.lastSuccessAt
                        ? new Date(s.lastSuccessAt).toLocaleString("zh-CN")
                        : "尚无"}{" "}
                      · 下次检查：{s.dueAt ? new Date(s.dueAt).toLocaleString("zh-CN") : "未安排"}
                    </p>
                    {s.lastError && <p className="kb-warning">{s.lastError}</p>}
                    {s.latestSnapshotId && (
                      <p className="kb-meta">最新证据版本：{s.latestSnapshotId}</p>
                    )}
                  </div>
                  <div className="kb-inline-actions">
                    {data.canManage && (
                      <>
                        <button
                          className="oc-button"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () => governanceApi("sources/" + s.id + "/check", {}),
                              "来源检查已完成；请查看检查状态及变更队列。",
                            )
                          }
                        >
                          <RefreshCw size={14} />
                          检查更新
                        </button>
                        <button
                          className="oc-button"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () =>
                                governanceApi("sources/" + s.id + "/control", {
                                  expectedRevision: s.revision,
                                  monitoring: !s.monitoring,
                                  checkEveryHours: s.checkEveryHours,
                                  freshnessDays: s.freshnessDays,
                                }),
                              s.monitoring
                                ? "自动监控已暂停。"
                                : "自动监控已启用，来源变化仍需人工审核。",
                            )
                          }
                        >
                          {s.monitoring ? "暂停监控" : "启用监控"}
                        </button>
                        <button
                          className="oc-button"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () =>
                                governanceApi("sources/" + s.id + "/archive", {
                                  expectedRevision: s.revision,
                                  reason: "运营人员明确停止跟踪并归档此来源",
                                }),
                              "来源已归档，关联证据不再供新检索使用。",
                            )
                          }
                        >
                          归档
                        </button>
                      </>
                    )}
                    {data.canPublish && (
                      <button className="oc-button" onClick={() => void showAudit(s.id)}>
                        记录
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          <h3 className="kb-section-title">来源变更队列</h3>
          {!data.sourceReviews.length ? (
            <p className="kb-empty">尚无检测到的来源变更。</p>
          ) : (
            <div className="kb-rows">
              {data.sourceReviews.map((r) => (
                <div className="kb-row" key={r.id}>
                  <div>
                    <strong>{r.sourceLabel}</strong>
                    <p className="kb-meta">
                      {reviewNames[r.state]} · {new Date(r.createdAt).toLocaleString("zh-CN")} ·
                      关联 {r.entryIds.length} 条知识
                    </p>
                    {r.reason && <p className="kb-prose">{r.reason}</p>}
                  </div>
                  <button className="oc-button" disabled={busy} onClick={() => void showReview(r)}>
                    查看来源差异与审核
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {tab === "coverage" && (
        <>
          <div className="kb-section-toolbar">
            <p>
              {data.coverage.length
                ? "已覆盖 " +
                  data.coverage.filter((n) => n.status === "covered").length +
                  " / 已确认需求 " +
                  data.coverage.length
                : "尚未定义知识需求，暂不计算覆盖率。"}
            </p>
            {data.canManage && (
              <button className="oc-button primary" onClick={newNeed}>
                <Plus size={14} />
                登记知识需求
              </button>
            )}
          </div>
          <div className="kb-rows">
            {data.coverage.map((n) => (
              <div className="kb-row" key={n.id}>
                <div>
                  <strong>{n.question}</strong>
                  <p className={n.status === "covered" ? "kb-meta" : "kb-warning"}>
                    {names[n.status]} · {n.scope.platform}/{n.scope.market} · {n.owner}
                  </p>
                  {n.reasons.map((reason, i) => (
                    <p className="kb-meta" key={i}>
                      {reason}
                    </p>
                  ))}
                  {n.entryIds.map((id) => (
                    <Link href={"/knowledge?entry=" + id} key={id}>
                      关联知识卡{" "}
                    </Link>
                  ))}
                </div>
                {data.canManage && (
                  <button
                    className="oc-button"
                    onClick={() => {
                      setNeedId(n.id);
                      setNeedRevision(n.revision);
                      setQuestion(n.question);
                      setOwner(n.owner);
                      setScope(n.scope);
                      setNeedEntries(n.entryIds);
                      setNeedOpen(true);
                    }}
                  >
                    编辑需求与关联
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      {tab === "freshness" && (
        <>
          <p className="kb-meta">
            卡片复查期、来源证据有效期和原件保留期分别记录。读取失败不会延长证据有效期。
          </p>
          {!data.freshness.length ? (
            <p className="kb-empty">暂无可监控的知识或证据。</p>
          ) : (
            <div className="kb-rows">
              {data.freshness.map((f, i) => (
                <div className="kb-row" key={f.kind + f.id + i}>
                  <div>
                    <strong>{f.label}</strong>
                    <p className={f.status === "有效" ? "kb-meta" : "kb-warning"}>
                      {{ card: "知识卡", source: "官方来源", document: "原资料" }[f.kind]} ·{" "}
                      {f.status} · {f.due || "未登记有效证据"}
                    </p>
                    <p className="kb-meta">{f.reason}</p>
                  </div>
                  {f.kind === "card" ? (
                    <Link className="oc-button" href={"/knowledge?entry=" + f.id}>
                      修订复查
                    </Link>
                  ) : f.kind === "document" ? (
                    <Link className="oc-button" href={"/knowledge?tab=imports&document=" + f.id}>
                      查看证据
                    </Link>
                  ) : (
                    <button className="oc-button" onClick={() => setTab("changes")}>
                      来源检查
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {tab === "evaluation" && (
        <KnowledgeEvaluations data={data} library={library} onChanged={onChanged} />
      )}
      {tab === "benchmark" && <KnowledgeBenchmarkWorkspace />}
      {tab === "account" && (
        <KnowledgeImports data={data} library={library} onChanged={onChanged} accountOnly />
      )}
      {tab === "conflicts" && (
        <>
          <p className="kb-meta">
            比较知识卡登记的主张、适用条件与有效期。未登记的正文仍需人工核验；条件差异、被取代内容和矛盾分别处理。生产规则继续使用规则中心的可信执行与验收流程。
          </p>
          {!data.conflicts.length ? (
            <p className="kb-empty">
              暂无检测到的主张冲突。可在知识卡编辑中登记需要核对的关键主张。
            </p>
          ) : (
            <div className="kb-rows">
              {data.conflicts.map((c) => (
                <div key={c.id} className="kb-conflict">
                  <div className="kb-section-toolbar">
                    <strong>
                      {c.key} · {c.severity === "blocking" ? "阻断级" : "需核对"} ·{" "}
                      {
                        {
                          open: "待裁决",
                          conditional: "已确认条件差异",
                          superseded: "已取代",
                          needs_evidence: "待补证据",
                        }[c.state]
                      }
                    </strong>
                    {data.canPublish && (
                      <button
                        className="oc-button"
                        onClick={() => {
                          setConflict(c);
                          setConflictReason("");
                          setConflictDecision("needs_evidence");
                        }}
                      >
                        人工裁决
                      </button>
                    )}
                  </div>
                  <div className="kb-diff-values">
                    <p>
                      <Link href={"/knowledge?entry=" + c.leftEntryId}>{c.leftTitle}</Link>
                      <br />
                      {c.leftValue}
                      <br />
                      {c.leftCondition}
                      <br />
                      来源：{c.leftSource}
                    </p>
                    <p>
                      <Link href={"/knowledge?entry=" + c.rightEntryId}>{c.rightTitle}</Link>
                      <br />
                      {c.rightValue}
                      <br />
                      {c.rightCondition}
                      <br />
                      来源：{c.rightSource}
                    </p>
                  </div>
                  {c.reason && <p className="kb-prose">裁决依据：{c.reason}</p>}
                  {data.canPublish && (
                    <button className="kb-text-button" onClick={() => void showAudit(c.id)}>
                      查看裁决记录
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {sourceOpen && (
        <TaskDrawer
          state={{ dirty: !!source.label || !!source.url || !!source.owner, busy, loading: false }}
          title="登记官方来源"
          onClose={() => !busy && setSourceOpen(false)}
          footer={
            <TaskDrawerActions>
              <button className="oc-button" onClick={() => setSourceOpen(false)}>
                取消
              </button>
              <button
                className="oc-button primary"
                form="kb-source-form"
                type="submit"
                disabled={busy}
              >
                保存来源
              </button>
            </TaskDrawerActions>
          }
        >
          <form
            className="kb-form"
            id="kb-source-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                () =>
                  governanceApi("sources/create", { ...source, requestId: crypto.randomUUID() }),
                "来源已登记，可显式检查更新。",
                () => setSourceOpen(false),
              );
            }}
          >
            <label>
              来源名称
              <input
                required
                maxLength={240}
                value={source.label}
                onChange={(e) => setSource((v) => ({ ...v, label: e.target.value }))}
              />
            </label>
            <label>
              公开 HTTPS 原文地址
              <input
                required
                type="url"
                maxLength={2000}
                value={source.url}
                onChange={(e) => setSource((v) => ({ ...v, url: e.target.value }))}
              />
            </label>
            <label>
              负责人
              <input
                required
                maxLength={100}
                value={source.owner}
                onChange={(e) => setSource((v) => ({ ...v, owner: e.target.value }))}
              />
            </label>
            <div className="kb-form-grid">
              <label>
                检查间隔（小时）
                <input
                  type="number"
                  min={6}
                  max={720}
                  value={source.checkEveryHours}
                  onChange={(e) =>
                    setSource((v) => ({ ...v, checkEveryHours: Number(e.target.value) }))
                  }
                />
              </label>
              <label>
                证据有效期（天）
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={source.freshnessDays}
                  onChange={(e) =>
                    setSource((v) => ({ ...v, freshnessDays: Number(e.target.value) }))
                  }
                />
              </label>
            </div>
            <label className="kb-checkbox">
              <input
                type="checkbox"
                checked={source.monitoring}
                onChange={(e) => setSource((v) => ({ ...v, monitoring: e.target.checked }))}
              />
              启用周期检查；变更只进入审核队列
            </label>
            {error && (
              <p role="alert" className="kb-error">
                {error}
              </p>
            )}
          </form>
        </TaskDrawer>
      )}
      {review && (
        <TaskDrawer
          state={{ dirty: !!reviewReason, busy, loading: false }}
          title="审核官方来源变更"
          description={review?.sourceLabel}
          onClose={() => !busy && setReview(null)}
          footer={
            <TaskDrawerActions>
              {data.canPublish && (
                <button
                  className="oc-button primary"
                  disabled={busy || !reviewReason.trim()}
                  onClick={() =>
                    review &&
                    void run(
                      () =>
                        governanceApi("source-reviews/" + review.id + "/review", {
                          expectedRevision: review.revision,
                          decision: reviewDecision,
                          entryIds: reviewEntries,
                          reason: reviewReason,
                        }),
                      "来源审核决定已记录。知识仍需独立编辑、预览差异并确认发布。",
                      () => setReview(null),
                    )
                  }
                >
                  记录审核决定
                </button>
              )}
            </TaskDrawerActions>
          }
        >
          {review && (
            <div className="kb-form">
              <KnowledgeSourceDifference before={review.beforeText} after={review.afterText} />
              <KnowledgeCardChoices
                entries={library.entries}
                value={reviewEntries}
                onChange={setReviewEntries}
              />
              {reviewEntries.map((id) => (
                <Link
                  key={id}
                  href={
                    "/knowledge?entry=" + id + "&revise=1&sourceSnapshot=" + review.afterSnapshotId
                  }
                >
                  编辑知识正文并关联本次来源证据
                </Link>
              ))}
              <p className="kb-meta">
                来源差异展示原文变化；知识卡的正文与范围差异在知识审核发布时单独预览。
              </p>
              <label>
                审核决定
                <select
                  aria-label="审核决定"
                  value={reviewDecision}
                  onChange={(e) => setReviewDecision(e.target.value as typeof reviewDecision)}
                >
                  <option value="revision_required">需要修订知识卡</option>
                  <option value="no_business_change">无业务变化</option>
                  <option value="needs_evidence">要求补充证据</option>
                  <option value="completed">知识已修订发布，完成审核</option>
                </select>
              </label>
              <label>
                决定依据
                <textarea
                  rows={3}
                  maxLength={1000}
                  value={reviewReason}
                  onChange={(e) => setReviewReason(e.target.value)}
                />
              </label>
              {error && (
                <p role="alert" className="kb-error">
                  {error}
                </p>
              )}
            </div>
          )}
        </TaskDrawer>
      )}
      {needOpen && (
        <TaskDrawer
          state={{ dirty: !!question || !!owner, busy, loading: false }}
          title={needId ? "编辑知识需求" : "登记知识需求"}
          description="明确平台、站点、产品与所需知识。范围不符、过期或未发布的卡片不计入覆盖。"
          onClose={() => !busy && setNeedOpen(false)}
          footer={
            <TaskDrawerActions>
              <button className="oc-button" onClick={() => setNeedOpen(false)}>
                取消
              </button>
              {needId && (
                <button
                  className="oc-button"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () =>
                        governanceApi("needs/" + needId + "/archive", {
                          expectedRevision: needRevision,
                          reason: "运营人员明确归档此知识需求",
                        }),
                      "需求已归档。",
                      () => setNeedOpen(false),
                    )
                  }
                >
                  归档需求
                </button>
              )}
              <button
                className="oc-button primary"
                form="kb-need-form"
                type="submit"
                disabled={busy}
              >
                确认需求与关联
              </button>
            </TaskDrawerActions>
          }
        >
          <form
            id="kb-need-form"
            className="kb-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                () =>
                  governanceApi(needId ? "needs/" + needId + "/save" : "needs/create", {
                    question,
                    owner,
                    scope: { ...scope, query: question.slice(0, 300) },
                    entryIds: needEntries,
                    confirmed: true,
                    expectedRevision: needRevision,
                    requestId: crypto.randomUUID(),
                  }),
                "知识需求已确认，覆盖状态已重新核对。",
                () => setNeedOpen(false),
              );
            }}
          >
            <label>
              知识需求
              <textarea
                required
                maxLength={500}
                rows={3}
                placeholder="例如：Amazon US 照片抱枕的客户照片要求"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
              />
            </label>
            <label>
              负责人
              <input
                required
                value={owner}
                maxLength={100}
                onChange={(e) => setOwner(e.target.value)}
              />
            </label>
            <KnowledgeScopeForm value={scope} onChange={setScope} spus={library.spus} />
            <KnowledgeCardChoices
              entries={library.entries}
              value={needEntries}
              onChange={setNeedEntries}
            />
            {error && (
              <p role="alert" className="kb-error">
                {error}
              </p>
            )}
          </form>
        </TaskDrawer>
      )}
      {conflict && (
        <TaskDrawer
          state={{ dirty: !!conflictReason, busy, loading: false }}
          title="人工裁决知识冲突"
          onClose={() => !busy && setConflict(null)}
          footer={
            <TaskDrawerActions>
              <button className="oc-button" onClick={() => setConflict(null)}>
                取消
              </button>
              <button
                className="oc-button primary"
                disabled={busy || !conflictReason.trim()}
                onClick={() =>
                  conflict &&
                  void run(
                    () =>
                      governanceApi("conflicts/" + conflict.id + "/resolve", {
                        expectedRevision: conflict.revision,
                        decision: conflictDecision,
                        reason: conflictReason,
                      }),
                    "裁决已记录；不自动修改知识正文或放行生产。",
                    () => setConflict(null),
                  )
                }
              >
                确认裁决
              </button>
            </TaskDrawerActions>
          }
        >
          {conflict && (
            <div className="kb-form">
              <p className="kb-prose">
                {conflict.leftTitle}：{conflict.leftValue}
                <br />
                {conflict.rightTitle}：{conflict.rightValue}
              </p>
              <label>
                裁决
                <select
                  aria-label="裁决"
                  value={conflictDecision}
                  onChange={(e) => setConflictDecision(e.target.value as typeof conflictDecision)}
                >
                  <option value="needs_evidence">需要补充证据，风险保留</option>
                  <option value="conditional">确认属于不同适用条件</option>
                  <option value="superseded">已停用被取代版本</option>
                </select>
              </label>
              <label>
                裁决依据
                <textarea
                  rows={4}
                  maxLength={1000}
                  value={conflictReason}
                  onChange={(e) => setConflictReason(e.target.value)}
                />
              </label>
              <p className="kb-meta">
                相同适用条件不能裁决为条件差异。矛盾版本需先显式停用被取代知识，再完成裁决。
              </p>
              {error && (
                <p role="alert" className="kb-error">
                  {error}
                </p>
              )}
            </div>
          )}
        </TaskDrawer>
      )}
      {audit && (
        <TaskDrawer
          state={{ dirty: false, busy: false, loading: false }}
          title="知识治理审计记录"
          onClose={() => setAudit(null)}
        >
          {audit?.length ? (
            audit.map((a, i) => (
              <div className="kb-candidate" key={i}>
                <strong>{a.action}</strong>
                <p>{a.reason}</p>
                <p className="kb-meta">{new Date(a.createdAt).toLocaleString("zh-CN")}</p>
              </div>
            ))
          ) : (
            <p className="kb-empty">暂无记录。</p>
          )}
        </TaskDrawer>
      )}
    </section>
  );
}
function KnowledgeSourceDifference({ before, after }: { before: string; after: string }) {
  const a = before.split(/\n\s*\n/),
    b = after.split(/\n\s*\n/);
  let start = 0,
    end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  return (
    <section aria-label="官方来源正文差异">
      <p className="kb-meta">前后相同 {start + end} 段 · 以下显示发生变化的原文区间</p>
      <div className="kb-diff-values">
        <div className="kb-source-before">
          <strong>之前来源</strong>
          <p className="kb-prose">
            {a.slice(start, a.length - end).join("\n\n") || "该区间无原文"}
          </p>
        </div>
        <div className="kb-source-after">
          <strong>本次来源</strong>
          <p className="kb-prose">
            {b.slice(start, b.length - end).join("\n\n") || "该区间无新文"}
          </p>
        </div>
      </div>
      <details>
        <summary>查看完整来源对照</summary>
        <div className="kb-diff-values">
          <p className="kb-prose">{before}</p>
          <p className="kb-prose">{after}</p>
        </div>
      </details>
    </section>
  );
}
