"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, CircleAlert, FileCheck2, FileSearch, RefreshCw, X } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import type { FinanceCommandKind, FinanceCommandResult } from "@yummyai/contracts/finance/finance-command";
import {
  FinanceCommandRecordedResultSchema, FinanceCommandResultPageSchema,
  type FinanceCommandRecordedResult, type FinanceCommandResultPage, type FinanceCommandResultSection,
} from "@yummyai/contracts/finance/finance-command-result";
import type { FinanceBillBalance, FinancePaymentBalance } from "@yummyai/contracts/finance/payables-adjustments";
import type { FinanceCostAllocationTarget } from "@yummyai/contracts/finance/cost-allocation";
import { formatFinanceMinorAmount } from "@yummyai/contracts/finance/monetary";
import { useErpAccess } from "../identity/erp-access";
import { useOwnedViewTransition } from "../navigation/use-owned-view-transition";
import {
  financeCommandDenied, financeCommandOperationPermission, financeCommandRequest, FinanceCommandRequestError,
  type FinanceCommandIdentity,
} from "../../lib/finance-command-client";
import { financeCommandNames, financeCommandTime } from "./finance-command-summary";
import "./finance-command-result.css";

type Recorded = FinanceCommandRecordedResult["recorded"];
type Progress = { count: number; complete: boolean; failed: boolean };
const sectionNames: Record<FinanceCommandResultSection, string> = {
  facts: "原财务事实", contributions: "原利润贡献", allocations: "本批核销明细",
  cost_sources: "批准费用来源", cost_shares: "批准份额与尾差", slices: "原归属分配行",
};
const problemNames = {
  source_changed: "原费用或证据来源已有变化", target_changed: "原目标依据已有变化",
  rule_superseded: "原规则已有后续版本", base_unavailable: "原汇总依据当前不可完整核对",
  financial_evidence_unverified: "原财务证据当前未通过完整核验",
};
function sameResult(a: FinanceCommandResult, b: FinanceCommandResult) {
  return a.kind === b.kind && a.id === b.id && a.parentId === b.parentId && a.version === b.version;
}
function readMessage(failure: unknown) {
  return failure instanceof FinanceCommandRequestError ? failure.message : "历史结果暂不可读取 请重新读取原保存记录";
}
function rowKeys(page: FinanceCommandResultPage) {
  return page.items.map(row => "id" in row ? row.id : "sourceIndex" in row ? `${row.sourceIndex}:${row.shareIndex}` : row.contributionId);
}

/** Result authority and lifetime are independent of the retained original input. */
export function FinanceCommandResultReader({ commandId, kind, targetId, result, executedAt, onDenied }: {
  commandId: string; kind: FinanceCommandKind; targetId: string | null; result: FinanceCommandResult;
  executedAt: string | null; onDenied?(reason: string): void;
}) {
  const access = useErpAccess();
  const identity = useMemo(() => ({ authority: access.authority, localDevelopment: access.localDevelopment }), [access.authority, access.localDevelopment]);
  const allowed = access.can(Permission.FinanceRead) || access.can(financeCommandOperationPermission(kind));
  const binding = JSON.stringify([commandId, kind, targetId, result.id, result.parentId, result.version, executedAt]);
  const [snapshot, setSnapshot] = useState<{ value: FinanceCommandRecordedResult; binding: string; authority: string | null; token: number } | null>(null);
  const [opened, setOpened] = useState(false), [reading, setReading] = useState(false), [error, setError] = useState("");
  const [revision, setRevision] = useState(0), [progress, setProgress] = useState<Partial<Record<FinanceCommandResultSection, Progress>>>({});
  const live = useRef(true), generation = useRef(0), sequence = useRef(0), controller = useRef<AbortController | null>(null);
  const readButton = useRef<HTMLButtonElement>(null), returnFocus = useRef(false);
  const current = useRef({ identity, binding, allowed }); current.current = { identity, binding, allowed };
  const deniedCallback = useRef(onDenied); deniedCallback.current = onDenied;
  const transition = useOwnedViewTransition();
  const value = allowed && snapshot?.binding === binding && snapshot.authority === identity.authority ? snapshot.value : null;
  const deny = useCallback((reason: string) => {
    generation.current++; sequence.current++; controller.current?.abort(); transition.cancel();
    setSnapshot(null); setProgress({}); setReading(false); setError(reason);
    deniedCallback.current?.(reason);
  }, [transition]);
  useLayoutEffect(() => {
    generation.current++; sequence.current++; controller.current?.abort(); transition.cancel();
    returnFocus.current = false;
    setSnapshot(null); setProgress({}); setOpened(false); setReading(false); setError("");
  }, [identity, binding, allowed, transition]);
  useEffect(() => { live.current = true; return () => { live.current = false; generation.current++; sequence.current++; controller.current?.abort(); transition.cancel(); }; }, [transition]);
  useLayoutEffect(() => { if (returnFocus.current && !opened && !reading) { returnFocus.current = false; readButton.current?.focus({ preventScroll: true }); } }, [opened, reading]);
  const read = async () => {
    if (!current.current.allowed || reading) return;
    const epoch = generation.current, token = ++sequence.current, captured = identity.authority;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setOpened(true); setReading(true); setError(""); setSnapshot(null); setProgress({});
    const valid = () => live.current && epoch === generation.current && token === sequence.current
      && current.current.identity.authority === captured && current.current.binding === binding && current.current.allowed;
    try {
      const saved = await financeCommandRequest(`${commandId}/result`, FinanceCommandRecordedResultSchema, identity, undefined, abort.signal);
      if (!valid()) return;
      if (saved.commandId !== commandId || saved.kind !== kind || saved.targetId !== targetId || !sameResult(saved.result, result)
        || executedAt !== null && saved.executedAt !== executedAt) throw new FinanceCommandRequestError(502, "历史结果与原命令、固定凭据或执行时间不一致 已停止显示");
      if (saved.recorded.kind === "cost_version_approve" && (saved.collections.find(row => row.section === "cost_sources")?.total !== saved.recorded.record.sourceCount
        || saved.collections.find(row => row.section === "cost_shares")?.total !== saved.recorded.record.shareCount)
        || saved.recorded.kind === "payment_allocate" && saved.collections.find(row => row.section === "allocations")?.total !== saved.recorded.record.allocationCount)
        throw new FinanceCommandRequestError(502, "历史结果头与原明细总数不一致 未显示为完整结果");
      transition.change(() => { if (valid()) { setRevision(previous => previous + 1); setSnapshot({ value: saved, binding, authority: captured, token }); } });
    } catch (failure) {
      if (!abort.signal.aborted && valid()) { if (financeCommandDenied(failure)) deny(readMessage(failure)); else setError(readMessage(failure)); }
    } finally { if (valid()) setReading(false); }
  };
  const report = useCallback((token: number, section: FinanceCommandResultSection, next: Progress) => {
    if (!live.current || token !== sequence.current) return;
    setProgress(previous => {
      const old = previous[section];
      return old && old.count === next.count && old.complete === next.complete && old.failed === next.failed ? previous : { ...previous, [section]: next };
    });
  }, []);
  const completeSections = value?.collections.filter(collection => progress[collection.section]?.complete).length ?? 0;
  return <section className="finance-history-result" aria-label="历史执行结果" aria-busy={reading}>
    <header className="finance-history-heading"><h4><FileCheck2 size={16} />历史执行结果</h4><div>
      <button type="button" ref={readButton} disabled={!allowed || reading} onClick={() => void read()}>{opened ? <RefreshCw size={14} /> : <FileSearch size={14} />}{opened ? "重新读取历史执行结果" : "读取历史执行结果"}</button>
      {opened && <button type="button" onClick={() => { generation.current++; sequence.current++; controller.current?.abort(); returnFocus.current = true; setReading(false); transition.change(() => { setOpened(false); setSnapshot(null); setProgress({}); setError(""); }); }}><X size={14} />关闭历史结果</button>}
    </div></header>
    <p className="finance-history-help">独立读取这笔原命令的实际保存结果 无需先取原填写 确认或填写副本到期不会改写历史凭据 此处不发起财务登记</p>
    {!allowed && <Notice error>当前没有核对这类本人历史结果的权限 已清除结果内容</Notice>}
    {opened && <div className="finance-history-view">
      {reading && <p role="status">正在受权读取历史执行结果 尚未显示旧内容</p>}
      {error && <Notice error>{error}</Notice>}
      {value && <>
        <FinanceCommandRecordedHeader value={value} />
        <p className="finance-history-completeness" role="status">{!value.collections.length ? "本结果没有分页明细 结果头已读取" : `已完整读取 ${completeSections}/${value.collections.length} 类明细 ${completeSections === value.collections.length ? "全部明细读取完成" : "明细尚未全部读取"}`}</p>
        {value.collections.map(collection => <ResultSection key={`${revision}:${collection.section}`} root={value} section={collection.section} total={collection.total}
          identity={identity} allowed={allowed} onDenied={deny} onProgress={(section, next) => report(snapshot!.token, section, next)} />)}
      </>}
    </div>}
  </section>;
}

