"use client";
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "next/navigation";
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  RefreshCw,
  Settings2,
  Upload,
  X,
} from "lucide-react";
import {
  AdvertisingWorkspaceSchema,
  AdFactPageSchema,
  AdAnalysisInputSchema,
  AdAnalysisRunSchema,
  AdExportInputSchema,
  AdExportViewSchema,
  AdMarketplaceSchema,
  type AdvertisingWorkspace,
  type AdProductSummary,
  type AdStoredFact,
  type AdReportType,
  type AdFactPage,
  type AdAnalysisResult,
  type AdAnalysisRun,
} from "@yummyai/contracts/advertising";
import { Permission } from "@yummyai/authz/permissions";
import { FINANCE_CURRENCY_MINOR_DIGITS } from "@yummyai/contracts/finance/currency-snapshot";
import type { CustomerIntelligenceWorkspaceView } from "@yummyai/contracts/customer-intelligence";
import { CustomerIntelligenceWorkspace } from "./customer-intelligence-workspace";
import { AdGoalForm, AdObservationForm, AdIndependentForms, AdMutationFeedback, AdMeasurementSummary, AdConversionSummary, AdMonetaryBasisNote } from "./advertising-forms";
import { useErpAccess } from "../identity/erp-access";
import { useOwnedViewTransition } from "../navigation/use-owned-view-transition";
import { AdImportPanel } from "./advertising-import";
import { AdvertisingHistory, adHistoryLocation, parseAdHistoryLocation } from "./advertising-history";
import { useAdCommandMutation } from "./advertising-command-forms";
import { AdCommandMutationPanel } from "./advertising-command-workbench";
import {
  adRequest,
  adIdempotency,
  adMoney,
  adPercent,
  adLabels,
  adConversionLabels,
  adStatusLabels,
  adDayNow,
  adRankProgress,
  adCheckAuthority,
  adDenied,
  adError,
  adDownload,
  AdRequestError,
} from "./advertising-client";
import "./advertising.css";

const tabs = [
  ["daily", "每日复盘"],
  ["goals", "产品目标"],
  ["terms", "搜索词与投放"],
  ["campaigns", "活动与广告位"],
  ["actions", "调整与复盘"],
  ["imports", "导入历史"],
  ["history", "完整历史"],
  ["voc", "VOC"],
] as const;
type Filters = {
  tab: string;
  account: string;
  from: string;
  to: string;
  site: string;
  currency: string;
  mode: string;
  status: string;
  search: string;
  page: string;
  detail: string;
  report: string;
  run: string;
};
type Page = AdFactPage;
type Props = {
  initialData: AdvertisingWorkspace | null;
  initialError?: string;
  vocData: CustomerIntelligenceWorkspaceView | null;
  vocError?: string;
};
const message = adError;

