"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Calculator, Check, ExternalLink, FileCheck2, RefreshCw, Table2 } from "lucide-react";
import {
  ModelBillingBasisSchema,
  ModelBillingConfirmSchema,
  ModelBillingOwnerSchema,
  ModelBillingReceiptViewSchema,
  ModelBillingWorkspaceSchema,
  ModelBillingSubjectIdSchema,
  type ModelBillingBasis,
  type ModelBillingOwner,
  type ModelBillingWorkspace,
} from "@yummyai/contracts/ai/model-billing";
import type {
  OfficialApiPriceCatalog,
  OfficialApiPriceCheck,
} from "@yummyai/contracts/ai/official-model-pricing";
import { ModelTokenUsageLine } from "../ai-assist/model-usage-summary";
import { InvocationEvidence } from "../execution/invocation-evidence";
import "../order-centers/order-centers.css";
import "./model-billing.css";

type Draft = {
  amountUsd: string;
  invoiceReference: string;
  providerRequestId: string;
  evidenceKind: "provider_invoice" | "provider_usage" | "provider_support";
  proofChecksum: string;
  fileName: string;
  matches: boolean;
};
const empty = (): Draft => ({
  amountUsd: "",
  invoiceReference: "",
  providerRequestId: "",
  evidenceKind: "provider_invoice",
  proofChecksum: "",
  fileName: "",
  matches: false,
});
const kinds = {
  provider_invoice: "渠道账单",
  provider_usage: "渠道用量明细",
  provider_support: "渠道人工确认",
};
class BillingFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function read(path: string, init?: RequestInit) {
  const response = await fetch(`/api/model-billing/${path}`, { ...init, cache: "no-store" });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new BillingFailure(response.status, body?.message ?? "费用服务暂时不可用 请重试");
  return body;
}
const message = (error: unknown) =>
  error instanceof BillingFailure ? error.message : "费用记录读取失败 请重试";
const denied = (error: unknown) =>
  error instanceof BillingFailure && [401, 403, 404, 503].includes(error.status);

const ownerLabels: Record<ModelBillingOwner, string> = {
  assist: "AI 辅助",
  pod: "POD 处理",
  order_design: "订单无人设计",
};
const endpointLabels: Record<OfficialApiPriceCheck["endpointKind"], string> = {
  images: "Images API",
  responses: "Responses API",
  chat_completions: "Chat Completions API",
  unknown: "调用接口未识别",
};
const priceStatusLabels: Record<OfficialApiPriceCheck["status"], string> = {
  calculated: "官方核价已完成",
  partial: "官方核价依据不完整",
  usage_missing: "原调用用量未返回",
  model_unsupported: "官方价表尚未覆盖此模型",
};
function OfficialRate({ value }: { value: string | null }) {
  return value === null ? (
    <span title="官方标准价表未单列此项">—</span>
  ) : (
    <span className="model-billing-money">{"$" + value}</span>
  );
}