function ResultSection({ root, section, total, identity, allowed, onDenied, onProgress }: {
  root: FinanceCommandRecordedResult; section: FinanceCommandResultSection; total: number; identity: FinanceCommandIdentity; allowed: boolean;
  onDenied(reason: string): void; onProgress(section: FinanceCommandResultSection, value: Progress): void;
}) {
  const [pages, setPages] = useState<FinanceCommandResultPage[]>([]), [index, setIndex] = useState(0), [limit, setLimit] = useState<25 | 100>(25);
  const [reading, setReading] = useState(false), [error, setError] = useState("");
  const live = useRef(true), generation = useRef(0), sequence = useRef(0), controller = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null), moveAfterRead = useRef(false);
  const binding = `${root.commandId}:${root.result.id}:${section}:${total}:${limit}`;
  const state = useRef({ identity, binding, allowed, pages }); state.current = { identity, binding, allowed, pages };
  const callbacks = useRef({ onDenied, onProgress }); callbacks.current = { onDenied, onProgress };
  const transition = useOwnedViewTransition();
  const count = pages.reduce((sum, page) => sum + page.items.length, 0), currentPage = pages[index];
  const complete = pages.length > 0 && !pages[pages.length - 1]!.hasMore && count === total && !reading && !error;
  const read = useCallback(async (cursor?: string, offset = 0) => {
    if (!state.current.allowed) return;
    const epoch = generation.current, token = ++sequence.current, captured = identity.authority;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setReading(true); setError("");
    if (!cursor) { state.current.pages = []; setPages([]); setIndex(0); }
    const valid = () => live.current && epoch === generation.current && token === sequence.current && state.current.allowed
      && state.current.binding === binding && state.current.identity.authority === captured;
    const query = new URLSearchParams({ section, limit: String(limit) }); if (cursor) query.set("cursor", cursor);
    try {
      const page = await financeCommandRequest(`${root.commandId}/result/entries?${query}`, FinanceCommandResultPageSchema, identity, undefined, abort.signal);
      if (!valid()) return;
      if (page.commandId !== root.commandId || !sameResult(page.result, root.result) || page.section !== section || page.total !== total || page.offset !== offset || page.limit !== limit)
        throw new FinanceCommandRequestError(502, "明细页与本笔历史结果、条数或连续位置不一致 未标为完整");
      const previous = cursor ? state.current.pages : [], keys = new Set(previous.flatMap(rowKeys));
      if (rowKeys(page).some(key => keys.has(key)) || page.nextCursor && (page.nextCursor === cursor || previous.some(item => item.nextCursor === page.nextCursor)))
        throw new FinanceCommandRequestError(502, "历史明细出现重复记录或重复续页位置 未标为完整");
      const next = [...previous, page];
      // Independent collections can resolve together. Commit verified data before
      // releasing loading state; visual transitions must not own its delivery.
      if (valid()) { state.current.pages = next; setPages(next); setIndex(next.length - 1); }
    } catch (failure) {
      if (!abort.signal.aborted && valid()) {
        if (financeCommandDenied(failure)) { setPages([]); state.current.pages = []; callbacks.current.onDenied(readMessage(failure)); }
        else setError(readMessage(failure));
      }
    } finally { if (valid()) setReading(false); }
  }, [identity, binding, root.commandId, root.result, section, total, limit, transition]);
  useLayoutEffect(() => {
    generation.current++; sequence.current++; controller.current?.abort(); transition.cancel();
    state.current.pages = []; setPages([]); setIndex(0); setError(""); setReading(false);
    callbacks.current.onProgress(section, { count: 0, complete: false, failed: false });
  }, [identity, binding, allowed, section, transition]);
  useEffect(() => { live.current = true; if (allowed) void read(); return () => { live.current = false; generation.current++; sequence.current++; controller.current?.abort(); transition.cancel(); }; }, [read, allowed, transition]);
  useEffect(() => { callbacks.current.onProgress(section, { count, complete: Boolean(complete), failed: Boolean(error) }); }, [section, count, complete, error]);
  useLayoutEffect(() => {
    if (!moveAfterRead.current || !pages.length || reading || error) return;
    moveAfterRead.current = false; heading.current?.scrollIntoView({ block: "start", behavior: "instant" }); heading.current?.focus({ preventScroll: true });
  }, [pages, index, reading, error]);
  const reportingCurrency = root.recorded.kind === "allocated_profit_calculate" ? root.recorded.record.reportingCurrency : undefined;
  return <section className="finance-history-section" aria-label={sectionNames[section]} aria-busy={reading}>
    <header className="finance-history-heading"><h5 ref={heading} tabIndex={-1}>{sectionNames[section]}</h5><label>{sectionNames[section]}每页条数<select value={limit} disabled={reading} onChange={event => { moveAfterRead.current = true; setLimit(event.target.value === "100" ? 100 : 25); }}><option value="25">25 条</option><option value="100">100 条</option></select></label></header>
    <p className="finance-history-count" role="status">已读 {count}/{total} 条 · {complete ? "本节全部读取完成" : error ? "本节读取失败 未完成" : "本节读取未完成"}{reading ? " · 正在读取" : ""}</p>
    <p className="finance-history-help">按原保存顺序独立分页 不用已读明细相加推算财务总额 {currentPage && `当前显示第 ${currentPage.offset + (currentPage.items.length ? 1 : 0)} 至 ${currentPage.offset + currentPage.items.length} 条`}</p>
    {error && <Notice error>{error} 已保存的历史内容未被修改 可重读本节</Notice>}
    <footer className="finance-history-pagination">
      <button type="button" aria-label={`${sectionNames[section]}重新读取本节`} disabled={reading || !allowed} onClick={() => { moveAfterRead.current = true; void read(); }}><RefreshCw size={14} />重新读取本节</button>
      {error && pages[pages.length - 1]?.nextCursor && <button type="button" aria-label={`${sectionNames[section]}重试未完成页`} disabled={reading || !allowed} onClick={() => {
        const last = pages[pages.length - 1]!; if (last.nextCursor) { moveAfterRead.current = true; void read(last.nextCursor, last.offset + last.items.length); }
      }}><RefreshCw size={14} />重试未完成页</button>}
      <button type="button" aria-label={`${sectionNames[section]}返回已读前页`} disabled={reading || index === 0} onClick={() => { moveAfterRead.current = true; transition.change(() => setIndex(previous => previous > 0 ? previous - 1 : 0)); }}><ChevronLeft size={14} />返回已读前页</button>
      <button type="button" aria-label={`${sectionNames[section]}读取下一页`} disabled={reading || Boolean(error) || !currentPage?.hasMore} onClick={() => {
        moveAfterRead.current = true;
        if (index + 1 < pages.length) transition.change(() => setIndex(previous => previous + 1 < pages.length ? previous + 1 : previous));
        else if (currentPage?.nextCursor) void read(currentPage.nextCursor, currentPage.offset + currentPage.items.length);
      }}>读取下一页<ChevronRight size={14} /></button>
    </footer>
    {currentPage && <FinanceCommandResultEntries page={currentPage} reportingCurrency={reportingCurrency} />}
    {!currentPage && !reading && !error && <p role="status">本节尚未读取</p>}
    {currentPage && !currentPage.items.length && <p role="status">本笔结果的此类明细为 0 条 不代表金额为零</p>}
  </section>;
}

