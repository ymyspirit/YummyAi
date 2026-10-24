"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { z } from "zod";
import { Permission } from "@yummyai/authz/permissions";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import {
  AdCommandDetailSchema, AdCommandListSchema, PrepareAdCommandSchema, adCommandScopeKey,
  type AdCommandKind, type AdCommandScope, type PrepareAdCommand,
} from "@yummyai/contracts/advertising/command";
import { useErpAccess } from "../identity/erp-access";
import { adCommandRequest, adDenied, adError, adMoney, adRecheckSession, AdRequestError, adConversionLabels } from "./advertising-client";

export const adCommandNames: Record<AdCommandKind, string> = {
  import_commit: "广告报表导入", goal_save: "广告目标版本", observation_record: "观察证据",
  analysis_run: "广告分析", action_transition: "广告动作处理", import_archive: "广告来源归档", export_seal: "广告审阅封存",
};
export const adCommandStatusNames = { prepared: "已准备 尚未执行", succeeded: "实际登记成功", cancelled: "准备已取消", expired: "填写副本已到期" };
export const adCommandWrites = new Set<AdCommandKind>(["import_commit", "observation_record", "import_archive"]);
export const adCommandPermission = (kind: AdCommandKind) => adCommandWrites.has(kind) ? Permission.CustomerIntelligenceWrite : Permission.CustomerIntelligenceReview;
export type AdCommandDraftScope = AdCommandScope & { scopeKey?: string };
export function adCommandAccountPath(commandId: string, accountId: string, suffix = "") { return `${commandId}${suffix ? `/${suffix}` : ""}?${new URLSearchParams({ accountId })}`; }