export function OfficialPriceCatalogPanel({ catalog, loading = false }: {
  catalog?: OfficialApiPriceCatalog;
  loading?: boolean;
}) {
  return (
    <section aria-label="官方标准 API 价表" className="model-billing-price-catalog">
      <header className="model-billing-price-heading">
        <h2><Table2 size={17} aria-hidden="true" />官方标准 API 价表</h2>
        {catalog && <p>
          USD / {catalog.unitTokens.toLocaleString("zh-CN")} token · 核价日期{" "}
          <time dateTime={catalog.checkedAt}>{catalog.checkedAt.slice(0, 10)}</time>
        </p>}
      </header>
      {!catalog ? (
        <p role="status">{loading ? "正在读取官方标准 API 价格…" : "价格暂未读取 请刷新费用记录"}</p>
      ) : (
        <>
          <p className="model-billing-price-meta">标准 API 公开价 · 版本 {catalog.version}</p>
          {!catalog.rates.length ? <p>官方价表暂无模型价格</p> : (
            <div className="model-billing-price-scroll" role="region" aria-label="官方 API 单价明细 可横向滚动" tabIndex={0}>
              <table className="model-billing-price-table">
                <caption>每百万 token 的美元单价 缓存输入和缓存写入均为输入子集</caption>
                <thead><tr>
                  <th scope="col">模型</th>
                  <th scope="col">文本输入</th>
                  <th scope="col">文本缓存输入</th>
                  <th scope="col">图像输入</th>
                  <th scope="col">图像缓存输入</th>
                  <th scope="col">输出</th>
                  <th scope="col">缓存写入</th>
                  <th scope="col">来源</th>
                </tr></thead>
                <tbody>{catalog.rates.map(rate => (
                  <tr key={rate.modelId}>
                    <th scope="row">
                      <strong>{rate.modelId}</strong>
                      <small>{rate.category === "image" ? "图像模型" : "文本模型"}</small>
                      {(rate.longContextAfterInputTokens !== null || rate.notes.length > 0) && (
                        <details className="model-billing-price-rules">
                          <summary>计价规则</summary>
                          {rate.longContextAfterInputTokens !== null && (
                            <p>输入超过 {rate.longContextAfterInputTokens.toLocaleString("zh-CN")} token 时适用长上下文规则</p>
                          )}
                          {!!rate.notes.length && <ul>{rate.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
                        </details>
                      )}
                    </th>
                    <td><OfficialRate value={rate.inputUsdPerMillion} /></td>
                    <td><OfficialRate value={rate.cachedInputUsdPerMillion} /></td>
                    <td><OfficialRate value={rate.imageInputUsdPerMillion} /></td>
                    <td><OfficialRate value={rate.cachedImageInputUsdPerMillion} /></td>
                    <td><OfficialRate value={rate.outputUsdPerMillion} /></td>
                    <td>
                      {rate.cacheWrite30mUsdPerMillion === null && rate.cacheWrite12hUsdPerMillion === null ? (
                        <OfficialRate value={null} />
                      ) : (
                        <>
                          <span className="model-billing-rate-term">30 分钟 <OfficialRate value={rate.cacheWrite30mUsdPerMillion} /></span>
                          <span className="model-billing-rate-term">12 小时 <OfficialRate value={rate.cacheWrite12hUsdPerMillion} /></span>
                        </>
                      )}
                    </td>
                    <td><a href={rate.sourceUrl} target="_blank" rel="noopener noreferrer" aria-label={rate.modelId + " 官方价格来源"}>
                      官方文档 <ExternalLink size={12} aria-hidden="true" />
                    </a></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          {!!catalog.notes.length && (
            <ul className="model-billing-price-notes">{catalog.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>
          )}
        </>
      )}
    </section>
  );
}

export function OfficialPriceCheckPanel({ check }: { check?: OfficialApiPriceCheck }) {
  const calculated = check?.status === "calculated" && check.amountUsd !== null;
  const status = check?.status === "calculated" && !calculated ? "partial" : check?.status;
  return (
    <section aria-label="原调用官方核价" className="model-billing-price-check" data-price-state={status ?? "not_loaded"}>
      <header className="model-billing-price-heading">
        <h2><Calculator size={17} aria-hidden="true" />原调用官方核价</h2>
        {check?.sourceUrl && <a href={check.sourceUrl} target="_blank" rel="noopener noreferrer">
          官方价格来源 <ExternalLink size={12} aria-hidden="true" />
        </a>}
      </header>
      {!check ? <p role="status">价格暂未读取 请重新读取原调用依据</p> : (
        <>
          <p className="model-billing-price-meta">
            {check.modelId} · {endpointLabels[check.endpointKind]} · 价格版本 {check.priceVersion}
          </p>
          <p className="model-billing-price-status" role="status">
            {priceStatusLabels[status ?? check.status]}
          </p>
          <ModelTokenUsageLine usage={check.usage} label="本次调用实际 Token" className="model-billing-price-usage" />
          {!!check.components.length && (
            <ol className="model-billing-price-components" aria-label="官方价格核算分项">
              {check.components.map((component, index) => (
                <li key={component.kind + "/" + index} data-kind={component.kind}>
                  <strong>{component.label}</strong>
                  <code>{component.tokenCount.toLocaleString("zh-CN")} token × {"$" + component.usdPerMillion} ÷ 1,000,000 = {"$" + component.amountUsd}</code>
                </li>
              ))}
            </ol>
          )}
          <dl className="model-billing-price-total">
            <div><dt>官方标准 API 核算金额</dt><dd>{calculated ? "$" + check.amountUsd : "暂无法核算总额"}</dd></div>
            {!calculated && check.knownSubtotalUsd !== null && (
              <div><dt>已知小计</dt><dd>{"$" + check.knownSubtotalUsd}</dd></div>
            )}
          </dl>
          {!!check.issues.length && <ul className="model-billing-price-notes" aria-label="官方核价缺项">
            {check.issues.map((issue, index) => <li key={index}>{issue}</li>)}
          </ul>}
          <p className="model-billing-price-boundary">按原调用用量与官方标准 API 价核算 渠道实际费用仍以原账单和凭证核对为准</p>
        </>
      )}
    </section>
  );
}

export function ModelBillingWorkbench({ embedded = false }: { embedded?: boolean }) {
  const router = useRouter(),
    params = useSearchParams();
  const pathname = usePathname();
  const selectionHref = (nextOwner: string, id: string) => {
    if (!embedded) return `/model-billing?owner=${nextOwner}&id=${id}`;
    const query = new URLSearchParams(params.toString());
    query.set("owner", nextOwner); query.set("id", id);
    return `${pathname}?${query}`;
  };
  const owner = ModelBillingOwnerSchema.safeParse(params.get("owner")),
    subject = ModelBillingSubjectIdSchema.safeParse(params.get("id"));
  const selection = owner.success && subject.success ? `${owner.data}/${subject.data}` : "";
  const [scope, setScope] = useState<"unreconciled" | "all">("unreconciled");
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [workspace, setWorkspace] = useState<ModelBillingWorkspace | null>(null),
    [listError, setListError] = useState("");
  const [basis, setBasis] = useState<ModelBillingBasis | null>(null),
    [detailError, setDetailError] = useState("");
  const [draft, setDraft] = useState<Draft>(empty),
    [dirty, setDirty] = useState(false),
    [pendingSelection, setPendingSelection] = useState<string | null>(null);
  const [busy, setBusy] = useState(false),
    [hashing, setHashing] = useState(false),
    [conflict, setConflict] = useState(false),
    [notice, setNotice] = useState("");
  const [listVersion, setListVersion] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null),
    basisState = useRef<ModelBillingBasis | null>(null);
  basisState.current = basis;
  const listEpoch = useRef(0),
    detailEpoch = useRef(0),
    fileEpoch = useRef(0),
    command = useRef<{ payload: string; id: string } | null>(null);
  const draftState = useRef({ dirty, busy });
  draftState.current = { dirty, busy };
  const cursor = cursors.at(-1);

  useEffect(() => {
    const epoch = ++listEpoch.current,
      controller = new AbortController();
    setWorkspace(null);
    setListError("");
    const query = new URLSearchParams({ scope });
    if (cursor) query.set("after", cursor);
    void read(`workspace?${query}`, { signal: controller.signal })
      .then((value) => {
        if (epoch === listEpoch.current) setWorkspace(ModelBillingWorkspaceSchema.parse(value));
      })
      .catch((error) => {
        if (!controller.signal.aborted && epoch === listEpoch.current) setListError(message(error));
      });
    return () => {
      controller.abort();
      ++listEpoch.current;
    };
  }, [scope, cursor, listVersion]);

  const loadBasis = useCallback(
    async (preserve = false) => {
      if (!selection) return;
      const epoch = ++detailEpoch.current;
      setDetailError("");
      try {
        const value = ModelBillingBasisSchema.parse(await read(selection));
        if (epoch !== detailEpoch.current) return;
        setBasis(value);
        setConflict(false);
        if (preserve) setDraft((old) => ({ ...old, matches: false }));
        else {
          setDraft({ ...empty(), providerRequestId: value.providerRequestId ?? "" });
          setDirty(false);
          if (fileInput.current) fileInput.current.value = "";
        }
        command.current = null;
      } catch (error) {
        if (epoch !== detailEpoch.current) return;
        setDetailError(message(error));
        if (denied(error)) {
          setNotice("");
          setPendingSelection(null);
          command.current = null;
          ++listEpoch.current;
          setWorkspace(null);
          setListError(message(error));
          setBasis(null);
          setDraft(empty());
          setDirty(false);
          fileEpoch.current++;
          setHashing(false);
        }
      }
    },
    [selection],
  );

  useEffect(() => {
    ++detailEpoch.current;
    ++fileEpoch.current;
    setBasis(null);
    setDraft(empty());
    setDirty(false);
    setPendingSelection(null);
    setNotice("");
    setConflict(false);
    setDetailError("");
    command.current = null;
    void loadBasis();
    return () => {
      ++detailEpoch.current;
      ++fileEpoch.current;
    };
  }, [loadBasis]);

  useEffect(() => {
    let cancelled = false;
    const inspect = async () => {
      if (draftState.current.busy) return;
      const epoch = detailEpoch.current;
      try {
        const query = new URLSearchParams({ scope });
        if (cursor) query.set("after", cursor);
        const response = await read(selection || `workspace?${query}`);
        if (cancelled || epoch !== detailEpoch.current) return;
        if (!selection) {
          setWorkspace(ModelBillingWorkspaceSchema.parse(response));
          return;
        }
        const value = ModelBillingBasisSchema.parse(response),
          current = basisState.current;
        if (current && current.fingerprint !== value.fingerprint && draftState.current.dirty)
          setConflict(true);
        else setBasis(value);
      } catch (error) {
        if (cancelled || epoch !== detailEpoch.current || !denied(error)) return;
        ++detailEpoch.current;
        ++fileEpoch.current;
        setNotice("");
        setPendingSelection(null);
        command.current = null;
        ++listEpoch.current;
        setWorkspace(null);
        setListError(message(error));
        setHashing(false);
        setBasis(null);
        setDraft(empty());
        setDirty(false);
        setDetailError(message(error));
      }
    };
    const interval = window.setInterval(() => void inspect(), 30_000);
    const focus = () => void inspect();
    window.addEventListener("focus", focus);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", focus);
    };
  }, [selection, scope, cursor]);

  function edit<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setDirty(true);
    setNotice("");
  }
  function choose(path: string) {
    if (path === selection) return;
    if (dirty || busy || hashing) {
      setPendingSelection(path);
      return;
    }
    const [nextOwner, id] = path.split("/");
    router.replace(selectionHref(nextOwner, id), { scroll: false });
  }
  async function hashFile(file: File | undefined) {
    const epoch = ++fileEpoch.current;
    setDraft((current) => ({ ...current, proofChecksum: "", fileName: "", matches: false }));
    setDirty(true);
    setNotice("");
    setHashing(false);
    if (!file) return;
    if (!file.size || file.size > 10 * 1024 * 1024) {
      setDetailError("请选择 10 MiB 以内的非空原凭证文件");
      return;
    }
    setHashing(true);
    setDetailError("");
    try {
      const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      if (epoch !== fileEpoch.current) return;
      const proofChecksum = Array.from(new Uint8Array(hash), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join("");
      setDraft((current) => ({ ...current, proofChecksum, fileName: file.name, matches: false }));
    } catch {
      if (epoch === fileEpoch.current) setDetailError("凭证摘要读取失败 请重新选择文件");
    } finally {
      if (epoch === fileEpoch.current) setHashing(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!basis || !basis.canConfirm || basis.owner === "order_design" || busy || hashing || conflict) return;
    const payload = {
      expectedFingerprint: basis.fingerprint,
      amountUsd: draft.amountUsd,
      currency: "USD",
      evidenceKind: draft.evidenceKind,
      invoiceReference: draft.invoiceReference,
      providerRequestId: draft.providerRequestId,
      proofChecksum: draft.proofChecksum,
      matchesOriginalRequest: draft.matches,
    };
    const key = JSON.stringify(payload);
    if (!command.current || command.current.payload !== key)
      command.current = { payload: key, id: crypto.randomUUID() };
    const parsed = ModelBillingConfirmSchema.safeParse({
      ...payload,
      commandId: command.current.id,
    });
    if (!parsed.success) {
      setDetailError("请填写有效美元金额、账单编号和原请求号 选择凭证并确认匹配");
      return;
    }
    const epoch = detailEpoch.current;
    setBusy(true);
    setDetailError("");
    setNotice("");
    try {
      const value = await read(`${selection}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const receipt = ModelBillingReceiptViewSchema.parse(value.receipt);
      if (epoch !== detailEpoch.current) return;
      setNotice(`已保存第 ${receipt.sequence} 次人工核对 $${receipt.amountUsd}`);
      setDirty(false);
      setDraft(empty());
      command.current = null;
      setListVersion((value) => value + 1);
      await loadBasis();
    } catch (error) {
      if (epoch !== detailEpoch.current) return;
      setDetailError(message(error));
      if (error instanceof BillingFailure && error.status === 409) {
        setConflict(true);
        setDraft((current) => ({ ...current, matches: false }));
      }
      if (denied(error)) {
        setNotice("");
        setPendingSelection(null);
        command.current = null;
        ++listEpoch.current;
        setWorkspace(null);
        setListError(message(error));
        setBasis(null);
        setDraft(empty());
        setDirty(false);
      }
    } finally {
      setBusy(false);
    }
  }

  const Container = embedded ? "section" : "main";
  return (
    <Container className={`oc-page model-billing-page${embedded ? " model-billing-page--embedded" : ""}`}>
      {!embedded && <header className="oc-page-header">
        <div>
          <p className="oc-eyebrow">AI 执行</p>
          <h1>模型费用核对</h1>
          <p>按原调用实际用量核算官方 API 价格 保留渠道凭证和每次人工核对记录</p>
        </div>
        <Link href="/ai-tasks">
          <ArrowLeft size={15} />
          返回 AI 任务
        </Link>
      </header>}
      <p className="model-billing-note">
        此处记录人工确认的美元费用 凭证文件只在当前浏览器计算摘要 原文件请自行保管
      </p>
      <OfficialPriceCatalogPanel catalog={workspace?.officialPriceCatalog} loading={!workspace && !listError} />
      <div className="model-billing-layout">
        <section aria-label="费用记录列表" className="model-billing-list">
          <div className="model-billing-toolbar">
            <label>
              记录范围
              <select
                value={scope}
                onChange={(event) => {
                  setScope(event.target.value as typeof scope);
                  setCursors([undefined]);
                }}
              >
                <option value="unreconciled">待核对</option>
                <option value="all">全部记录</option>
              </select>
            </label>
            <button type="button" onClick={() => setListVersion((value) => value + 1)}>
              <RefreshCw size={14} />
              刷新列表
            </button>
          </div>
          {listError ? (
            <p role="alert">{listError}</p>
          ) : !workspace ? (
            <p role="status">正在读取费用记录…</p>
          ) : !workspace.items.length ? (
            <p>当前范围没有可核对记录</p>
          ) : (
            <ul>
              {workspace.items.map((item) => (
                <li key={`${item.owner}/${item.id}`}>
                  <button
                    type="button"
                    aria-pressed={selection === `${item.owner}/${item.id}`}
                    onClick={() => choose(`${item.owner}/${item.id}`)}
                  >
                    <strong>{item.modelLabel}</strong>
                    <span>
                      {ownerLabels[item.owner]} ·{" "}
                      {item.owner === "order_design" ? "只读用量" : item.reconciled ? "已有人工核对" : "待核对"}
                    </span>
                    <small>{item.id}</small>
                    <time dateTime={item.createdAt}>
                      {new Date(item.createdAt).toLocaleString("zh-CN")}
                    </time>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="model-billing-toolbar">
            <button
              type="button"
              disabled={cursors.length < 2 || !workspace}
              onClick={() => setCursors((value) => value.slice(0, -1))}
            >
              上一页
            </button>
            <button
              type="button"
              disabled={!workspace?.nextCursor}
              onClick={() => setCursors((value) => [...value, workspace!.nextCursor!])}
            >
              下一页
            </button>
          </div>
        </section>
        <section aria-label="费用核对详情" className="model-billing-detail">
          {pendingSelection && (
            <div role="status" className="model-billing-note">
              <p>当前内容尚未保存</p>
              <button
                type="button"
                disabled={busy || hashing}
                onClick={() => {
                  const path = pendingSelection;
                  setPendingSelection(null);
                  setDirty(false);
                  const [nextOwner, id] = path.split("/");
                  router.replace(selectionHref(nextOwner, id), { scroll: false });
                }}
              >
                放弃未保存内容并切换
              </button>
              <button type="button" onClick={() => setPendingSelection(null)}>
                继续编辑
              </button>
            </div>
          )}
          {notice && <p role="status">{notice}</p>}
          {detailError && <p role="alert">{detailError}</p>}
          {!selection ? (
            <p>选择一条原调用记录开始核对</p>
          ) : !basis ? (
            !detailError && <p role="status">正在读取原调用依据…</p>
          ) : (
            <>
              <header>
                <h2>{basis.modelLabel}</h2>
                <p>
                  {ownerLabels[basis.owner]} · {basis.subjectId}
                </p>
              </header>
              {basis.originalInvocation && (
                <InvocationEvidence entries={[basis.originalInvocation]} />
              )}
              <OfficialPriceCheckPanel check={basis.officialPriceCheck} />
              {!!basis.blockers.length && (
                <ul>
                  {basis.blockers.map((value) => (
                    <li key={value}>{value}</li>
                  ))}
                </ul>
              )}
              {conflict && (
                <div className="model-billing-note">
                  <p>依据已变化 已保留填写内容 请重新读取并逐项核对</p>
                  <button type="button" disabled={busy} onClick={() => void loadBasis(true)}>
                    <RefreshCw size={14} />
                    重新读取核对依据
                  </button>
                </div>
              )}
              {basis.owner === "order_design" ? (
                <p className="model-billing-note" role="note">
                  订单无人设计调用提供原始用量与官方核价的只读查询 当前不提供渠道账单确认
                </p>
              ) : <form onSubmit={submit} aria-label="人工费用核对">
                <fieldset disabled={!basis.canConfirm || busy}>
                  <legend>人工核对</legend>
                  <label>
                    确认费用 USD
                    <input
                      inputMode="decimal"
                      autoComplete="off"
                      value={draft.amountUsd}
                      onChange={(event) => edit("amountUsd", event.target.value)}
                      placeholder="0.00000000"
                      maxLength={17}
                    />
                  </label>
                  <label>
                    凭证类型
                    <select
                      value={draft.evidenceKind}
                      onChange={(event) =>
                        edit("evidenceKind", event.target.value as Draft["evidenceKind"])
                      }
                    >
                      {Object.entries(kinds).map(([key, label]) => (
                        <option value={key} key={key}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    账单或凭证编号
                    <input
                      value={draft.invoiceReference}
                      onChange={(event) => edit("invoiceReference", event.target.value)}
                      maxLength={200}
                      autoComplete="off"
                    />
                  </label>
                  <label>
                    渠道原请求号
                    <input
                      value={draft.providerRequestId}
                      onChange={(event) => edit("providerRequestId", event.target.value)}
                      readOnly={basis.providerRequestId !== null}
                      maxLength={512}
                      autoComplete="off"
                    />
                  </label>
                  <label>
                    原凭证文件
                    <input
                      type="file"
                      ref={fileInput}
                      onChange={(event) => void hashFile(event.target.files?.[0])}
                    />
                  </label>
                  {hashing && <p role="status">正在本地计算凭证摘要…</p>}
                  {draft.proofChecksum && (
                    <p className="model-billing-checksum">
                      {draft.fileName}
                      <br />
                      SHA-256 {draft.proofChecksum}
                    </p>
                  )}
                  <label className="model-billing-check">
                    <input
                      type="checkbox"
                      checked={draft.matches}
                      onChange={(event) => edit("matches", event.target.checked)}
                    />
                    我已核对凭证所属渠道、原请求、美元金额及分摊 未重复计入其他调用
                  </label>
                  <p className="model-billing-note">
                    保存会记录人工确认并纠正原 AI 预算 本次核对不会触发付款或重试模型
                  </p>
                  <button
                    type="submit"
                    disabled={hashing || conflict || !draft.matches || !draft.proofChecksum}
                  >
                    <Check size={15} />
                    {busy ? "正在保存…" : "保存人工核对"}
                  </button>
                </fieldset>
              </form>}
              <section aria-label="人工核对历史">
                <h2>
                  <FileCheck2 size={17} />
                  人工核对历史
                </h2>
                {!basis.history.length ? (
                  <p>尚无人工核对记录</p>
                ) : (
                  <ol>
                    {basis.history.map((item) => (
                      <li key={item.id}>
                        <strong>
                          第 {item.sequence} 次 · ${item.amountUsd}
                        </strong>
                        <span>
                          {kinds[item.evidenceKind]} · {item.invoiceReference}
                        </span>
                        <span>原请求 {item.providerRequestId}</span>
                        <span>
                          核对人 {item.checkedBy} ·{" "}
                          {new Date(item.checkedAt).toLocaleString("zh-CN")}
                        </span>
                        <small>凭证 SHA-256 {item.proofChecksum}</small>
                        {item.budgetImpact && (
                          <span>
                            原预算 {item.budgetImpact.beforeAmountUsd ?? "未计价"} → $
                            {item.budgetImpact.afterAmountUsd} · 预算归属 UTC{" "}
                            {new Date(item.budgetImpact.periodStartedAt).toISOString().slice(0, 7)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
                {basis.hasMoreHistory && <p>此处显示最近 20 次核对 更早记录保留在审计账目</p>}
              </section>
            </>
          )}
        </section>
      </div>
    </Container>
  );
}