export function FinanceCommandRecordedHeader({ value }: { value: FinanceCommandRecordedResult }) {
  return <>
    <section className="finance-history-saved" aria-label="原保存结果"><h4>原保存结果</h4>
      <p className="finance-history-help">以下是该次执行已保存的凭据与历史金额 后续账单余额或依据变化不会替换这些值</p>
      <dl className="finance-history-pairs"><Pair label="本人原提交 ID"><Code>{value.commandId}</Code></Pair><Pair label="实际结果类型">{financeCommandNames[value.kind]}</Pair><Pair label="实际凭据 ID"><Code>{value.result.id}</Code></Pair><Pair label="该次执行时间"><Time value={value.executedAt} /></Pair></dl>
      <RecordedHeader recorded={value.recorded} />
    </section>
    <section className="finance-history-verification" aria-label="当前依据核验"><h4>当前依据核验</h4>
      {value.currentVerification ? <><p className={value.currentVerification.verified ? "finance-history-verified" : "finance-history-warning"}>{value.currentVerification.verified ? <Check size={15} /> : <CircleAlert size={15} />}{value.currentVerification.verified ? "本次读取的依据核验通过" : "当前依据待核对 原保存结果仍保留"}</p><dl className="finance-history-pairs"><Pair label="本次核验时间"><Time value={value.currentVerification.checkedAt} /></Pair></dl>{value.currentVerification.problems.length > 0 && <ul>{value.currentVerification.problems.map(problem => <li key={problem}>{problemNames[problem]}</li>)}</ul>}</> : <p>本结果未提供当前依据核验 不把原保存状态当作当前可用利润或余额</p>}
      <p className="finance-history-help">当前核验与原保存值分别展示 不在此重新计算利润或执行新的分摊</p>
    </section>
  </>;
}