/** Keeps an uncertain prepare's exact body/key only in memory. Known prepared copies live at the API. */
export function useAdCommandMutation(scope: AdCommandDraftScope, enabled: boolean, onDenied?: (message: string) => void, onPrepared?: () => void) {
  const access = useErpAccess();
  const identity = useMemo(() => ({ authority: access.authority, preferenceScope: access.preferenceScope, localDevelopment: access.localDevelopment }), [access.authority, access.preferenceScope, access.localDevelopment]);
  const scopeValid = EntityIdSchema.safeParse(scope.accountId).success && (!["action_transition", "import_archive", "export_seal"].includes(scope.kind) || EntityIdSchema.safeParse(scope.targetId).success);
  const canWrite = scopeValid && enabled && access.can(adCommandPermission(scope.kind));
  const canRead = scopeValid && (access.can(Permission.CustomerIntelligenceRead) || access.can(adCommandPermission(scope.kind)));
  const scopeKey = scope.scopeKey ?? scope.targetId ?? "root", stamp = `${identity.authority}:${identity.preferenceScope}:${scope.accountId}:${scope.kind}:${scope.targetId}:${scopeKey}:${canRead}:${canWrite}`;
  const [commandId, setCommandId] = useState<string | null>(null), [reviewOpen, setReviewOpen] = useState(true);
  const [pending, setPending] = useState(false), [checking, setChecking] = useState(false), [ready, setReady] = useState(false), [frozen, setFrozen] = useState(false), [error, setError] = useState(""), [canEdit, setCanEdit] = useState(false);
  const attempt = useRef<PrepareAdCommand | null>(null), lease = useRef<symbol | null>(null), sequence = useRef(0), live = useRef(true), abort = useRef<AbortController | null>(null), installed = useRef(stamp);
  const current = useRef({ stamp, canRead, canWrite, onDenied, onPrepared }); current.current = { stamp, canRead, canWrite, onDenied, onPrepared };
  const clearPrivate = useCallback(() => { attempt.current = null; setCommandId(null); setFrozen(false); setCanEdit(false); setReviewOpen(true); }, []);
  const deny = useCallback((reason: string) => { clearPrivate(); setReady(false); setChecking(false); setPending(false); adRecheckSession(); current.current.onDenied?.(reason); }, [clearPrivate]);
  const install = useCallback((detail: { id: string }) => { attempt.current = null; setFrozen(false); setCanEdit(false); setCommandId(detail.id); setReviewOpen(true); current.current.onPrepared?.(); }, []);
  const findRetained = useCallback(async (signal: AbortSignal, valid: () => boolean) => {
    let before: string | undefined, unavailable = 0;
    const visited = new Set<string>();
    do {
      const query = new URLSearchParams({ accountId: scope.accountId, kind: scope.kind, targetId: scope.targetId ?? "root", view: "active" });
      if (before) query.set("before", before);
      const page = await adCommandRequest(`?${query}`, AdCommandListSchema, identity, undefined, signal);
      if (!valid()) return { aborted: true, match: null, unavailable: 0 };
      if (page.accountId !== scope.accountId || page.items.some(row => row.kind !== scope.kind || row.targetId !== scope.targetId || row.acknowledged)) throw new AdRequestError(502, "原提交列表与这次固定账户 操作或目标不一致");
      const retained = attempt.current;
      const match = page.items.find(row => row.scopeKey === scopeKey && (!retained || row.requestKey === retained.input.idempotencyKey));
      if (match) return { aborted: false, match, unavailable: 0 };
      unavailable += page.unavailableCount; before = page.nextCursor ?? undefined;
      if (before && visited.has(before)) throw new AdRequestError(502, "原提交分页位置没有推进 暂不另建提交键 请到本人原提交核对");
      if (before) visited.add(before);
    } while (before);
    return { aborted: false, match: null, unavailable };
  }, [scope.accountId, scope.kind, scope.targetId, scopeKey, identity]);
  const reload = useCallback(async () => {
    if (!current.current.canRead || lease.current || !EntityIdSchema.safeParse(scope.accountId).success) return;
    const token = ++sequence.current, captured = stamp; abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    const valid = () => live.current && !controller.signal.aborted && sequence.current === token && current.current.stamp === captured && current.current.canRead;
    setChecking(true); setReady(false); setError("");
    try {
      const found = await findRetained(controller.signal, valid); if (!valid() || found.aborted) return;
      if (found.match) install(found.match);
      else if (found.unavailable) setError("此操作仍有暂不可访问的本人原提交 请先到本人原提交核对 不另建提交键");
      else setReady(true);
    } catch (failure) { if (valid()) { if (adDenied(failure)) deny(adError(failure)); setError(adError(failure)); } }
    finally { if (valid()) setChecking(false); }
  }, [scope.accountId, stamp, findRetained, install, deny]);
  useLayoutEffect(() => { installed.current = stamp; sequence.current++; abort.current?.abort(); lease.current = null; clearPrivate(); setPending(false); setChecking(false); setReady(false); setError(""); }, [stamp, clearPrivate]);
  useEffect(() => { live.current = true; if (canRead) void reload(); return () => { live.current = false; sequence.current++; abort.current?.abort(); attempt.current = null; }; }, [canRead, reload]);
  async function submit<S extends z.ZodType>(_path: string, build: () => unknown, _businessSchema: S): Promise<z.output<S> | null> {
    void _businessSchema; // The old form signature remains an adapter; prepare never claims a business result.
    if (lease.current || checking || commandId || !current.current.canWrite || !ready && !attempt.current) return null;
    const token = ++sequence.current, captured = stamp, owner = Symbol("ad-command-prepare");
    const valid = () => live.current && sequence.current === token && current.current.stamp === captured && current.current.canWrite;
    try {
      const original = attempt.current ?? PrepareAdCommandSchema.parse({ kind: scope.kind, accountId: scope.accountId, targetId: scope.targetId, input: build() });
      if (original.kind !== scope.kind || original.accountId !== scope.accountId || original.targetId !== scope.targetId || adCommandScopeKey(original) !== scopeKey) throw new AdRequestError(400, "原填写与本次账户 操作或产品范围不一致");
      attempt.current = original; lease.current = owner; setPending(true); setFrozen(true); setCanEdit(false); setError("");
      const value = await adCommandRequest("", AdCommandDetailSchema, identity, original);
      if (!valid()) return null;
      if (value.kind !== original.kind || value.accountId !== original.accountId || value.targetId !== original.targetId || value.scopeKey !== scopeKey || value.requestKey !== original.input.idempotencyKey) throw new AdRequestError(502, "准备回执不匹配原账户 目标或原键 请读取本人原提交核对");
      install(value);
    } catch (failure) {
      if (!valid()) return null;
      if (adDenied(failure)) deny(adError(failure));
      else { setError(adError(failure)); setCanEdit(failure instanceof AdRequestError && [400, 409, 413, 422].includes(failure.status)); setFrozen(Boolean(attempt.current)); }
    } finally { if (lease.current === owner) { lease.current = null; if (valid()) setPending(false); } }
    return null;
  }
  const finish = () => { sequence.current++; clearPrivate(); setReady(false); setError(""); void reload(); };
  const reset = () => { if (!lease.current && canEdit && current.current.canWrite) finish(); };
  const visible = installed.current === stamp && canRead;
  return { pending: visible && pending, checking: visible && (checking || !ready && !error && !commandId && !frozen), frozen: visible && frozen, error: visible ? error : "", canEdit: visible && canEdit,
    result: null, durable: true, commandId: visible ? commandId : null, reviewOpen, locked: !visible || !ready || checking || pending || frozen || Boolean(commandId),
    submit, reset, reload, finish, closeReview: () => setReviewOpen(false), openReview: () => setReviewOpen(true) };
}
export type AdCommandMutation = ReturnType<typeof useAdCommandMutation>;