export function AdvertisingWorkbench({ initialData, initialError, vocData, vocError }: Props) {
  const query = useSearchParams();
  const queryKey = query.toString();
  const locationQuery = typeof window === "undefined" ? new URLSearchParams(queryKey) : new URLSearchParams(window.location.search);
  const locationQueryKey = locationQuery.toString();
  const appliedQuery = useRef(queryKey);
  const access = useErpAccess(), transition = useOwnedViewTransition();
  const identity = useMemo(() => ({ authority: access.authority, preferenceScope: access.preferenceScope, localDevelopment: access.localDevelopment }), [access.authority, access.preferenceScope, access.localDevelopment]);
  const ownerKey = `${identity.preferenceScope ?? ""}:${identity.authority ?? ""}`;
  const initialOwner = useRef(ownerKey);
  const initialAllowed = Boolean(initialData && (identity.localDevelopment || initialData.contextAuthority === identity.authority));
  const [snapshot, setSnapshot] = useState<{ value: AdvertisingWorkspace; owner: string } | null>(() => initialData && initialAllowed ? { value: initialData, owner: ownerKey } : null);
  const [directory, setDirectory] = useState<{ accounts: AdvertisingWorkspace["accounts"]; owner: string } | null>(() => initialData && initialAllowed ? { accounts: initialData.accounts, owner: ownerKey } : null);
  const [recoveredRun, setRecoveredRun] = useState<{ value: AdAnalysisRun; owner: string } | null>(null);
  const [error, setError] = useState(initialError ?? ""),
    [notice, setNotice] = useState(""),
    [reading, setReading] = useState(false), [denied, setDenied] = useState(false),
    [privateEpoch, setPrivateEpoch] = useState(0), [dirty, setDirty] = useState(false);
  const [filters, setFilters] = useState<Filters>(() => {
    const account = query.get("account") ?? initialData?.accounts[0]?.id ?? "",
      source = initialData?.imports.filter((i) => i.accountId === account && !i.archivedAt) ?? [];
    return {
      tab: query.get("tab") ?? "daily",
      account,
      from:
        query.get("from") ??
        source
          .map((s) => s.periodStart)
          .filter((v): v is string => !!v)
          .sort()[0] ??
        adDayNow(),
      to:
        query.get("to") ??
        source
          .map((s) => s.periodEnd)
          .filter((v): v is string => !!v)
          .sort()
          .at(-1) ??
        adDayNow(),
      site: query.get("site") ?? "",
      currency: query.get("currency") ?? "",
      mode: query.get("mode") ?? "",
      status: query.get("status") ?? "",
      search: query.get("search") ?? "",
      page: query.get("page") ?? "1",
      detail: query.get("detail") ?? "",
      report: query.get("report") ?? "",
      run: query.get("run") ?? "",
    };
  });
  const accounts = directory?.owner === ownerKey ? directory.accounts : [];
  const account = accounts.find(a => a.id === filters.account);
  const locationAccount = locationQuery.get("account") || null;
  const removedAccountPending = locationAccount === null && appliedQuery.current !== locationQueryKey && new URLSearchParams(appliedQuery.current).has("account") && Boolean(filters.account);
  const urlScopeReady = locationAccount === null ? !removedAccountPending : locationAccount === filters.account;
  const historyDetail = locationQuery.get("detail") ?? filters.detail;
  const historyMode = filters.tab === "history" || historyDetail.startsWith("history:") || historyDetail.startsWith("action:") || historyDetail.startsWith("import:");
  const scoped = urlScopeReady && snapshot?.owner === ownerKey && snapshot.value.accountId === (filters.account || null) ? snapshot.value : null;
  const canRead = !denied && Boolean(scoped?.access.canRead && account?.access.canRead && access.can(Permission.CustomerIntelligenceRead));
  const canWrite = !denied && Boolean(scoped?.access.canWrite && account?.access.canWrite && access.can(Permission.CustomerIntelligenceWrite));
  const canReview = !denied && Boolean(scoped?.access.canReview && account?.access.canReview && access.can(Permission.CustomerIntelligenceReview));
  const data = canRead ? scoped : scoped ? { ...scoped, imports: [], goals: [], observations: [], actions: [], analyses: [] } : null;
  const [facts, setFacts] = useState<{ value: Page; key: string } | null>(null),
    [factsError, setFactsError] = useState(""),
    [factsLoading, setFactsLoading] = useState(false),
    [factsRetry, setFactsRetry] = useState(0),
    [drawerTab, setDrawerTab] = useState("goal");
  const live = useRef(true), generation = useRef(0), readSequence = useRef(0), factSequence = useRef(0);
  const previousRead = useRef(canRead);
  const readAbort = useRef<AbortController | null>(null), factAbort = useRef<AbortController | null>(null);
  const current = useRef({ ownerKey, accountId: filters.account, canRead, urlScopeReady }); current.current = { ownerKey, accountId: filters.account, canRead, urlScopeReady };
  const deny = useCallback((reason: string) => {
    generation.current++; readSequence.current++; factSequence.current++; readAbort.current?.abort(); factAbort.current?.abort(); transition.cancel();
    setSnapshot(null); setDirectory(null); setFacts(null); setRecoveredRun(null); setDirty(false); setNotice(""); setDenied(true); setReading(false); setFactsLoading(false); setPrivateEpoch(n => n + 1);
    setFilters(previous => ({ ...previous, detail: "", run: "" })); setError(reason);
  }, [transition]);
  const analysisMutation = useAdCommandMutation({ kind: "analysis_run", accountId: filters.account, targetId: null }, canReview, deny, () => setDirty(false));
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const sync = useCallback((next: Filters) => {
    const url = new URL(window.location.href);
    for (const [k, v] of Object.entries(next)) {
      if (v) url.searchParams.set(k, v);
      else url.searchParams.delete(k);
    }
    appliedQuery.current = url.searchParams.toString();
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);
  function change(patch: Partial<Filters>, guard = true) {
    if (guard && dirty && !window.confirm("有未保存内容，是否放弃这些编辑并继续？")) return;
    if (guard) setDirty(false);
    const changesScope = ["account", "from", "to", "site", "currency"].some(key => key in patch);
    const next = { ...filters, ...(changesScope ? { run: "" } : {}), ...patch };
    transition.cancel();
    const captured = ownerKey, target = filters.account;
    const apply = () => {
      if (!current.current.urlScopeReady || current.current.ownerKey !== captured || current.current.accountId !== target) return;
      setFilters(next); sync(next); setDrawerTab("goal");
    };
    if (changesScope || Object.keys(patch).some(key => key !== "tab" && key !== "detail")) apply(); else transition.change(apply);
  }
  useLayoutEffect(() => {
    // Local replaceState is already reflected in filters. Only a different
    // browser query is navigation; a delayed router notification is not.
    if (appliedQuery.current === locationQueryKey) return;
    const previousQuery = new URLSearchParams(appliedQuery.current), nextQuery = new URLSearchParams(locationQueryKey);
    appliedQuery.current = locationQueryKey;
    const nextAccount = nextQuery.get("account") ?? (previousQuery.has("account") ? "" : filters.account);
    const accountChanged = nextAccount !== filters.account;
    const next: Filters = {
      account: nextAccount, tab: nextQuery.get("tab") ?? "daily",
      from: nextQuery.get("from") ?? (accountChanged ? adDayNow() : filters.from),
      to: nextQuery.get("to") ?? (accountChanged ? adDayNow() : filters.to),
      site: nextQuery.get("site") ?? "", currency: nextQuery.get("currency") ?? "",
      mode: nextQuery.get("mode") ?? "", status: nextQuery.get("status") ?? "", search: nextQuery.get("search") ?? "",
      page: nextQuery.get("page") ?? "1", report: nextQuery.get("report") ?? "",
      detail: accountChanged ? "" : nextQuery.get("detail") ?? "", run: accountChanged ? "" : nextQuery.get("run") ?? "",
    };
    if ((Object.keys(next) as (keyof Filters)[]).every(key => next[key] === filters[key])) return;
    transition.cancel(); setDirty(false); setDrawerTab("goal");
    if (accountChanged) {
      generation.current++; readSequence.current++; factSequence.current++; readAbort.current?.abort(); factAbort.current?.abort();
      setSnapshot(null); setFacts(null); setFactsError(""); setFactsLoading(false); setNotice(""); setError(""); setDenied(false); setPrivateEpoch(n => n + 1);
    }
    setFilters(next);
  }, [queryKey, locationQueryKey, filters, transition]);
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, []);
  useEffect(() => {
    if (!filters.detail || !mounted || historyMode) return;
    const previous = document.activeElement as HTMLElement | null,
      overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const drawer = document.querySelector<HTMLElement>(".ad-drawer");
    drawer?.querySelector<HTMLElement>("button")?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !drawer) return;
      const focusable = [
        ...drawer.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]",
        ),
      ].filter((el) => el.offsetParent !== null);
      const first = focusable[0],
        last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      }
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", trap);
      previous?.focus();
    };
  }, [filters.detail, mounted, historyMode]);
  const refresh = useCallback(async () => {
    if (!current.current.urlScopeReady) return null;
    const target = current.current.accountId, captured = ownerKey, epoch = generation.current, token = ++readSequence.current;
    readAbort.current?.abort(); const abort = new AbortController(); readAbort.current = abort; setReading(true);
    const valid = () => live.current && !abort.signal.aborted && epoch === generation.current && token === readSequence.current && current.current.urlScopeReady && current.current.ownerKey === captured && current.current.accountId === target;
    try {
      const next = AdvertisingWorkspaceSchema.parse(await adRequest(`workspace${target ? `?accountId=${encodeURIComponent(target)}` : ""}`, undefined, abort.signal));
      adCheckAuthority(next, identity);
      if (next.accountId !== (target || null)) throw new AdRequestError(502, "返回工作区与所选店铺不一致 未显示其他店铺数据");
      if (!valid()) return null;
      setDirectory({ accounts: next.accounts, owner: captured }); setSnapshot({ value: next, owner: captured }); setDenied(false); setError("");
      if (!target && next.accounts[0]) setFilters(previous => previous.account ? previous : { ...previous, account: next.accounts[0]!.id, detail: "", run: "" });
      return next;
    } catch (failure) {
      if (!valid()) return null;
      if (adDenied(failure)) deny(message(failure)); else setError(message(failure));
      throw failure;
    } finally { if (valid()) setReading(false); }
  }, [ownerKey, identity, deny]);
  useLayoutEffect(() => {
    generation.current++; readSequence.current++; factSequence.current++; readAbort.current?.abort(); factAbort.current?.abort(); transition.cancel();
    setSnapshot(null); setFacts(null); setRecoveredRun(null); setFactsError(""); setFactsLoading(false); setDirty(false); setNotice(""); setError(""); setDenied(false); setPrivateEpoch(n => n + 1);
    setFilters(previous => previous.detail ? { ...previous, detail: "", run: "" } : previous);
  }, [ownerKey, filters.account, transition]);
  useEffect(() => {
    live.current = true; void refresh().catch(() => {});
    return () => { live.current = false; readSequence.current++; factSequence.current++; readAbort.current?.abort(); factAbort.current?.abort(); };
  }, [filters.account, refresh]);
  useLayoutEffect(() => {
    const lost = previousRead.current && !canRead; previousRead.current = canRead;
    if (!lost) return;
    generation.current++; factSequence.current++; factAbort.current?.abort(); transition.cancel(); setFacts(null); setFactsLoading(false); setNotice(""); setDirty(false); setPrivateEpoch(n => n + 1);
    setFilters(previous => ({ ...previous, detail: "", run: "" }));
  }, [canRead, transition]);
  const report = (filters.report ||
    (filters.tab === "campaigns" ? "campaign" : "search_term")) as AdReportType;
  const pageNumber = Math.max(1, Math.min(10000, Number(filters.page) || 1));
  const factScope = `${ownerKey}:${filters.account}:${report}:${filters.search}:${pageNumber}`;
  const factPage = canRead && facts?.key === factScope ? facts.value : null;
  useEffect(() => {
    if (!["terms", "campaigns"].includes(filters.tab) || !filters.account || !canRead) return;
    const controller = new AbortController();
    factAbort.current?.abort(); factAbort.current = controller;
    const epoch = generation.current, token = ++factSequence.current, captured = ownerKey, target = filters.account;
    const valid = () => live.current && !controller.signal.aborted && epoch === generation.current && token === factSequence.current && current.current.ownerKey === captured && current.current.accountId === target && current.current.canRead;
    setFactsLoading(true);
    setFactsError("");
    setFacts(null);
    const params = new URLSearchParams({
      accountId: filters.account,
      reportType: report,
      search: filters.search,
      page: String(pageNumber),
      pageSize: "50",
    });
    void adRequest(`facts?${params}`, undefined, controller.signal)
      .then((value) => {
        if (!valid()) return;
        const page = AdFactPageSchema.parse(value); adCheckAuthority(page, identity);
        if (page.accountId !== target || page.page !== pageNumber || page.pageSize !== 50 || page.rows.some(row => row.accountId !== target || row.fact.reportType !== report)) throw new AdRequestError(502, "返回明细与店铺、类型或页码不一致 未显示该页");
        setFacts({ value: page, key: factScope });
      })
      .catch((e) => {
        if (valid()) { if (adDenied(e)) deny(message(e)); else setFactsError(message(e)); }
      })
      .finally(() => {
        if (valid()) setFactsLoading(false);
      });
    return () => controller.abort();
  }, [
    filters.tab,
    filters.account,
    filters.search,
    pageNumber,
    report,
    data?.imports.length,
    factsRetry,
    canRead, ownerKey, identity, factScope, deny,
  ]);
  const restored = urlScopeReady && (canRead || canReview) && recoveredRun?.owner === ownerKey && recoveredRun.value.accountId === filters.account ? recoveredRun.value : null;
  const availableRuns = [...(restored ? [restored] : []), ...(data?.analyses ?? [])].filter((row, index, all) => all.findIndex(other => other.id === row.id) === index);
  const run = availableRuns.find(
    (r) =>
      (!filters.run || r.id === filters.run) &&
      r.accountId === filters.account &&
      r.periodStart === filters.from &&
      r.periodEnd === filters.to &&
      (r.marketplace ?? "") === filters.site &&
      (r.currency ?? "") === filters.currency,
  );
  const result = run?.result;
  const exportMutation = useAdCommandMutation({ kind: "export_seal", accountId: filters.account, targetId: run?.id ?? null }, canReview && Boolean(run), deny, () => setDirty(false));
  const busy = analysisMutation.pending || analysisMutation.checking || exportMutation.pending || exportMutation.checking;
  const missingRun = Boolean(filters.run && !run);
  const historyTarget = useMemo(() => parseAdHistoryLocation(historyDetail, missingRun ? filters.run : ""), [historyDetail, missingRun, filters.run]);
  const scopedActions =
    data?.actions.filter(
      (a) =>
        a.recommendation.accountId === filters.account &&
        (!filters.site || a.recommendation.marketplace === filters.site) &&
        (!filters.currency || a.recommendation.currency === filters.currency) &&
        a.recommendation.periodStart >= filters.from &&
        a.recommendation.periodEnd <= filters.to,
    ) ?? [];
  const visibleActions = scopedActions.filter(
    (a) =>
      (!filters.status || a.status === filters.status) &&
      (!filters.search ||
        `${a.recommendation.title} ${a.recommendation.term} ${a.recommendation.scope?.asin ?? ""} ${a.recommendation.campaignId}`
          .toLowerCase()
          .includes(filters.search.toLowerCase())),
  );
  const activeActions = scopedActions.filter((a) => a.status === "pending");
  const products =
    result?.products.filter(
      (p) =>
        (!filters.mode || p.goal?.fields.mode === filters.mode) &&
        (!filters.search ||
          `${p.scope.asin} ${p.productName ?? ""}`
            .toLowerCase()
            .includes(filters.search.toLowerCase())),
    ) ?? [];
  const selectedProduct = result?.products.find((p) => `product:${p.key}` === filters.detail);
  const selectedFact = factPage?.rows.find((r) => `fact:${r.id}` === filters.detail);
  const currentImports = data?.imports.filter((i) => i.accountId === filters.account) ?? [];
  async function analyze() {
    setDirty(true);
    await analysisMutation.submit("analyses", () => AdAnalysisInputSchema.parse({
        accountId: filters.account,
        periodStart: filters.from,
        periodEnd: filters.to,
        marketplace: filters.site || null,
        currency: filters.currency || null,
        evidenceCutoffAt: new Date().toISOString(),
        idempotencyKey: adIdempotency(),
      }), AdAnalysisRunSchema);
  }
  async function seal() {
    if (!run) return;
    setDirty(true);
      const chosen = scopedActions.filter(
        (a) =>
          ["adopted", "executed", "observing", "reviewed"].includes(a.status) &&
          run.result.recommendations.some((r) => r.key === a.recommendation.key),
      );
      await exportMutation.submit("exports", () => AdExportInputSchema.parse({
        runId: run.id,
        actionIds: chosen.map((a) => a.id),
        reviewReason: "人工审阅后封存本次已采纳和已执行的调整清单",
        idempotencyKey: adIdempotency(),
      }), AdExportViewSchema);
  }
  const onSaved = async () => {
    const captured = current.current.ownerKey, target = current.current.accountId;
    setDirty(false);
    const updated = await refresh();
    if (!updated || current.current.ownerKey !== captured || current.current.accountId !== target) return;
    setNotice("已保存；重新分析可查看新目标或新证据的结果");
  };
  async function download(path: string, fileName: string) {
    if (!canRead) return;
    const captured = ownerKey, target = filters.account, epoch = generation.current;
    try {
      const blob = await adDownload(path);
      if (!live.current || epoch !== generation.current || current.current.ownerKey !== captured || current.current.accountId !== target || !current.current.canRead) return;
      const href = URL.createObjectURL(blob), anchor = document.createElement("a");
      anchor.href = href; anchor.download = fileName; document.body.append(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(href);
    } catch (failure) {
      if (!live.current || epoch !== generation.current || !current.current.urlScopeReady || current.current.ownerKey !== captured || current.current.accountId !== target) return;
      if (adDenied(failure)) deny(message(failure)); else setError(message(failure));
    }
  }
  const accountName = account?.name ?? "未选择店铺";
  return (
    <div className="ad-workbench">
      <nav className="ad-tabs" aria-label="广告视图">
        {tabs.map(([value, label]) => (
          <button
            key={value}
            type="button"
            disabled={!mounted || (value === "terms" || value === "campaigns" || value === "voc") && !canRead || value === "imports" && !canRead && !canWrite || value === "goals" && !canRead && !canWrite && !canReview || value === "history" && !canRead && !canWrite && !canReview}
            aria-current={filters.tab === value ? "page" : undefined}
            onClick={() => change({ tab: value, page: "1", detail: "", report: "" })}
          >
            {label}
            {value === "actions" && activeActions.length > 0 ? <b>{activeActions.length}</b> : null}
          </button>
        ))}
      </nav>
      {filters.tab !== "voc" && (
        <div className="ad-toolbar">
          <label>
            店铺
            <select
              aria-label="广告店铺"
              disabled={!mounted}
              value={urlScopeReady ? filters.account : locationAccount ?? ""}
              onChange={(e) =>
                change({
                  account: e.target.value,
                  detail: "",
                  page: "1",
                  search: "",
                  site: "",
                  currency: "",
                })
              }
            >
              <option value="">选择 Amazon 店铺</option>
              {locationAccount && !accounts.some(item => item.id === locationAccount) && <option value={locationAccount} disabled>正在核对所选店铺</option>}
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            开始日期
            <input
              type="date"
              disabled={!mounted || analysisMutation.frozen}
              value={filters.from}
              onChange={(e) => change({ from: e.target.value, page: "1", detail: "" })}
            />
          </label>
          <label>
            结束日期
            <input
              type="date"
              disabled={!mounted || analysisMutation.frozen}
              value={filters.to}
              onChange={(e) => change({ to: e.target.value, page: "1", detail: "" })}
            />
          </label>
          <label>
            站点
            <select
              disabled={!mounted || analysisMutation.frozen}
              value={filters.site}
              onChange={(e) => change({ site: e.target.value, page: "1", detail: "" })}
            >
              <option value="">分别展示全部站点</option>
              {[
                ...new Set(
                  currentImports.flatMap(
                    () =>
                      result?.totals.flatMap((t) => (t.marketplace ? [t.marketplace] : [])) ?? [],
                  ),
                ),
                ...AdMarketplaceSchema.options,
              ]
                .filter((s, i, arr) => arr.indexOf(s) === i)
                .map((s) => (
                  <option key={s}>{s}</option>
                ))}
            </select>
          </label>
          <label>
            币种
            <select
              disabled={!mounted || analysisMutation.frozen}
              value={filters.currency}
              onChange={(e) => change({ currency: e.target.value, page: "1", detail: "" })}
            >
              <option value="">分别展示全部币种</option>
              {[...new Set([...(result?.totals.map((t) => t.currency) ?? []), ...Object.keys(FINANCE_CURRENCY_MINOR_DIGITS)])].map(
                (s) => (
                  <option key={s}>{s}</option>
                ),
              )}
            </select>
          </label>
          {canReview && <button
            className="ad-primary"
            type="button"
            disabled={
              !mounted ||
              busy ||
              Boolean(analysisMutation.commandId) ||
              !filters.account ||
              !filters.from ||
              !filters.to ||
              filters.from > filters.to ||
              dirty && !analysisMutation.frozen
            }
            onClick={() => void analyze()}
          >
            <RefreshCw size={14} />
            {analysisMutation.pending ? "正在保存原提交…" : analysisMutation.frozen ? "重试保存同一笔分析原提交" : "准备分析并核对"}
          </button>}
          {canWrite && <button
            className="ad-secondary"
            type="button"
            disabled={!mounted}
            onClick={() => change({ tab: "imports", detail: "" })}
          >
            <Upload size={14} />
            导入 CSV
          </button>}
          <button className="ad-secondary" type="button" disabled={!mounted || reading} onClick={() => void refresh().catch(() => {})}><RefreshCw size={14} />{reading ? "正在读取工作区" : "重新读取广告工作区"}</button>
          <Link className="ad-secondary" href={`/advertising/originals${filters.account ? `?account=${encodeURIComponent(filters.account)}` : ""}`}>本人广告原提交</Link>
        </div>
      )}
      {error && (
        <div className="ad-error" role="alert">
          <AlertCircle size={16} />
          {error}
          <button
            className="ad-secondary"
            type="button"
            disabled={!mounted}
            onClick={() => void refresh().catch((e) => setError(message(e)))}
          >
            重新读取
          </button>
        </div>
      )}
      {notice && urlScopeReady && (
        <p className="ad-notice" role="status">
          {notice}
        </p>
      )}
      {canReview && <AdMutationFeedback mutation={analysisMutation} title="分析准备已保存" />}
      {analysisMutation.commandId && <AdCommandMutationPanel mutation={analysisMutation} accountId={filters.account} onDenied={deny} onCompleted={detail => { setDirty(false); if (detail.status === "succeeded" && detail.result) change({ tab: "history", detail: `history:analyses:${detail.result.id}`, run: "" }, false); }} />}
      {!data && !error && <Empty text={reading ? "正在读取所选店铺与当前权限…" : "请选择可操作的 Amazon 店铺"} />}
      {data && !canRead && <p className="ad-notice" role="status">当前没有此店铺的广告读取权限 任意历史资料已隐藏 可按获准的录入或审核权限操作 并从完整历史恢复服务端确认的本人记录</p>}
      {data && canRead && (reading || error) && <p className="ad-note">以下为上次读取快照 当前来源与状态待重新核对</p>}
      {data && filters.tab !== "voc" && !data.accounts.length && (
        <Empty text="尚无 Amazon 店铺。请先在店铺与授权中建立店铺记录，再导入报表。" />
      )}
      {filters.tab === "voc" ? (
        vocData && canRead && initialOwner.current === ownerKey && !denied ? (
          <CustomerIntelligenceWorkspace data={vocData} />
        ) : (
          <p role="alert" className="ad-error">
              {canRead ? vocError ?? "VOC 工作区暂不可用" : "当前没有读取权限 私有 VOC 内容已隐藏"}
          </p>
        )
      ) : (
        data &&
        filters.account && (
          <>
            <div className="ad-scope-line">
              <strong>{accountName}</strong>
              <span>
                {filters.from} 至 {filters.to}
              </span>
              {run ? (
                <span>
                  分析于 {new Date(run.createdAt).toLocaleString("zh-CN")} ·{" "}
                  {run.status === "partial" ? "存在待确认项" : "已封存"} ·{" "}
                  {result?.selectedFactCount} 行证据
                </span>
              ) : (
                <span>此窗口与站点／币种范围尚未分析</span>
              )}
              {dirty && <b>有未保存内容</b>}
            </div>
            {canRead && <p className="ad-note">当前工作区仅含所选店铺近期记录 不代表完整历史 来源与原 ID 请到完整历史独立读取{data.historyWindow && <> · 导入 {data.historyWindow.imports.loaded}／最多 {data.historyWindow.imports.limit}{data.historyWindow.imports.hasMore ? " 另有历史" : ""} · 目标 {data.historyWindow.goals.loaded}{data.historyWindow.goals.hasMore ? " 另有历史" : ""} · 观察 {data.historyWindow.observations.loaded}{data.historyWindow.observations.hasMore ? " 另有历史" : ""} · 动作 {data.historyWindow.actions.loaded}{data.historyWindow.actions.hasMore ? " 另有历史" : ""} · 分析 {data.historyWindow.analyses.loaded}／最多 {data.historyWindow.analyses.limit}{data.historyWindow.analyses.hasMore ? " 另有历史" : ""}</>}</p>}
            {(historyMode || missingRun) && <AdvertisingHistory key={`${ownerKey}:${filters.account}:${privateEpoch}`} accountId={filters.account} canRead={canRead} canWrite={canWrite} canReview={canReview} initialTarget={historyTarget} onLocate={target => change({ tab: "history", detail: target ? adHistoryLocation(target) : "", run: "" }, false)} onRestoreAnalysis={value => {
              if (!current.current.urlScopeReady || current.current.ownerKey !== ownerKey || current.current.accountId !== value.accountId || !canRead && !canReview) return;
              setRecoveredRun({ value, owner: ownerKey }); change({ tab: "daily", detail: "", run: value.id, from: value.periodStart, to: value.periodEnd, site: value.marketplace ?? "", currency: value.currency ?? "", page: "1" }, false);
            }} renderAnalysisBasis={value => <AdAnalysisMeasurementPins key={value.id} result={value.result} />} onDirty={setDirty} onDenied={deny} />}
            {availableRuns.length > 0 && <label className="ad-run-picker">已读取的分析版本<select aria-label="已读取的分析版本" value={run?.id ?? ""} disabled={analysisMutation.frozen} onChange={event => {
              const selected = availableRuns.find(row => row.id === event.target.value); if (selected) change({ run: selected.id, from: selected.periodStart, to: selected.periodEnd, site: selected.marketplace ?? "", currency: selected.currency ?? "", page: "1", detail: "" });
            }}><option value="">选择已读取的版本</option>{availableRuns.map(row => <option value={row.id} key={row.id}>{row.periodStart} 至 {row.periodEnd} · {row.marketplace ?? "全部站点"} · {row.currency ?? "各币种"} · {new Date(row.createdAt).toLocaleString("zh-CN")} · {row.id}</option>)}</select></label>}
            {run && <details className="ad-diagnostics ad-run-basis"><summary>本次封存的版本与来源依据</summary><dl className="ad-source-fields">
              <div><dt>分析 ID</dt><dd><code>{run.id}</code></dd></div><div><dt>证据截止时间</dt><dd>{run.evidenceCutoffAt}</dd></div><div><dt>原输入校验值</dt><dd><code>{run.inputChecksum}</code></dd></div>
              <div><dt>已选／替代事实</dt><dd>{run.result.selectedFactCount}／{run.result.supersededFactCount}</dd></div>
              <div><dt>原导入版本</dt><dd>{run.result.evidenceImportIds.length ? run.result.evidenceImportIds.map(id => <code key={id}>{id}<br /></code>) : "没有可用来源"}</dd></div>
              <div><dt>原目标版本</dt><dd>{run.result.goalVersionIds.length ? run.result.goalVersionIds.map(id => <code key={id}>{id}<br /></code>) : "未使用目标版本"}</dd></div>
            </dl><p className="ad-note">这是当时固定的分析结果 新导入、目标和后续状态不会改写此版本 不代表当前实时广告状态</p><AdAnalysisMeasurementPins key={run.id} result={run.result} /></details>}
            {filters.tab === "goals" && (canWrite || canReview) && <AdIndependentForms key={`${ownerKey}:${filters.account}:${privateEpoch}`} accountId={filters.account} canWrite={canWrite} canReview={canReview} onSaved={onSaved} onDirty={setDirty} onDenied={deny} />}
            {["daily", "goals"].includes(filters.tab) && !historyMode && !missingRun && (
              <>
                {!run ? (
                  <Empty
                    text={
                      currentImports.length
                        ? "选择报表覆盖的完整日期范围，运行分析后查看产品与建议。"
                        : "先导入每日下载的广告报表，再设置每个产品的目标。"
                    }
                  />
                ) : (
                  <>
                    {filters.tab === "daily" && (
                      <>
                        <div className="ad-kpis">
                          {result?.totals.map((t, i) => (
                            <div key={i}>
                              <strong>
                                {t.marketplace ?? "站点未确认"} · {t.currency} ·{" "}
                                {t.adProduct ?? "广告产品未确认"}
                              </strong>
                              <small>
                                广告主 {t.advertiserId ?? "未提供"} · {t.measurementScope}
                              </small>
                              <dl>
                                <dt>花费</dt>
                                <dd>{adMoney(t.metrics.spendMinor, t.currency, t.monetaryBasis)}</dd>
                                <dt>归因销售额</dt>
                                <dd>{adMoney(t.metrics.salesMinor, t.currency, t.monetaryBasis)}</dd>
                                <dt>ACoS</dt>
                                <dd>{adPercent(t.ratios.acosBps)}</dd>
                                <dt>购买量</dt>
                                <dd>{t.metrics.purchases ?? "—"}</dd>
                              </dl>
                              <AdMonetaryBasisNote currency={t.currency} basis={t.monetaryBasis} />
                              <small>{t.conversion ? `${adConversionLabels[t.conversion.model]} · ${t.conversion.windowDays ?? "未知"} 天 · ${t.conversion.state === "resolved" ? "依据已固定" : t.conversion.state === "conflict" ? "依据冲突" : "依据未确认"}` : "原转化指标定义未保存"}</small>
                              <details className="ad-inline-measurement"><summary>核对本组转化口径</summary><AdConversionSummary conversion={t.conversion} /></details>
                            </div>
                          ))}
                        </div>
                        <p className="ad-note">
                          总计取 {result?.controlType ? adLabels[result.controlType] : "当前无控制"}{" "}
                          报表；金额按币种、广告产品和归因口径分开核对。广告购买量含来源归因，不推算自然订单。
                        </p>
                        <section className="ad-panel">
                          <header>
                            <h2>今天需要审阅</h2>
                            <button
                              className="ad-link"
                              onClick={() =>
                                change({ tab: "actions", status: "pending", page: "1", detail: "" })
                              }
                            >
                              {activeActions.length} 条待审阅 <ChevronRight size={14} />
                            </button>
                          </header>
                          {activeActions.length ? (
                            <ul className="ad-queue">
                              {activeActions.slice(0, 8).map((a) => (
                                <li key={a.id}>
                                  <button onClick={() => change({ tab: "history", detail: `history:actions:${a.id}`, run: "" })}>
                                    <span
                                      className={`ad-tag priority-${a.recommendation.priority}`}
                                    >
                                      {a.recommendation.priority === "critical"
                                        ? "先处理"
                                        : a.recommendation.priority === "high"
                                          ? "重点"
                                          : "审阅"}
                                    </span>
                                    <div>
                                      <strong>{a.recommendation.title}</strong>
                                      <small>
                                        {a.recommendation.scope?.asin ?? "产品待关联"} ·{" "}
                                        {a.recommendation.term ?? a.recommendation.campaignId} ·{" "}
                                        {a.recommendation.reason}
                                      </small>
                                    </div>
                                    <b>
                                      {adMoney(
                                        a.recommendation.metrics.spendMinor,
                                        a.recommendation.currency,
                                        a.recommendation.monetaryBasis,
                                      )}
                                    </b>
                                    <ChevronRight size={15} />
                                  </button>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <Empty text="当前没有待审阅建议。检查归因窗口、产品目标和样本门槛；空队列不等于广告已盈利。" />
                          )}
                        </section>
                        <section className="ad-panel">
                          <header>
                            <h2>日趋势</h2>
                          </header>
                          {result?.dailyTrend.length ? (
                            <DailyTrend rows={result.dailyTrend} />
                          ) : (
                            <Empty text="本次控制表只有区间汇总，或缺少可用日报；补充同口径日报后展示真实日趋势。" />
                          )}
                        </section>
                      </>
                    )}
                    <section className="ad-panel">
                      <header>
                        <h2>产品表现与目标</h2>
                        <label>
                          目标筛选
                          <select
                            value={filters.mode}
                            onChange={(e) =>
                              change({ mode: e.target.value, page: "1", detail: "" })
                            }
                          >
                            <option value="">全部产品</option>
                            <option value="rank_growth">推排名</option>
                            <option value="profit_defense">保利润</option>
                          </select>
                        </label>
                      </header>
                      <Search
                        value={filters.search}
                        change={(search) => change({ search, page: "1", detail: "" })}
                        placeholder="搜索 ASIN 或产品名"
                      />
                      <div className="ad-table-scroll">
                        <table aria-label="产品表现">
                          <thead>
                            <tr>
                              <th>产品／口径</th>
                              <th>目标</th>
                              <th>核心词自然排名</th>
                              <th>花费</th>
                              <th>归因销售额</th>
                              <th>ACoS</th>
                              <th>TACoS</th>
                              <th>广告后贡献利润</th>
                              <th>审阅</th>
                            </tr>
                          </thead>
                          <tbody>
                            {products.slice((pageNumber - 1) * 20, pageNumber * 20).map((p) => (
                              <tr key={p.key}>
                                <td>
                                  <strong>{p.scope.asin}</strong>
                                  <small>{p.productName ?? "商品名称未提供"}</small>
                                  <small>
                                    {p.scope.marketplace} · {p.measurementScope}
                                  </small>
                                  <small>{p.conversion ? `${adConversionLabels[p.conversion.model]} · ${p.conversion.windowDays ?? "未知"} 天 · ${p.conversion.state === "resolved" ? "依据已固定" : p.conversion.state === "conflict" ? "依据冲突" : "依据未确认"}` : "原转化指标定义未保存"}</small>
                                </td>
                                <td>
                                  <Mode product={p} />
                                </td>
                                <td>
                                  <CoreRanks product={p} />
                                </td>
                                <td>{adMoney(p.metrics.spendMinor, p.scope.currency, p.monetaryBasis)}</td>
                                <td>{adMoney(p.metrics.salesMinor, p.scope.currency, p.monetaryBasis)}</td>
                                <td>{adPercent(p.ratios.acosBps)}</td>
                                <td>{adPercent(p.tacosBps)}</td>
                                <td>
                                  {p.postAdContributionMinor === null ? (
                                    <span className="ad-muted">经营数据待补充</span>
                                  ) : (
                                    adMoney(p.postAdContributionMinor, p.scope.currency, p.monetaryBasis)
                                  )}
                                </td>
                                <td>
                                  <button
                                    className="ad-link"
                                    aria-label={`查看 ${p.scope.asin} 目标`}
                                    onClick={() => change({ detail: `product:${p.key}` })}
                                  >
                                    <Settings2 size={14} />
                                    目标与证据
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {!products.length && (
                        <Empty text="当前窗口没有可唯一关联 ASIN 的广告商品事实，或没有匹配筛选的产品。" />
                      )}
                      <Pager
                        page={pageNumber}
                        count={products.length}
                        size={20}
                        change={(page) => change({ page: String(page), detail: "" })}
                      />
                    </section>
                    {!!result?.diagnostics.length && (
                      <details className="ad-diagnostics">
                        <summary>口径与数据诊断（{result.diagnostics.length}）</summary>
                        <ul>
                          {result.diagnostics.map((d, i) => (
                            <li key={i}>{d.message}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </>
                )}
              </>
            )}
            {["terms", "campaigns"].includes(filters.tab) && canRead && (
              <section className="ad-panel">
                <header>
                  <h2>来源明细</h2>
                  <label>
                    报表类型
                    <select
                      value={report}
                      onChange={(e) => change({ report: e.target.value, page: "1", detail: "" })}
                    >
                      {(filters.tab === "terms"
                        ? ["search_term", "targeting", "search_term_share"]
                        : [
                            "campaign",
                            "placement",
                            "top_of_search_share",
                            "audience",
                            "converted_product",
                            "benchmark",
                            "delivery_measurement",
                            "advertised_product",
                          ]
                      ).map((t) => (
                        <option key={t} value={t}>
                          {adLabels[t as AdReportType]}
                        </option>
                      ))}
                    </select>
                  </label>
                </header>
                <p className="ad-note">
                  显示所选店铺的原始导入版本，可按词、ASIN
                  或活动搜索。此列表不按顶部分析日期、站点和币种筛选 每行保留自己的日期与归因口径；区间明细不追加到控制总额，份额排名不作为自然排名。
                </p>
                <Search
                  value={filters.search}
                  change={(search) => change({ search, page: "1", detail: "" })}
                  placeholder="搜索词、ASIN、活动或投放 ID"
                />
                {factsError ? (
                  <p className="ad-error" role="alert">
                    {factsError}
                    <button className="ad-secondary" onClick={() => setFactsRetry((n) => n + 1)}>
                      重新读取明细
                    </button>
                  </p>
                ) : factsLoading ? (
                  <Empty text="正在读取明细…" />
                ) : (
                  factPage && (
                    <>
                      <div className="ad-table-scroll">
                        <table aria-label="广告来源明细">
                          <thead>
                            <tr>
                              <th>对象／活动</th>
                              <th>日期／口径</th>
                              <th>点击</th>
                              <th>购买量</th>
                              <th>花费</th>
                              <th>归因销售额</th>
                              <th>来源</th>
                            </tr>
                          </thead>
                          <tbody>
                            {factPage.rows.map((r) => (
                              <tr key={r.id}>
                                <td>
                                  <strong>
                                    {r.fact.term ??
                                      r.fact.placement ??
                                      r.fact.asin ??
                                      r.fact.campaignName ??
                                      "未提供对象"}
                                  </strong>
                                  <small>
                                    {r.fact.campaignName ?? r.fact.campaignId ?? "活动未提供"} ·{" "}
                                    {r.fact.adProduct ?? "广告产品待关联"}
                                  </small>
                                </td>
                                <td>
                                  {r.fact.periodStart
                                    ? `${r.fact.periodStart} — ${r.fact.periodEnd}`
                                    : "日期缺失"}
                                  <small>
                                    {r.timezone} · {r.attributionWindowDays ?? "未知"} 天 · {r.attributionBasis}
                                  </small>
                                </td>
                                <td>{r.fact.metrics.clicks ?? "—"}</td>
                                <td>{r.fact.metrics.purchases ?? "—"}</td>
                                <td>
                                  {adMoney(r.fact.metrics.spendMinor, r.fact.currency, r.fact.measurement?.monetaryBasis)}
                                </td>
                                <td>
                                  {adMoney(r.fact.metrics.salesMinor, r.fact.currency, r.fact.measurement?.monetaryBasis)}
                                </td>
                                <td>
                                  <button
                                    className="ad-link"
                                    onClick={() => change({ detail: `fact:${r.id}` })}
                                  >
                                    第 {r.fact.sourceRow} 行 <FileText size={14} />
                                  </button>
                                  <small>
                                    {new Date(r.observedAt).toLocaleDateString("zh-CN")}
                                  </small>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {!factPage.rows.length && <Empty text="没有匹配的来源明细。" />}
                      <Pager
                        page={pageNumber}
                        count={factPage.count}
                        size={50}
                        change={(page) => change({ page: String(page), detail: "" })}
                      />
                    </>
                  )
                )}
              </section>
            )}
            {filters.tab === "actions" && canRead && (
              <section className="ad-panel">
                <header>
                  <h2>调整与复盘</h2>
                  <label>
                    状态
                    <select
                      value={filters.status}
                      onChange={(e) => change({ status: e.target.value, page: "1", detail: "" })}
                    >
                      <option value="">全部状态</option>
                      {Object.entries(adStatusLabels).map(([s, l]) => (
                        <option value={s} key={s}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </label>
                  {canReview && <button
                    className="ad-secondary"
                    onClick={() => void seal()}
                    disabled={
                      busy ||
                      Boolean(exportMutation.commandId) ||
                      !run ||
                      !scopedActions.some(
                        (a) =>
                          a.status === "adopted" ||
                          a.status === "executed" ||
                          a.status === "observing" ||
                          a.status === "reviewed",
                      )
                    }
                  >
                    <Download size={14} />
                    保存审阅封存原填写并核对
                  </button>}
                </header>
                {canReview && <AdMutationFeedback mutation={exportMutation} title="审阅封存准备已保存" />}
                {exportMutation.commandId && <AdCommandMutationPanel mutation={exportMutation} accountId={filters.account} onDenied={deny} onCompleted={detail => { setDirty(false); if (detail.status === "succeeded" && detail.result) change({ tab: "history", detail: `history:exports:${detail.result.id}`, run: "" }, false); }} />}
                <Search
                  value={filters.search}
                  change={(search) => change({ search, page: "1", detail: "" })}
                  placeholder="搜索建议、词或 ASIN"
                />
                <div className="ad-table-scroll">
                  <table aria-label="广告调整记录">
                    <thead>
                      <tr>
                        <th>建议／产品</th>
                        <th>状态</th>
                        <th>竞价前 → 后</th>
                        <th>点击／购买量</th>
                        <th>花费</th>
                        <th>观察日期</th>
                        <th>处理</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleActions.slice((pageNumber - 1) * 20, pageNumber * 20).map((a) => (
                        <tr key={a.id}>
                          <td>
                            <strong>{a.recommendation.title}</strong>
                            <small>
                              {a.recommendation.scope?.asin ?? "产品待关联"} ·{" "}
                              {a.recommendation.term ?? a.recommendation.campaignId}
                            </small>
                          </td>
                          <td>
                            <span className={`ad-tag state-${a.status}`}>
                              {adStatusLabels[a.status]}
                            </span>
                          </td>
                          <td>
                            {adMoney(
                              a.recommendation.currentBidMinor,
                              a.recommendation.currency,
                              a.recommendation.monetaryBasis,
                            )}{" "}
                            →{" "}
                            {adMoney(
                              a.recommendation.proposedBidMinor,
                              a.recommendation.currency,
                              a.recommendation.monetaryBasis,
                            )}
                          </td>
                          <td>
                            {a.recommendation.metrics.clicks ?? "—"}／
                            {a.recommendation.metrics.purchases ?? "—"}
                          </td>
                          <td>
                            {adMoney(
                              a.recommendation.metrics.spendMinor,
                              a.recommendation.currency,
                              a.recommendation.monetaryBasis,
                            )}
                          </td>
                          <td>
                            {a.executedAt
                              ? new Date(
                                  Date.parse(a.executedAt) +
                                    (data.goals.find((g) => g.id === a.recommendation.goalVersionId)
                                      ?.fields.cooldownDays ?? 7) *
                                      86400000,
                                ).toLocaleDateString("zh-CN")
                              : a.recommendation.reviewAfter}
                          </td>
                          <td>
                            <button
                              className="ad-link"
                              onClick={() => change({ tab: "history", detail: `history:actions:${a.id}`, run: "" })}
                            >
                              查看与处理 <ChevronRight size={14} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!visibleActions.length && (
                  <Empty text="当前筛选下没有调整记录。运行分析生成候选，或查看其他处理状态。" />
                )}
                <Pager
                  page={pageNumber}
                  count={visibleActions.length}
                  size={20}
                  change={(page) => change({ page: String(page), detail: "" })}
                />
              </section>
            )}
            {filters.tab === "imports" && (
              <>
                {canWrite && <AdImportPanel
                  key={`${ownerKey}:${filters.account}:${privateEpoch}`}
                  accountId={filters.account}
                  permitted={canWrite}
                  onDenied={deny}
                  onArchived={onSaved}
                  onDirty={setDirty}
                  onCommitted={async (imports) => {
                    const captured = current.current.ownerKey, target = filters.account;
                    const updated = await refresh();
                    if (!updated || current.current.ownerKey !== captured || current.current.accountId !== target) return;
                    const starts = imports
                        .flatMap((r) => (r.periodStart ? [r.periodStart] : []))
                        .sort(),
                      ends = imports.flatMap((r) => (r.periodEnd ? [r.periodEnd] : [])).sort();
                    change(
                      {
                        from: starts[0] ?? filters.from,
                        to: ends.at(-1) ?? filters.to,
                        detail: "",
                      },
                      false,
                    );
                    setNotice(`${imports.length} 份报表已导入，运行分析后查看产品目标与诊断`);
                  }}
                />}
                {canRead && <section className="ad-panel">
                  <header>
                    <h2>导入历史</h2>
                    <span>最近 200 份来源 · 归档保留历史</span>
                  </header>
                  <div className="ad-table-scroll">
                    <table aria-label="广告导入历史">
                      <thead>
                        <tr>
                          <th>文件／类型</th>
                          <th>统计范围</th>
                          <th>声明归因／指标定义</th>
                          <th>可用／隔离行</th>
                          <th>下载时间</th>
                          <th>状态</th>
                          <th>来源</th>
                        </tr>
                      </thead>
                      <tbody>
                        {currentImports.map((i) => (
                          <tr key={i.id}>
                            <td>
                              {i.fileName}
                              <small>{adLabels[i.reportType]}</small>
                            </td>
                            <td>
                              {i.periodStart ?? "未知"} 至 {i.periodEnd ?? "未知"}
                            </td>
                            <td>
                              {i.attributionWindowDays ?? "未知"} 天 · {i.attributionBasis}
                              <small>{i.timezone}</small>
                              <small>{i.measurement ? `${adConversionLabels[i.measurement.conversion.model]} · ${i.measurement.conversion.state === "resolved" ? "依据已固定" : i.measurement.conversion.state === "conflict" ? "依据冲突" : "依据未确认"}` : "原测量依据未保存"}</small>
                            </td>
                            <td>
                              {i.acceptedRowCount}／{i.rejectedRowCount}
                            </td>
                            <td>{new Date(i.observedAt).toLocaleString("zh-CN")}</td>
                            <td>{i.archivedAt ? "已归档" : "可用于分析"}</td>
                            <td>
                              <a
                                className="ad-link"
                                href={`/api/advertising/imports/${i.id}/source`}
                                download
                                onClick={event => { event.preventDefault(); void download(`imports/${i.id}/source`, `advertising-source-${i.id}.csv`); }}
                              >
                                原文件
                              </a>
                              <button
                                className="ad-link"
                                onClick={() => change({ tab: "history", detail: `history:imports:${i.id}`, run: "" })}
                              >
                                详情
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!currentImports.length && <Empty text="还没有导入历史。" />}
                </section>}
              </>
            )}
            {filters.tab === "actions" && !canRead && <Empty text="当前没有读取调整历史的权限 本次分析回执不会授予任意调整 ID 的读取权限 已知动作的完整后续核对需另行取得读取权限" />}
          </>
        )
      )}
      {filters.detail && !historyMode &&
        urlScopeReady &&
        mounted &&
        createPortal(
          <div
            className="ad-workbench ad-drawer-backdrop"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) change({ detail: "" });
            }}
          >
            <aside
              className="ad-drawer"
              role="dialog"
              aria-modal="true"
              aria-label="广告证据与处理"
              onKeyDown={(e) => {
                if (e.key === "Escape") change({ detail: "" });
              }}
            >
              <header>
                <div>
                  <small>广告证据与处理</small>
                  <h2>
                    {selectedProduct?.scope.asin ??
                      selectedFact?.fact.term ??
                      "来源详情"}
                  </h2>
                </div>
                <button
                  type="button"
                  className="ad-icon"
                  aria-label="关闭广告详情"
                  onClick={() => change({ detail: "" })}
                >
                  <X size={19} />
                </button>
              </header>
              {selectedProduct ? (
                <>
                  <div className="ad-drawer-tabs">
                    <button
                      aria-pressed={drawerTab === "goal"}
                      onClick={() => {
                        if (!dirty || window.confirm("放弃未保存内容并切换？")) {
                          setDirty(false);
                          setDrawerTab("goal");
                        }
                      }}
                    >
                      产品目标
                    </button>
                    <button
                      aria-pressed={drawerTab === "evidence"}
                      onClick={() => {
                        if (!dirty || window.confirm("放弃未保存内容并切换？")) {
                          setDirty(false);
                          setDrawerTab("evidence");
                        }
                      }}
                    >
                      经营与自然排名证据
                    </button>
                  </div>
                  {drawerTab === "goal" ? (
                    <>
                      <p className="ad-note">
                        当前分析固定目标{" "}
                        {selectedProduct.goal ? `V${selectedProduct.goal.revision}` : "未设置"} ·
                        保本 ACoS {adPercent(selectedProduct.breakEvenAcosBps)}（按填写成本测算）
                      </p>
                      <AdGoalForm
                        key={`${ownerKey}:${selectedProduct.key}:${privateEpoch}`}
                        scope={selectedProduct.scope}
                        goal={
                          data?.goals.find(
                            (g) =>
                              g.scope.accountId === selectedProduct.scope.accountId &&
                              g.scope.asin === selectedProduct.scope.asin &&
                              g.scope.marketplace === selectedProduct.scope.marketplace &&
                              g.scope.currency === selectedProduct.scope.currency,
                          ) ?? null
                        }
                        expectedRevision={Math.max(
                          0,
                          ...(data?.goals
                            .filter(
                              (g) =>
                                JSON.stringify(g.scope) === JSON.stringify(selectedProduct.scope),
                            )
                            .map((g) => g.revision) ?? []),
                        )}
                        onSaved={onSaved}
                        onDirty={setDirty}
                        permitted={canReview}
                        onDenied={deny}
                      />
                    </>
                  ) : (
                    <>
                      <AdObservationForm
                        scope={selectedProduct.scope}
                        periodStart={selectedProduct.periodStart}
                        periodEnd={selectedProduct.periodEnd}
                        onSaved={onSaved}
                        onDirty={setDirty}
                        permitted={canWrite}
                        onDenied={deny}
                      />
                      <h3>来源观察</h3>
                      <ul className="ad-events">
                        {data?.observations
                          .filter(
                            (o) =>
                              o.scope.accountId === selectedProduct.scope.accountId &&
                              o.scope.asin === selectedProduct.scope.asin &&
                              o.scope.currency === selectedProduct.scope.currency &&
                              o.scope.marketplace === selectedProduct.scope.marketplace,
                          )
                          .map((o) => (
                            <li key={o.id}>
                              <strong>
                                {o.kind === "organic_rank"
                                  ? `${o.keyword} · 自然第 ${o.organicRank} 名`
                                  : `总销售额 ${adMoney(o.totalSalesMinor, o.scope.currency, o.monetaryBasis)}`}
                              </strong>
                              <small>
                                {o.periodStart} 至 {o.periodEnd}
                              </small>
                              <p>{o.source}</p>
                              {o.kind === "commerce" && <AdMonetaryBasisNote currency={o.scope.currency} basis={o.monetaryBasis} />}
                            </li>
                          ))}
                      </ul>
                    </>
                  )}
                </>
              ) : selectedFact ? (
                <FactDetail row={selectedFact} />
              ) : (
                <Empty text="所选记录已不在当前页面或筛选范围内，请关闭后重新选择。" />
              )}
            </aside>
          </div>,
          document.body,
        )}
    </div>
  );
}
function Empty({ text }: { text: string }) {
  return <p className="ad-empty">{text}</p>;
}
function Search({
  value,
  change,
  placeholder,
}: {
  value: string;
  change: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label className="ad-search">
      搜索
      <input
        aria-label={placeholder}
        value={value}
        placeholder={placeholder}
        onChange={(e) => change(e.target.value)}
      />
    </label>
  );
}
function Pager({
  page,
  count,
  size,
  change,
}: {
  page: number;
  count: number;
  size: number;
  change: (n: number) => void;
}) {
  return (
    <div className="ad-pager">
      <span>
        {count} 条 · 第 {page}／{Math.max(1, Math.ceil(count / size))} 页
      </span>
      <button
        className="ad-icon"
        aria-label="上一页"
        disabled={page <= 1}
        onClick={() => change(page - 1)}
      >
        <ChevronLeft size={15} />
      </button>
      <button
        className="ad-icon"
        aria-label="下一页"
        disabled={page * size >= count}
        onClick={() => change(page + 1)}
      >
        <ChevronRight size={15} />
      </button>
    </div>
  );
}
function Mode({ product }: { product: AdProductSummary }) {
  return (
    <span className={`ad-tag mode-${product.goal?.fields.mode ?? "unset"}`}>
      {product.goal
        ? `${product.goal.fields.mode === "rank_growth" ? "推排名" : "保利润"} · V${product.goal.revision}`
        : "待设置目标"}
    </span>
  );
}
function CoreRanks({ product }: { product: AdProductSummary }) {
  const ranks = adRankProgress(product);
  if (!ranks.length) return <span className="ad-muted">—</span>;
  return (
    <>
      {ranks.map((r) => (
        <div key={r.keyword} title={r.source ?? "需要实际自然排名来源"}>
          <strong>{r.keyword}</strong>
          <small>
            {r.latest === null ? "自然排名待补充" : `${r.baseline} → ${r.latest} · ${r.date}`}
          </small>
        </div>
      ))}
    </>
  );
}
export function AdAnalysisMeasurementPins({ result }: { result: AdAnalysisResult }) {
  const [page, setPage] = useState(1);
  const pins = result.measurementPins, size = 25;
  const pages = Math.max(1, Math.ceil((pins?.length ?? 0) / size)), currentPage = Math.min(page, pages);
  return <section className="ad-measurement-pins" aria-label="本次封存测量依据">
    <h3>本次封存测量依据</h3>
    <p className="ad-note">测量版本 {result.measurementVersion ?? "历史未保存"} · 仅使用此分析保存的来源快照 不读取今天的导入或重新推断指标</p>
    {!pins ? <p className="ad-note">原分析未保存逐来源测量依据 原金额与转化定义保持未知</p> : pins.length === 0 ? <p className="ad-note">此版本没有保存来源测量条目</p> : <>
      <p className="ad-note">已读取完整传输 {pins.length} 项 当前显示 {(currentPage - 1) * size + 1}–{Math.min(currentPage * size, pins.length)} 项 每个来源可按原币种分别固定依据</p>
      <nav className="ad-pager" aria-label="封存测量依据分页"><button type="button" className="ad-secondary" disabled={currentPage === 1} onClick={() => setPage(value => Math.max(1, value - 1))}>上一页测量依据</button><span>第 {currentPage}／{pages} 页</span><button type="button" className="ad-secondary" disabled={currentPage === pages} onClick={() => setPage(value => Math.min(pages, value + 1))}>下一页测量依据</button></nav>
      <ol className="ad-pin-list" key={currentPage}>{pins.slice((currentPage - 1) * size, currentPage * size).map((pin, index) => <li key={`${pin.importId}:${index}`}>
        <details><summary>来源 <code>{pin.importId}</code> · {pin.currency ?? "原币种未知"}</summary>
          <dl className="ad-source-fields"><div><dt>原来源校验值</dt><dd><code>{pin.sourceChecksum ?? "历史未保存"}</code></dd></div><div><dt>原采集时间</dt><dd>{pin.observedAt}</dd></div><div><dt>原时区</dt><dd>{pin.timezone}</dd></div><div><dt>原声明归因</dt><dd>{pin.declaredWindowDays ?? "未知"} 天 · {pin.declaredBasis}</dd></div><div><dt>封存时来源归档</dt><dd>{pin.sourceArchivedAt ?? "当时未归档"}</dd></div></dl>
          <AdMeasurementSummary measurement={pin.measurement} currency={pin.currency} />
        </details>
      </li>)}</ol>
    </>}
  </section>;
}
function FactDetail({ row }: { row: AdStoredFact }) {
  return (
    <>
      <p className="ad-note">
        导入来源 {row.importId} · 原文件第 {row.fact.sourceRow} 行
      </p>
      <dl className="ad-source-fields"><div><dt>原来源校验值</dt><dd><code>{row.sourceChecksum ?? "历史未保存"}</code></dd></div><div><dt>采集与声明口径</dt><dd>{row.observedAt} · {row.timezone} · {row.attributionWindowDays ?? "未知"} 天 · {row.attributionBasis}</dd></div><div><dt>来源归档</dt><dd>{row.sourceArchivedAt === undefined ? "历史归档状态未保存" : row.sourceArchivedAt ?? "返回依据未归档"}</dd></div></dl>
      <AdMeasurementSummary measurement={row.fact.measurement} sourceFields={row.fact.sourceFields} currency={row.fact.currency} />
      <h3>完整原始单元格</h3>
      <dl className="ad-source-fields">
        {Object.entries(row.fact.sourceFields).map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v || "未提供"}</dd>
          </div>
        ))}
      </dl>
      <p className="ad-note">
        逻辑行校验值 <code>{row.fact.rowKey}</code>
      </p>
    </>
  );
}
function DailyTrend({
  rows,
}: {
  rows: NonNullable<AdvertisingWorkspace["analyses"][number]>["result"]["dailyTrend"];
}) {
  const groups = new Map<string, { label: string; values: typeof rows }>();
  for (const r of rows) {
    const label = `${r.marketplace ?? "未知站点"} · ${r.currency} · ${r.measurementScope}`;
    const key = JSON.stringify([label, r.monetaryBasis ?? null, r.conversion ?? null]);
    const group = groups.get(key);
    if (group) group.values.push(r);
    else groups.set(key, { label, values: [r] });
  }
  return (
    <div className="ad-trends">
      {[...groups].map(([key, { label, values }]) => {
        const max = Math.max(1, ...values.map((v) => v.metrics.spendMinor ?? 0));
        return (
          <div key={key}>
            <strong>{label}</strong>
            <AdMonetaryBasisNote currency={values[0]!.currency} basis={values[0]!.monetaryBasis} />
            <details className="ad-inline-measurement"><summary>核对趋势转化口径</summary><AdConversionSummary conversion={values[0]!.conversion} /></details>
            {!values[0]!.monetaryBasis ? <><p className="ad-note">原精度未保存 不绘制主单位金额趋势 以下保留每日原最小整数</p><ul className="ad-trend-originals">{values.slice().sort((a, b) => a.date.localeCompare(b.date)).map(value => <li key={value.date}>{value.date} · {adMoney(value.metrics.spendMinor, value.currency)}</li>)}</ul></> : <ol aria-label={`${label} 日花费`} className="ad-bars">
              {values
                .sort((a, b) => a.date.localeCompare(b.date))
                .map((v) => (
                  <li
                    key={v.date}
                    title={`${v.date} · ${adMoney(v.metrics.spendMinor, v.currency, v.monetaryBasis)}`}
                  >
                    <span
                      style={{
                        height:
                          v.metrics.spendMinor === null || v.metrics.spendMinor === 0
                            ? "0%"
                            : `${Math.max(1, (v.metrics.spendMinor / max) * 100)}%`,
                      }}
                    />
                    <small>{v.date.slice(5)}</small>
                  </li>
                ))}
            </ol>}
          </div>
        );
      })}
    </div>
  );
}