function RecordedHeader({ recorded }: { recorded: Recorded }) {
  switch (recorded.kind) {
    case "statement_record": {
      const record = recorded.record, source = record.sourceIdentity;
      return <><dl className="finance-history-pairs"><Pair label="原外部单据编号">{record.externalStatementId}</Pair><Pair label="来源平台">{providerName(record.provider)}</Pair><Pair label="单据类别">{statementName(record.statementKind)}</Pair><Pair label="原来源币种">{record.sourceCurrency}</Pair><Pair label="原店铺账号 ID"><Identifier value={record.accountId} /></Pair><Pair label="原期间开始"><Time value={record.periodStart} /></Pair><Pair label="原期间结束"><Time value={record.periodEnd} /></Pair><Pair label="原观察时间"><Time value={record.observedAt} /></Pair><Pair label="原登记时间"><Time value={record.recordedAt} /></Pair><Pair label="原单据校验值"><Code>{record.checksum}</Code></Pair></dl>
        <h5>原来源作用域</h5>{source ? <dl className="finance-history-pairs"><Pair label="来源身份版本">v{source.schemaVersion}</Pair><Pair label="来源身份类别">{source.kind === "marketplace_account" ? "店铺账号来源" : source.kind === "supplier" ? "供应商来源" : "命名来源"}</Pair>{source.kind === "supplier" && <Pair label="原来源供应商 ID"><Code>{source.supplierId}</Code></Pair>}{source.kind === "named_source" && <Pair label="原命名来源">{source.sourceName}</Pair>}</dl> : <Notice>历史来源身份未知 不补造来源 不声称已经向外部验真或去重</Notice>}</>;
    }
    case "fx_rate_record": {
      const record = recorded.record;
      return <><dl className="finance-history-pairs"><Pair label="原汇率来源">{record.source}</Pair><Pair label="原币种对">{record.baseCurrency} → {record.quoteCurrency}</Pair><Pair label="原精确汇率"><Code>{record.rateNumerator} / {record.rateDenominator}</Code></Pair><Pair label="原汇率单位">{record.monetaryBasis ? `1 ${record.baseCurrency} 主货币单位 按原分数兑换 ${record.quoteCurrency} 主货币单位` : "历史单位依据未知 不推测主单位或最小单位"}</Pair><Pair label="原生效时间"><Time value={record.effectiveAt} /></Pair><Pair label="原取得时间"><Time value={record.retrievedAt} /></Pair><Pair label="原登记时间"><Time value={record.recordedAt} /></Pair><Pair label="原汇率校验值"><Code>{record.checksum}</Code></Pair>{record.monetaryBasis && <><Pair label="固定币种表版本">{record.monetaryBasis.currencyTableVersion}</Pair><Pair label="固定最小单位精度">{record.baseCurrency} {record.monetaryBasis.baseMinorDigits} 位 · {record.quoteCurrency} {record.monetaryBasis.quoteMinorDigits} 位</Pair></>}</dl><p className="finance-history-help">保留整数分子和分母 不将原汇率改写为浮点小数</p></>;
    }
    case "metric_upsert": {
      const record = recorded.record;
      return <dl className="finance-history-pairs"><Pair label="原指标 ID"><Code>{record.metricId}</Code></Pair><Pair label="实际固定指标版本">v{record.versionNumber}</Pair><Pair label="原版本名称">{record.name ?? "历史原版本名称未保留"}</Pair><Pair label="原报告币种">{record.reportingCurrency}</Pair><Pair label="原收入事实分类">{record.revenueFactTypes.map(factName).join(" · ") || "未列分类"}</Pair><Pair label="原成本事实分类">{record.costFactTypes.map(factName).join(" · ") || "未列分类"}</Pair><Pair label="原必要事实分类">{record.requiredFactTypes.map(factName).join(" · ") || "未列必要分类"}</Pair><Pair label="原版本原因代码">{record.reasonCode}</Pair><Pair label="原版本创建时间"><Time value={record.createdAt} /></Pair><Pair label="原版本校验值"><Code>{record.checksum}</Code></Pair></dl>;
    }
    case "profit_calculate": {
      const record = recorded.record;
      return <><dl className="finance-history-pairs"><Pair label="原保存计算状态">{record.status === "complete" ? "原保存为完整" : "原保存为待核对"}</Pair><Pair label="原报告币种">{record.reportingCurrency}</Pair><Pair label="原保存收入"><Money value={record.revenueMinor} currency={record.reportingCurrency} /></Pair><Pair label="原保存成本"><Money value={record.costMinor} currency={record.reportingCurrency} /></Pair><Pair label="原保存利润"><Money value={record.profitMinor} currency={record.reportingCurrency} /></Pair><Pair label="原保存利润率">{record.marginBps === null ? "原利润率待核对" : percent(record.marginBps)}</Pair><Pair label="原指标 ID"><Code>{record.metricId}</Code></Pair><Pair label="固定原指标版本 ID"><Code>{record.metricVersionId}</Code></Pair><Pair label="固定原指标版本">v{record.metricVersion}</Pair><Pair label="原输入校验值"><Code>{record.inputChecksum}</Code></Pair><Pair label="原计算时间"><Time value={record.calculatedAt} /></Pair><Pair label="原来源身份核对版本">{record.sourceIdentityVersion ?? "历史核对版本未知"}</Pair><Pair label="原金额算法">{record.monetaryBasis ? `${record.monetaryBasis.algorithm} · ${record.monetaryBasis.rounding}` : "历史金额算法依据未知"}</Pair></dl>
        <p className="finance-history-warning">原保存金额仅用于核对该次历史结果 当前依据是否可用请看独立核验区 不因原状态完整而宣称今天仍为完整利润</p>
        {record.monetaryBasis && <HistoryItems title="原固定币种精度" items={record.monetaryBasis.currencies} render={item => <>{item.currency} · {item.minorDigits === null ? "精度待核对" : `${item.minorDigits} 位`} · {record.monetaryBasis!.currencyTableVersion}</>} />}
        <IdItems title="原固定财务证据单" items={record.statementIds} /><IdItems title="原固定历史汇率" items={record.fxRateIds} />
        <ProfitDiagnostics diagnostics={record.diagnostics} />
      </>;
    }
    case "bill_record": {
      const record = recorded.record;
      return <><dl className="finance-history-pairs"><Pair label="原应付账单编号">{record.externalBillId}</Pair><Pair label="原账单类别">{record.kind === "factory_invoice" ? "工厂账单" : record.kind === "supplier_invoice" ? "供应商账单" : "采购实际发票"}</Pair><Pair label="原供应商 ID"><Code>{record.supplierId}</Code></Pair><Pair label="原登记金额"><Money value={record.amountMinor} currency={record.currency} /></Pair><Pair label="原账单开具时间"><Time value={record.issuedAt} /></Pair><Pair label="原到期时间">{record.dueAt ? <Time value={record.dueAt} /> : "原记录未填写到期时间"}</Pair><Pair label="原采购发票 ID"><Identifier value={record.procurementInvoiceId} /></Pair><Pair label="原采购发票凭据 ID"><Identifier value={record.procurementProofId} /></Pair><Pair label="原登记时间"><Time value={record.recordedAt} /></Pair></dl><MissingBalance /></>;
    }
    case "payment_record": {
      const record = recorded.record;
      return <><dl className="finance-history-pairs"><Pair label="原付款记录编号">{record.externalPaymentId}</Pair><Pair label="原供应商 ID"><Code>{record.supplierId}</Code></Pair><Pair label="原登记金额"><Money value={record.amountMinor} currency={record.currency} /></Pair><Pair label="原付款方式">{methodName(record.method)}</Pair><Pair label="原安全证据流水"><Code>{record.evidenceReference}</Code></Pair><Pair label="原证据状态">人工登记 未经银行认证</Pair><Pair label="原实际付款时间"><Time value={record.paidAt} /></Pair><Pair label="原登记时间"><Time value={record.recordedAt} /></Pair></dl><MissingBalance /></>;
    }
    case "payment_allocate": {
      const record = recorded.record;
      return <><dl className="finance-history-pairs"><Pair label="原付款 ID"><Code>{record.paymentId}</Code></Pair><Pair label="原核销条目数">{record.allocationCount}</Pair><Pair label="原核销登记时间"><Time value={record.recordedAt} /></Pair></dl><MissingBalance /><p className="finance-history-help">下方逐笔读取原核销事实 不把后来是否撤销的当前状态混入此次结果</p></>;
    }
    case "allocation_release": {
      const record = recorded.record, allocation = record.allocation;
      return <><dl className="finance-history-pairs"><Pair label="原被撤销核销 ID"><Code>{record.allocationId}</Code></Pair><Pair label="原核销批次 ID"><Code>{allocation.batchId}</Code></Pair><Pair label="原付款 ID"><Code>{allocation.paymentId}</Code></Pair><Pair label="原账单 ID"><Code>{allocation.billId}</Code></Pair><Pair label="原供应商 ID"><Code>{allocation.supplierId}</Code></Pair><Pair label="此次撤销对应原核销金额"><Money value={allocation.amountMinor} currency={allocation.currency} /></Pair><Pair label="原撤销原因代码">{record.reasonCode}</Pair><Pair label="原撤销登记时间"><Time value={record.recordedAt} /></Pair></dl><MissingBalance /><p className="finance-history-help">这是撤销账面核销占用的凭据 不是银行退款或资金转移</p></>;
    }
    case "bill_adjustment_record": {
      const record = recorded.record;
      return <><dl className="finance-history-pairs"><Pair label="原应付账单 ID"><Code>{record.billId}</Code></Pair><Pair label="原供应商 ID"><Code>{record.supplierId}</Code></Pair><Pair label="原调整语义">{adjustmentName(record.kind)}</Pair><Pair label="本笔保存的调整金额"><Money value={record.amountMinor} currency={record.currency} />{record.kind === "source_acknowledgement" && <small>零金额来源确认 不新增应付金额</small>}</Pair><Pair label="原外部更正单号">{record.externalDocumentId ?? "原作废未附外部更正单号"}</Pair><Pair label="原采购调整 ID"><Identifier value={record.procurementAdjustmentId} /></Pair><Pair label="原实际批准 ID"><Identifier value={record.procurementReviewId} /></Pair><EventEvidence record={record} /></dl><SavedBalance balance={record.balanceAfter} currency={record.currency} /></>;
    }
    case "payment_adjustment_record": {
      const record = recorded.record;
      return <><dl className="finance-history-pairs"><Pair label="原付款 ID"><Code>{record.paymentId}</Code></Pair><Pair label="原供应商 ID"><Code>{record.supplierId}</Code></Pair><Pair label="原调整语义">{adjustmentName(record.kind)}</Pair><Pair label="本笔保存的调整金额"><Money value={record.amountMinor} currency={record.currency} /></Pair><Pair label="原外部退款单号">{record.externalDocumentId ?? "原作废未附外部退款单号"}</Pair><Pair label="原证据状态">人工登记 未经银行认证</Pair><EventEvidence record={record} /></dl><SavedBalance balance={record.balanceAfter} currency={record.currency} /></>;
    }
    case "cost_version_approve": {
      const record = recorded.record, preview = record.preview;
      return <><dl className="finance-history-pairs"><Pair label="实际批准分摊规则 ID"><Code>{record.allocationId}</Code></Pair><Pair label="实际固定批准版本">v{record.versionNumber}</Pair><Pair label="原前版 ID"><Identifier value={record.previousVersionId} /></Pair><Pair label="原批准者 ID"><Code>{record.reviewedBy}</Code></Pair><Pair label="原批准时间"><Time value={record.createdAt} /></Pair><Pair label="原批准校验值"><Code>{record.checksum}</Code></Pair><Pair label="原完整汇总计算 ID"><Code>{preview.baseRunId}</Code></Pair><Pair label="固定原计算校验值"><Code>{preview.baseInputChecksum}</Code></Pair><Pair label="原批准预览校验值"><Code>{preview.previewChecksum}</Code></Pair><Pair label="原归属维度">{dimensionName(preview.dimension)}</Pair><Pair label="原分摊方法">{preview.method === "equal" ? "等额 固定权重1" : "人工精确权重"}</Pair><Pair label="原报告币种">{preview.reportingCurrency}</Pair><Pair label="原固定算法">最大余数法 v1 余数相同按原目标键升序</Pair><Pair label="原人工分摊依据">{preview.basisDescription}</Pair><Pair label="原原因代码">{preview.reasonCode}</Pair><Pair label="原批准费用来源数">{record.sourceCount}</Pair><Pair label="原批准展开份额数">{record.shareCount}</Pair></dl><p className="finance-history-help">下方分别分页读取原批准费用与全部份额 保留当时权重、目标快照、零份额和尾差 不调用新预览替换原批准依据</p></>;
    }
    case "allocated_profit_calculate": {
      const record = recorded.record;
      return <><dl className="finance-history-pairs"><Pair label="原保存归属状态">{record.status === "complete" ? "原保存为归属完整" : "原保存为归属待核对"}</Pair><Pair label="原归属维度">{dimensionName(record.dimension)}</Pair><Pair label="原报告币种">{record.reportingCurrency}</Pair><Pair label="原保存归属收入"><Money value={record.revenueMinor} currency={record.reportingCurrency} /></Pair><Pair label="原保存归属成本"><Money value={record.costMinor} currency={record.reportingCurrency} /></Pair><Pair label="原保存归属利润"><Money value={record.profitMinor} currency={record.reportingCurrency} /></Pair><Pair label="原保存利润率">{record.marginBps === null ? "原利润率待核对" : percent(record.marginBps)}</Pair><Pair label="原汇总计算 ID"><Code>{record.baseRunId}</Code></Pair><Pair label="固定原计算校验值"><Code>{record.baseInputChecksum}</Code></Pair><Pair label="原归属输入校验值"><Code>{record.inputChecksum}</Code></Pair><Pair label="原计算时间"><Time value={record.createdAt} /></Pair><Pair label="原检查目标数">{record.diagnostics.checkedTargetCount}</Pair><Pair label="原固定算法">最大余数法 v1 原报告币种最小单位守恒</Pair></dl>
        <p className="finance-history-warning">以上为该次归属计算保存值 当前依据另行核验 不把今天的版本或当前分页拼成原总额</p>
        <HistoryItems title="原计算固定分摊版本" items={record.versionPins} render={pin => <><strong>v{pin.versionNumber}</strong><Code>{pin.id}</Code><span>原规则</span><Code>{pin.allocationId}</Code><span>固定校验值</span><Code>{pin.checksum}</Code></>} />
        <IdItems title="原未归属贡献" items={record.diagnostics.unallocatedContributionIds} />
        <HistoryItems title="原目标归属缺口" items={record.diagnostics.missingByTarget} render={item => <><Code>{item.key}</Code>{item.missingFactTypes.map(factName).join(" · ")}</>} />
        <HistoryItems title="原保存目标汇总" items={record.breakdowns} render={row => <><TargetSnapshot target={row.target} /><dl className="finance-history-pairs"><Pair label="原保存收入"><Money value={row.revenueMinor} currency={record.reportingCurrency} /></Pair><Pair label="原保存成本"><Money value={row.costMinor} currency={record.reportingCurrency} /></Pair><Pair label="原保存利润"><Money value={row.profitMinor} currency={record.reportingCurrency} /></Pair><Pair label="原事实数">{row.factCount}</Pair></dl></>} />
      </>;
    }
  }
}