function Pair({ label, children }: { label: string; children: ReactNode }) { return <div><dt>{label}</dt><dd>{children}</dd></div>; }
function OriginalText({ text, label }: { text: string; label: string }) {
  const [page, setPage] = useState(0), lines = useMemo(() => text.split("\n"), [text]), size = 100, pages = Math.max(1, Math.ceil(lines.length / size)), selected = Math.min(page, pages - 1);
  return <details className="ad-command-source"><summary>{label} · 完整原文 {text.length} 字符</summary><p>原文按文本行显示 不是解析后的 CSV 记录计数 全文共同保留 当前 {selected + 1}／{pages} 页</p><nav><button type="button" disabled={!selected} onClick={() => setPage(value => value - 1)}>上页原文</button><button type="button" disabled={selected + 1 >= pages} onClick={() => setPage(value => value + 1)}>下页原文</button></nav><pre aria-label={label}>{lines.slice(selected * size, (selected + 1) * size).join("\n")}</pre></details>;
}
export function AdCommandOriginalSummary({ original }: { original: PrepareAdCommand }) {
  const input = original.input;
  return <section className="ad-command-original" aria-label="广告原填写全文核对"><h4>{adCommandNames[original.kind]}原填写</h4><dl className="ad-command-pairs"><Pair label="原广告账户"><code>{original.accountId}</code></Pair><Pair label="原固定业务目标"><code>{original.targetId ?? "新建范围"}</code></Pair><Pair label="原请求键"><code>{input.idempotencyKey}</code></Pair></dl>
    {original.kind === "import_commit" ? <><dl className="ad-command-pairs"><Pair label="原报告时区">{original.input.timezone}</Pair><Pair label="原采集时间">{original.input.observedAt}</Pair><Pair label="原声明归因">{original.input.attributionBasis} · {original.input.attributionWindowDays ?? "未知"} 天</Pair><Pair label="原转化指标定义">{original.input.conversionDefinition ? `${adConversionLabels[original.input.conversionDefinition.model]} · ${original.input.conversionDefinition.source || "无人工依据"}` : "原请求未填写 不补默认口径"}</Pair><Pair label="原日期顺序">{original.input.dateOrder ?? "仅无歧义日期"}</Pair><Pair label="原币种站点映射">{Object.entries(original.input.marketplaceByCurrency).map(([currency, site]) => `${currency}=${site}`).join(" · ") || "未填写"}</Pair><Pair label="原部分导入选择">{original.input.allowPartial ? "保留可用行并隔离错误行" : "不接受错误行"}</Pair><Pair label="固定预览校验值"><code>{original.input.previewChecksum}</code></Pair></dl>{original.input.files.map((file, index) => <section key={index}><h5>原文件 {index + 1} · {file.fileName}</h5><p>原报告提示 {file.reportTypeHint ?? "自动识别"} · 广告产品提示 {file.adProductHint ?? "未知"}</p><dl className="ad-command-pairs">{Object.entries(file.metricColumns ?? {}).map(([metric, column]) => <Pair label={`原指标列 ${metric}`} key={metric}>{column ?? "明确不采用"}</Pair>)}</dl><OriginalText key={index} text={file.content} label={`${file.fileName} 原 CSV 文本`} /></section>)}</>
      : original.kind === "goal_save" ? <><dl className="ad-command-pairs"><Pair label="原产品范围">{original.input.scope.asin} · {original.input.scope.marketplace} · {original.input.scope.currency}</Pair><Pair label="固定前版">V{original.input.expectedRevision}</Pair><Pair label="原目标模式">{original.input.fields.mode}</Pair><Pair label="原生效日">{original.input.fields.effectiveFrom}</Pair><Pair label="原目标 ACoS">{original.input.fields.targetAcosBps ?? "未知"} 基点</Pair><Pair label="原售价／成本">{adMoney(original.input.fields.unitPriceMinor, original.input.scope.currency, original.input.fields.monetaryBasis)}／{adMoney(original.input.fields.unitCostMinor, original.input.scope.currency, original.input.fields.monetaryBasis)}</Pair><Pair label="原最少点击／购买">{original.input.fields.minimumClicks}／{original.input.fields.minimumPurchases}</Pair><Pair label="原最少花费">{adMoney(original.input.fields.minimumSpendMinor, original.input.scope.currency, original.input.fields.monetaryBasis)}</Pair><Pair label="原试验结束／花费上限">{original.input.fields.trialEndDate ?? "未设置"} · {adMoney(original.input.fields.trialSpendLimitMinor, original.input.scope.currency, original.input.fields.monetaryBasis)}</Pair><Pair label="原调整上限／利润预留">{original.input.fields.maxBidChangeBps}／{original.input.fields.profitReserveBps} 基点</Pair><Pair label="原观察窗口">{original.input.fields.cooldownDays} 天</Pair><Pair label="原人工说明">{original.input.fields.notes || "未填写"}</Pair></dl><OriginalText text={original.input.fields.coreKeywords.join("\n")} label="原核心关键词" /><OriginalText text={original.input.fields.protectedTerms.join("\n")} label="原保护词" /></>
      : original.kind === "observation_record" ? <dl className="ad-command-pairs"><Pair label="原产品范围">{original.input.scope.asin} · {original.input.scope.marketplace} · {original.input.scope.currency}</Pair><Pair label="原观察类型">{original.input.kind}</Pair><Pair label="原期间">{original.input.periodStart} 至 {original.input.periodEnd}</Pair><Pair label="原采集时间">{original.input.observedAt}</Pair><Pair label="原来源说明">{original.input.source}</Pair><Pair label="原关键词／自然名次">{original.input.keyword ?? "不适用"}／{original.input.organicRank ?? "未填写"}</Pair><Pair label="原总销售额／购买量">{adMoney(original.input.totalSalesMinor, original.input.scope.currency, original.input.monetaryBasis)}／{original.input.totalPurchases ?? "未填写"}</Pair><Pair label="原广告前贡献利润">{adMoney(original.input.preAdContributionMinor, original.input.scope.currency, original.input.monetaryBasis)}</Pair><Pair label="原广告覆盖确认">{original.input.adsCoverageConfirmed ? "已人工确认" : "未确认"}</Pair></dl>
      : original.kind === "analysis_run" ? <dl className="ad-command-pairs"><Pair label="原统计范围">{original.input.periodStart} 至 {original.input.periodEnd}</Pair><Pair label="原站点／币种">{original.input.marketplace ?? "全部站点"}／{original.input.currency ?? "分别按币种"}</Pair><Pair label="固定证据截止时间">{original.input.evidenceCutoffAt}</Pair></dl>
      : original.kind === "action_transition" ? <dl className="ad-command-pairs"><Pair label="固定前版／状态">V{original.input.expectedRevision}／{original.input.expectedStatus}</Pair><Pair label="原拟登记状态">{original.input.status}</Pair><Pair label="原处理原因">{original.input.reason}</Pair><Pair label="原实际执行时间">{original.input.executedAt ?? "未填写"}</Pair><Pair label="原实际前／后金额">{original.input.actualBeforeMinor ?? "未填写"}／{original.input.actualAfterMinor ?? "未填写"} 保存的最小单位 原请求未附币种与精度</Pair><Pair label="原实际执行对象">活动 {original.input.executionCampaignId ?? "未填写"} · 广告组 {original.input.executionAdGroupId ?? "未填写"} · 投放 {original.input.executionTargetId ?? "未填写"}</Pair></dl>
      : original.kind === "import_archive" ? <dl className="ad-command-pairs"><Pair label="原归档原因">{original.input.reason}</Pair></dl>
      : <><dl className="ad-command-pairs"><Pair label="固定原分析 ID"><code>{original.input.runId}</code></Pair><Pair label="原审阅依据">{original.input.reviewReason}</Pair></dl><OriginalText text={original.input.actionIds.join("\n")} label="完整原动作 ID" /></>}
    <p>以上是原提交保存内容 缺失的金额精度或来源不从今天工作区反推 执行时原业务规则仍会重新核验</p>
  </section>;
}