export function FinanceCommandResultEntries({ page, reportingCurrency }: { page: FinanceCommandResultPage; reportingCurrency?: string }) {
  switch (page.section) {
    case "facts": return <ol className="finance-history-entries">{page.items.map(record => <li key={record.id} aria-label={`原财务事实 ${record.id}`}><dl className="finance-history-pairs"><Pair label="原事实 ID"><Code>{record.id}</Code></Pair><Pair label="原单据 ID"><Code>{record.statementId}</Code></Pair><Pair label="原事实行标识">{record.lineKey}</Pair><Pair label="原来源条目标识">{record.sourceEntryId ? <Code>{record.sourceEntryId}</Code> : "历史来源条目标识未知 不冒称已去重"}</Pair><Pair label="原事实类别">{factName(record.factType)}</Pair><Pair label="原方向">{record.direction === "credit" ? "贷方 credit" : "借方 debit"}</Pair><Pair label="原事实金额"><Money value={record.amountMinor} currency={record.currency} /></Pair><Pair label="原发生时间"><Time value={record.occurredAt} /></Pair><Pair label="原登记时间"><Time value={record.recordedAt} /></Pair><Pair label="原外部引用">{record.externalReference ?? "原记录未附外部引用"}</Pair><Pair label="原更正语义">{record.correctionKind}</Pair><Pair label="原被更正事实 ID"><Identifier value={record.correctsFactId} /></Pair><Attribution record={record} /></dl></li>)}</ol>;
    case "contributions": return <ol className="finance-history-entries">{page.items.map(record => <li key={record.id} aria-label={`原利润贡献 ${record.id}`}><dl className="finance-history-pairs"><Pair label="原贡献 ID"><Code>{record.id}</Code></Pair><Pair label="原来源事实 ID"><Code>{record.factId}</Code></Pair><Pair label="原汇率 ID"><Identifier value={record.fxRateId} /></Pair><Pair label="原贡献分类">{bucketName(record.bucket)}</Pair><Pair label="原事实类型">{factName(record.factType)}</Pair><Pair label="原作用方向">{record.effectSign === -1 ? "沿原贡献反向作用" : "沿原贡献正向作用"}</Pair><Pair label="原来源金额"><Money value={record.sourceAmountMinor} currency={record.sourceCurrency} /></Pair><Pair label="原保存折算金额"><Money value={record.reportingAmountMinor} currency={record.reportingCurrency} /></Pair><Pair label="原发生时间"><Time value={record.occurredAt} /></Pair><Attribution record={record} /></dl><p className="finance-history-help">保留原存储贡献 不使用本页贡献求和声明完整利润</p></li>)}</ol>;
    case "allocations": return <ol className="finance-history-entries">{page.items.map(record => <li key={record.id} aria-label={`本批原核销 ${record.id}`}><dl className="finance-history-pairs"><Pair label="原核销 ID"><Code>{record.id}</Code></Pair><Pair label="原批次 ID"><Code>{record.batchId}</Code></Pair><Pair label="原付款 ID"><Code>{record.paymentId}</Code></Pair><Pair label="原账单 ID"><Code>{record.billId}</Code></Pair><Pair label="原供应商 ID"><Code>{record.supplierId}</Code></Pair><Pair label="原核销金额"><Money value={record.amountMinor} currency={record.currency} /></Pair><Pair label="原登记时间"><Time value={record.recordedAt} /></Pair></dl><p className="finance-history-help">这是该次登记的核销事实 不展示后来读取时的撤销状态</p></li>)}</ol>;
    case "cost_sources": return <ol className="finance-history-entries">{page.items.map(source => <li key={source.contributionId} aria-label={`原批准费用 ${source.contributionId}`}><CostSource source={source} /></li>)}</ol>;
    case "cost_shares": return <ol className="finance-history-entries">{page.items.map(row => <li key={`${row.sourceIndex}:${row.shareIndex}`} aria-label={`原批准份额 ${row.sourceIndex}:${row.shareIndex}`}>
      <div><strong>{row.share.target.label}</strong><p><strong><Money value={row.share.amountMinor} currency={row.source.reportingCurrency} /></strong> · 原精确权重 <code>{row.share.weight}</code></p><p className="finance-history-help">原精确余数 <code>{row.share.remainderNumerator} / {row.share.remainderDenominator}</code> · {row.share.receivesRemainder ? "获得1个最小单位尾差" : "未获得额外尾差"}</p>{row.share.amountMinor === 0 && <p className="finance-history-help">真实零份额 保留原权重与尾差依据</p>}</div>
      <details><summary>查看完整原批准依据</summary><dl className="finance-history-pairs"><Pair label="原来源顺序">{row.sourceIndex + 1}</Pair><Pair label="原份额顺序">{row.shareIndex + 1}</Pair><Pair label="固定原贡献 ID"><Code>{row.source.contributionId}</Code></Pair><Pair label="固定原事实 ID"><Code>{row.source.factId}</Code></Pair><Pair label="固定根事实 ID"><Code>{row.source.rootFactId}</Code></Pair><Pair label="该源原报告金额"><Money value={row.source.reportingAmountMinor} currency={row.source.reportingCurrency} /></Pair><Pair label="原作用方向">{row.source.effectSign === -1 ? "冲回成本" : "计入成本"}</Pair><Pair label="原精确权重"><Code>{row.share.weight}</Code></Pair><Pair label="原权重整数"><Code>{row.share.weightUnits}</Code></Pair><Pair label="原整数部分"><Money value={row.share.floorMinor} currency={row.source.reportingCurrency} /></Pair><Pair label="原精确余数"><Code>{row.share.remainderNumerator} / {row.share.remainderDenominator}</Code></Pair><Pair label="原尾差分配">{row.share.receivesRemainder ? "获得1个最小单位尾差" : "未获得额外尾差"}</Pair><Pair label="原最终份额金额"><Money value={row.share.amountMinor} currency={row.source.reportingCurrency} />{row.share.amountMinor === 0 && <small>真实零份额 保留原权重与尾差依据</small>}</Pair></dl><TargetSnapshot target={row.share.target} /></details>
    </li>)}</ol>;
    case "slices": return <ol className="finance-history-entries">{page.items.map(slice => <li key={slice.id} aria-label={`原归属分配 ${slice.id}`}><dl className="finance-history-pairs"><Pair label="原分配行 ID"><Code>{slice.id}</Code></Pair><Pair label="原归属计算 ID"><Code>{slice.runId}</Code></Pair><Pair label="原贡献 ID"><Code>{slice.baseContributionId}</Code></Pair><Pair label="原事实 ID"><Code>{slice.sourceFactId}</Code></Pair><Pair label="原根事实 ID"><Code>{slice.rootFactId}</Code></Pair><Pair label="原固定分摊版本">{slice.allocationVersionId ? <Code>{slice.allocationVersionId}</Code> : slice.target ? "原事实直接归属 未使用分摊版本" : "尚未归属 未使用分摊版本"}</Pair><Pair label="原贡献分类">{bucketName(slice.bucket)}</Pair><Pair label="原事实类型">{factName(slice.factType)}</Pair><Pair label="原作用方向">{slice.effectSign === -1 ? "沿原贡献反向作用" : "沿原贡献正向作用"}</Pair><Pair label="原保存分配金额">{reportingCurrency ? <Money value={slice.amountMinor} currency={reportingCurrency} /> : "原报告币种未载入 不推测金额单位"}</Pair><Pair label="原报告金额">{reportingCurrency ? <Money value={slice.originalReportingAmountMinor} currency={reportingCurrency} /> : "原报告币种未载入"}</Pair><Pair label="原固定权重">{slice.weight ?? "未使用分摊权重"}</Pair><Pair label="原整数部分">{slice.floorMinor === null ? "未保存分摊整数部分" : reportingCurrency ? <Money value={slice.floorMinor} currency={reportingCurrency} /> : "原报告币种未载入"}</Pair><Pair label="原余数">{slice.remainderNumerator === null ? "未使用分摊余数" : <Code>{slice.remainderNumerator} / {slice.remainderDenominator}</Code>}</Pair><Pair label="原尾差">{slice.receivesRemainder ? "此份获得1个最小单位尾差" : "未获得额外尾差"}</Pair></dl>{slice.target ? <TargetSnapshot target={slice.target} /> : <Notice>此原贡献尚未归属实际目标 不显示为已分配</Notice>}</li>)}</ol>;
  }
}

function MissingBalance() { return <Notice>原服务没有保存这次执行时余额 不补零 不以当前余额替代 本页只核对原登记事实</Notice>; }
function EventEvidence({ record }: { record: { evidenceReference: string; occurredAt: string; recordedAt: string; reasonCode: string } }) {
  return <><Pair label="原安全证据流水"><Code>{record.evidenceReference}</Code></Pair><Pair label="原实际发生时间"><Time value={record.occurredAt} /></Pair><Pair label="原登记时间"><Time value={record.recordedAt} /></Pair><Pair label="原原因代码">{record.reasonCode}</Pair></>;
}
function SavedBalance({ balance, currency }: { balance: FinanceBillBalance | FinancePaymentBalance; currency: string }) {
  const bill = "outstandingMinor" in balance;
  return <section className="finance-history-balance" aria-label="该次执行时余额"><h5>该次执行时余额</h5><p className="finance-history-help">原事件保存的余额快照 后续核销、更正或退款登记可能已变化 不是当前余额 不是银行余额</p><dl className="finance-history-pairs"><Pair label="原快照币种">{currency}</Pair><Pair label={bill ? "原账单金额" : "原付款金额"}><Money value={balance.amountMinor} currency={currency} /></Pair>{bill ? <><Pair label="该次累计贷项"><Money value={balance.creditMinor} currency={currency} /></Pair><Pair label="该次累计补差"><Money value={balance.debitMinor} currency={currency} /></Pair></> : <Pair label="该次累计退款"><Money value={balance.refundedMinor} currency={currency} /></Pair>}<Pair label="该次累计作废额"><Money value={balance.voidedMinor} currency={currency} /></Pair><Pair label="执行后净额"><Money value={balance.netAmountMinor} currency={currency} /></Pair><Pair label="执行时已核销"><Money value={balance.allocatedMinor} currency={currency} /></Pair><Pair label={bill ? "执行时净额待核销" : "执行时未分配余额"}><Money value={bill ? balance.outstandingMinor : balance.unallocatedMinor} currency={currency} /></Pair><Pair label="执行后生命周期">{lifecycleName(balance.lifecycle)}</Pair></dl></section>;
}
function CostSource({ source }: { source: Extract<FinanceCommandResultPage, { section: "cost_sources" }>["items"][number] }) {
  return <dl className="finance-history-pairs"><Pair label="原费用根事实 ID"><Code>{source.rootFactId}</Code></Pair><Pair label="原贡献 ID"><Code>{source.contributionId}</Code></Pair><Pair label="实际原事实 ID"><Code>{source.factId}</Code></Pair><Pair label="原证据单 ID"><Code>{source.statementId}</Code></Pair><Pair label="原证据单校验值"><Code>{source.statementChecksum}</Code></Pair><Pair label="原来源分录标识">{source.sourceEntryId ? <Code>{source.sourceEntryId}</Code> : "历史来源分录标识未知"}</Pair><Pair label="原费用类别">{factName(source.factType)}</Pair><Pair label="原作用方向">{source.effectSign === -1 ? "冲回成本" : "计入成本"}</Pair><Pair label="源币原金额"><Money value={source.sourceAmountMinor} currency={source.sourceCurrency} /></Pair><Pair label="固定原报告金额"><Money value={source.reportingAmountMinor} currency={source.reportingCurrency} /></Pair><Pair label="固定原汇率 ID"><Identifier value={source.fxRateId} /></Pair><Pair label="固定费用链校验值"><Code>{source.sourceChainChecksum}</Code></Pair></dl>;
}
function TargetSnapshot({ target }: { target: FinanceCostAllocationTarget }) {
  return <section className="finance-history-target" aria-label="原批准目标快照"><h6>原批准目标快照</h6><dl className="finance-history-pairs"><Pair label="原目标标签">{target.label}</Pair><Pair label="原目标维度">{dimensionName(target.dimension)}</Pair><Pair label="原目标键"><Code>{target.key}</Code></Pair><Pair label="原目标依据校验值"><Code>{target.basisChecksum}</Code></Pair>{target.dimension === "period" ? <><Pair label="原 UTC 期间">{target.period}</Pair><Pair label="原期间开始">{target.periodStart ? <Time value={target.periodStart} /> : "原期间起点未提供"}</Pair><Pair label="原期间结束">{target.periodEnd ? <Time value={target.periodEnd} /> : "原期间终点未提供"}</Pair></> : <Attribution record={target} />}{target.spuId && <Pair label="原 SPU ID"><Code>{target.spuId}</Code></Pair>}{target.catalogLinkId && <Pair label="原目录关联 ID"><Code>{target.catalogLinkId}</Code></Pair>}</dl></section>;
}
function Attribution({ record }: { record: { orderId?: string | null; orderLineId?: string | null; skuId?: string | null; listingId?: string | null; accountId?: string | null; supplierId?: string | null } }) {
  return <>{record.orderId && <Pair label="原订单 ID"><Code>{record.orderId}</Code></Pair>}{record.orderLineId && <Pair label="原订单行 ID"><Code>{record.orderLineId}</Code></Pair>}{record.skuId && <Pair label="原 SKU ID"><Code>{record.skuId}</Code></Pair>}{record.listingId && <Pair label="原刊登 ID"><Code>{record.listingId}</Code></Pair>}{record.accountId && <Pair label="原店铺账号 ID"><Code>{record.accountId}</Code></Pair>}{record.supplierId && <Pair label="原供应商 ID"><Code>{record.supplierId}</Code></Pair>}</>;
}
function ProfitDiagnostics({ diagnostics }: { diagnostics: Extract<Recorded, { kind: "profit_calculate" }>["record"]["diagnostics"] }) {
  return <details className="finance-history-diagnostics"><summary>原计算保存的诊断</summary><dl className="finance-history-pairs"><Pair label="原缺少事实类型">{diagnostics.missingFactTypes.map(factName).join(" · ") || "原诊断未报告此类缺口"}</Pair><Pair label="原未分类事实类型">{diagnostics.unclassifiedFactTypes.map(factName).join(" · ") || "原诊断未报告此类缺口"}</Pair><Pair label="原缺少汇率对">{diagnostics.missingFxPairs.join(" · ") || "原诊断未报告此类缺口"}</Pair><Pair label="原未知币种">{diagnostics.monetary ? diagnostics.monetary.unknownCurrencies.join(" · ") || "原诊断未报告未知币种" : "历史币种精度诊断未知"}</Pair><Pair label="原覆盖维度">{diagnostics.coverage ? dimensionName(diagnostics.coverage.dimension) : "历史覆盖依据未知"}</Pair><Pair label="原核对归属实体数">{diagnostics.coverage?.checkedEntityCount ?? "历史检查数未知"}</Pair></dl>{diagnostics.sourceIdentity ? <IdItems title="原来源身份未识别事实" items={diagnostics.sourceIdentity.unidentifiedFactIds} /> : <p>历史来源身份诊断未知 不当作零缺口</p>}{diagnostics.monetary && <IdItems title="原单位待核对汇率" items={diagnostics.monetary.ambiguousFxRateIds} />}{diagnostics.coverage && <><IdItems title="原缺少归属事实" items={diagnostics.coverage.unattributedFactIds} /><HistoryItems title="原归属事实缺口" items={diagnostics.coverage.missingByEntity} render={item => <><Code>{item.key}</Code>{item.missingFactTypes.map(factName).join(" · ")}</>} /></>}</details>;
}
function HistoryItems<T>({ title, items, render }: { title: string; items: T[]; render(item: T): ReactNode }) {
  const [page, setPage] = useState(0), size = 25, count = Math.max(1, Math.ceil(items.length / size));
  const transition = useOwnedViewTransition();
  return <details className="finance-history-local-list"><summary>{title} {items.length} 项</summary><p className="finance-history-help">原保存列表完整传输 此处每页显示 25 项 不按可见项推算总额</p><ol>{items.slice(page * size, (page + 1) * size).map((item, index) => <li key={`${page}:${index}`}>{render(item)}</li>)}</ol>{!items.length && <p>原记录未列出此类项目 不推断其他历史或当前状态</p>}{count > 1 && <div className="finance-history-pagination"><button type="button" disabled={page === 0} onClick={() => transition.change(() => setPage(previous => previous > 0 ? previous - 1 : 0))}>上一页</button><span>第 {page + 1}/{count} 页</span><button type="button" disabled={page + 1 >= count} onClick={() => transition.change(() => setPage(previous => previous + 1 < count ? previous + 1 : previous))}>下一页</button></div>}</details>;
}
function IdItems({ title, items }: { title: string; items: string[] }) { return <HistoryItems title={title} items={items} render={id => <Code>{id}</Code>} />; }

function Pair({ label, children }: { label: string; children: ReactNode }) { return <div><dt>{label}</dt><dd>{children}</dd></div>; }
function Code({ children }: { children: ReactNode }) { return <code className="finance-history-id">{children}</code>; }
function Identifier({ value }: { value: string | null | undefined }) { return value ? <Code>{value}</Code> : <span>原记录未提供</span>; }
function Money({ value, currency }: { value: number | null; currency: string }) { return <span className="finance-history-money">{value === null ? "原金额未保存或待核对" : formatFinanceMinorAmount(value, currency)}</span>; }
function Time({ value }: { value: string }) { return <span><time dateTime={value}>{financeCommandTime(value)}</time><Code>{value}</Code></span>; }
function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) { return <p className={`finance-history-notice${error ? " is-error" : ""}`} role={error ? "alert" : "status"}>{children}</p>; }
function percent(value: number) { const amount = BigInt(value), magnitude = amount < 0n ? -amount : amount; return `${amount < 0n ? "-" : ""}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, "0")}%`; }
function lifecycleName(value: string) { return ({ active: "有效登记", fully_credited: "已全额贷记", fully_refunded: "已全额登记退款", voided: "已作废" } as Record<string, string>)[value] ?? value; }
function adjustmentName(value: string) { return ({ credit: "应付贷项", debit: "应付补差", source_acknowledgement: "零金额来源确认", refund: "已发生退款登记", void: "原登记作废" } as Record<string, string>)[value] ?? value; }
function methodName(value: string) { return ({ bank_transfer: "银行转账", card: "卡付款", cash: "现金", other: "其他" } as Record<string, string>)[value] ?? value; }
function providerName(value: string) { return ({ amazon: "Amazon", etsy: "Etsy", supplier: "供应商", advertising: "广告来源", carrier: "承运商", tax_authority: "税务机构", manual: "人工来源" } as Record<string, string>)[value] ?? value; }
function statementName(value: string) { return ({ marketplace_settlement: "平台结算单", advertising_invoice: "广告发票", fulfillment_invoice: "履约账单", supplier_invoice: "供应商发票", carrier_invoice: "承运商账单", tax_statement: "税务单据", operational_cost: "运营费用", manual_adjustment: "人工调整" } as Record<string, string>)[value] ?? value; }
function factName(value: string) { return ({ sale_revenue: "销售收入", shipping_revenue: "运费收入", marketplace_commission: "平台佣金", advertising_spend: "广告费用", fulfillment_fee: "履约费用", storage_fee: "仓储费用", refund: "退款事实", chargeback: "拒付事实", procurement_cost: "采购成本", production_cost: "生产成本", freight_cost: "运输成本", carrier_cost: "承运费用", tax: "税费", other_fee: "其他费用" } as Record<string, string>)[value] ?? value; }
function bucketName(value: string) { return value === "revenue" ? "收入" : value === "cost" ? "成本" : "未分类"; }
function dimensionName(value: string) { return ({ aggregate: "账单汇总", order: "订单", order_line: "订单行", sku: "SKU", listing: "刊登", store: "店铺", platform: "平台", supplier: "供应商", period: "期间" } as Record<string, string>)[value] ?? value; }
