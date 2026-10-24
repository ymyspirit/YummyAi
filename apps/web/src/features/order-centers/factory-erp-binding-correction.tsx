"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { z } from "zod";
import { Check, Link2Off, RefreshCw, Search, X } from "lucide-react";
import { createEntityId, EntityIdSchema } from "@yummyai/contracts/common/ids";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import {
  ChangeFactoryErpBindingSchema, FactoryErpBindingViewSchema, FactoryErpBindingPageSchema,
  FactoryErpBindingChangePageSchema, FactoryErpBindingChangeResultSchema,
  type ChangeFactoryErpBinding, type FactoryErpBindingView, type FactoryErpBindingSource,
  type FactoryErpBindingChangeResult, type FactoryErpBindingReason,
} from "@yummyai/contracts/order/factory-erp-binding";
import type { FactoryErpCandidatePage, FactoryErpItemSelection } from "@yummyai/contracts/order/factory-erp-import";
import { FactoryErpItemPins } from "./factory-erp-import-form";
import { FactoryErpVoidCounts } from "./factory-erp-void-review-form";

export type FactoryErpBindingRead = <S extends z.ZodType>(path: string, schema: S, signal: AbortSignal) => Promise<z.output<S>>;
export type FactoryErpBindingIntent = { bindingId: string; input: ChangeFactoryErpBinding; sent: boolean };
type Candidate = FactoryErpCandidatePage["items"][number];
const reasons: Record<FactoryErpBindingReason, string> = {
  wrong_group: "原生产组绑定错误", factory_number_reused: "工厂编号被再次使用",
  duplicate_binding: "重复绑定需要更正", operator_confirmed_change: "运营核对确认变更",
};
const failedStatus = (error: unknown) => error && typeof error === "object" && "status" in error ? error.status : null;
const pins = (items: FactoryErpItemSelection[]) => items.map(({ deliveryItemId, productionOrderId, productionVersionId, fileChecksum, manufacturingChecksum }) =>
  ({ deliveryItemId, productionOrderId, productionVersionId, fileChecksum, manufacturingChecksum }));
const groupIdentity = (items: FactoryErpItemSelection[]) => canonicalJson(pins(items).sort((left, right) => left.deliveryItemId.localeCompare(right.deliveryItemId)));

export function FactoryErpBindingSummary({ value }: { value: FactoryErpBindingView }) {
  return <section className="fei-binding-detail" aria-label="原工厂绑定完整依据">
    <h4>原工厂绑定完整依据</h4>
    <dl className="fei-pairs">
      <div><dt>原绑定 ID</dt><dd><code>{value.id}</code></dd></div>
      <div><dt>原关联修订</dt><dd>{value.revision} · {value.state === "active" ? "当前活动关联" : "已解除 历史保留"}</dd></div>
      <div><dt>完整原组校验值</dt><dd><code>{value.itemsChecksum}</code></dd></div>
      <div><dt>最后原观察序号</dt><dd>{value.observationSequence}</dd></div>
      <div><dt>原组生产计数</dt><dd>{value.quantity}</dd></div>
      <div><dt>原来源导入 ID</dt><dd><code>{value.sourceImportId}</code></dd></div>
      <div><dt>原工厂状态记录</dt><dd>{value.recordedStatus === "shipped" ? "工厂已发货" : value.recordedStatus === "scheduled" ? "已排产" : "尚无成功状态"}{value.recordedException && " · 保留原表作废观察"}</dd></div>
      <div><dt>原关联登记时间</dt><dd>{value.createdAt}</dd></div>
      <div><dt>前一修订绑定</dt><dd>{value.previousBindingId ? <code>{value.previousBindingId}</code> : "初始修订"}</dd></div>
      <div><dt>后一修订绑定</dt><dd>{value.nextBindingId ? <code>{value.nextBindingId}</code> : "尚无后继"}</dd></div>
      <div><dt>解除凭据</dt><dd>{value.releasedBy ? <code>{value.releasedBy}</code> : "尚未解除"}</dd></div>
    </dl>
    {value.voidSummary ? <FactoryErpVoidCounts value={value.voidSummary} /> : value.recordedException && <p className="fei-hint">尚未读取完整作废核对计数 不推断已解决或只核对最新一条</p>}
    <details className="fei-details"><summary>核对原绑定完整 {value.items.length} 个交付项与数量</summary>
      <p>这是该修订保存的完整原组 不以今天的生产版本替换</p>
      <ol className="fei-pins">{value.items.map(item => <li key={item.deliveryItemId}><p>该原交付项生产计数 {item.quantity}</p><FactoryErpItemPins items={[item]} /></li>)}</ol>
    </details>
  </section>;
}

export function FactoryErpBindingChangeSummary({ value }: { value: FactoryErpBindingIntent }) {
  const input = value.input;
  return <section className="fei-review" aria-label="固定原绑定变更请求">
    <h4>{input.action === "release" ? "核对仅解除原组关联" : "核对解除原组并应用本行到新组"}</h4>
    <p>原因 {reasons[input.reasonCode]} · 只改变工厂表格关联 不取消生产 不更改质检 产能 物料 库存或物流事实</p>
    <dl className="fei-pairs">
      <div><dt>原绑定 ID</dt><dd><code>{value.bindingId}</code></dd></div>
      <div><dt>固定原修订</dt><dd>{input.expectedRevision}</dd></div>
      <div><dt>固定完整原组校验值</dt><dd><code>{input.expectedItemsChecksum}</code></dd></div>
      <div><dt>固定最后观察序号</dt><dd>{input.expectedObservationSequence}</dd></div>
      <div><dt>本次有效来源导入</dt><dd><code>{input.source.importId}</code></dd></div>
      <div><dt>本次原表行号</dt><dd>{input.source.rowNumber}</dd></div>
      <div><dt>来源原字节校验值</dt><dd><code>{input.source.fileChecksum}</code></dd></div>
      <div><dt>来源固定预览校验值</dt><dd><code>{input.source.previewChecksum}</code></dd></div>
      <div><dt>本次固定原请求编号</dt><dd><code>{input.idempotencyKey}</code></dd></div>
    </dl>
    {input.action === "correct" ? <><p>一次确认登记旧关联解除 新修订和本行新应用 新组只采用这次明确的原行 旧已发货记录不会搬到新组</p><FactoryErpItemPins items={input.items} /></> :
      <p>本次仅解除完整旧组 不创建新绑定或新状态观察 后续重新绑定须另行明确确认解除凭据</p>}
    <p className="fei-hint">{value.sent ? "原请求已发出 响应未知时只按固定原正文和编号恢复 不自动重基或更换编号" : "原请求尚未执行 请核对后再明确确认"}</p>
  </section>;
}

export function FactoryErpBindingChangeReceipt({ value }: { value: FactoryErpBindingChangeResult }) {
  return <section className="fei-receipt" aria-label="原工厂绑定变更回执">
    <h4 tabIndex={-1}>{value.action === "release" ? "原组关联解除已登记" : "原组解除与本行新组应用已登记"}</h4>
    <p>这是该次变更保存的原回执 不代表今天的当前关联或承运揽收</p>
    <dl className="fei-pairs">
      <div><dt>实际变更 ID</dt><dd><code>{value.id}</code></dd></div>
      <div><dt>原绑定 ID</dt><dd><code>{value.bindingId}</code></dd></div>
      <div><dt>原修订与最后观察</dt><dd>{value.originalRevision} · 原序号 {value.originalObservationSequence}</dd></div>
      <div><dt>完整原组校验值</dt><dd><code>{value.originalItemsChecksum}</code></dd></div>
      <div><dt>变更原因</dt><dd>{reasons[value.reasonCode]}</dd></div>
      <div><dt>变更登记时间</dt><dd>{value.createdAt}</dd></div>
      <div><dt>固定原请求校验值</dt><dd><code>{value.requestChecksum}</code></dd></div>
      <div><dt>有效来源导入与行号</dt><dd><code>{value.source.importId}</code> · 第 {value.source.rowNumber} 行</dd></div>
      <div><dt>来源原字节校验值</dt><dd><code>{value.source.fileChecksum}</code></dd></div>
      <div><dt>来源预览校验值</dt><dd><code>{value.source.previewChecksum}</code></dd></div>
      <div><dt>新修订绑定</dt><dd>{value.replacementBindingId ? <><code>{value.replacementBindingId}</code> · 修订 {value.replacementRevision}</> : "仅解除 未建立新关联"}</dd></div>
      <div><dt>本行实际新应用</dt><dd>{value.application ? <code>{value.application.id}</code> : "仅解除 未新增状态观察"}</dd></div>
    </dl>
    {value.application && <><p>本次新应用只处理原表第 {value.source.rowNumber} 行 不把旧组状态传播到新组</p>
      {value.application.observations.map(item => <p key={item.observationId}>实际新观察 <code>{item.observationId}</code> · {item.status === "shipped" ? "工厂已发货" : item.status === "scheduled" ? "已排产" : "异常待核对"}</p>)}</>}
  </section>;
}

export function FactoryErpBindingCorrection({ scope, bindingId, source, itemQuantity, disabled, request, loadCandidates, onPrepare, onCancel, onDenied }: {
  scope: string; bindingId: string; source: FactoryErpBindingSource; itemQuantity: number | null; disabled: boolean;
  request: FactoryErpBindingRead;
  loadCandidates(query: { q: string; cursor?: string }, signal: AbortSignal): Promise<FactoryErpCandidatePage>;
  onPrepare(value: FactoryErpBindingIntent): void; onCancel(): void; onDenied(error: unknown): void;
}) {
  const [binding, setBinding] = useState<FactoryErpBindingView | null>(null), [reading, setReading] = useState(false), [reload, setReload] = useState(0);
  const [action, setAction] = useState<"release" | "correct">("release"), [reason, setReason] = useState<FactoryErpBindingReason | "">("");
  const [confirmed, setConfirmed] = useState(false), [error, setError] = useState("");
  const [query, setQuery] = useState(""), [trail, setTrail] = useState<Array<string | undefined>>([undefined]);
  const [page, setPage] = useState<FactoryErpCandidatePage | null>(null), [selected, setSelected] = useState<Record<string, Candidate>>({});
  const [candidateReading, setCandidateReading] = useState(false), [candidateError, setCandidateError] = useState("");
  const live = useRef({ scope, bindingId, disabled }); live.current = { scope, bindingId, disabled };
  const generation = useRef(0), candidateGeneration = useRef(0);
  useEffect(() => {
    const abort = new AbortController(), token = ++generation.current;
    const valid = () => !abort.signal.aborted && live.current.scope === scope && live.current.bindingId === bindingId && generation.current === token;
    setReading(true); setBinding(null); setError(""); setConfirmed(false); setSelected({});
    void request("bindings/" + bindingId, FactoryErpBindingViewSchema, abort.signal).then(value => {
      if (!valid()) return;
      if (value.id !== bindingId) throw new Error("parent");
      setBinding(value);
    }).catch(failure => { if (valid()) { setError("原绑定完整依据读取未完成 不猜测修订或观察序号 请重新读取"); onDenied(failure); } })
      .finally(() => { if (valid()) setReading(false); });
    return () => abort.abort();
  }, [scope, bindingId, request, onDenied, reload]);
  useEffect(() => {
    if (action !== "correct" || !binding || binding.state !== "active") return;
    const abort = new AbortController(), token = ++candidateGeneration.current;
    const valid = () => !abort.signal.aborted && live.current.scope === scope && live.current.bindingId === bindingId && candidateGeneration.current === token;
    setCandidateReading(true); setCandidateError(""); setPage(null);
    const cursor = trail.at(-1);
    void loadCandidates({ q: query, ...(cursor ? { cursor } : {}) }, abort.signal).then(value => { if (valid()) setPage(value); })
      .catch(failure => { if (valid()) { setCandidateError("候选读取未完成 已选完整组未自动替换 请重新查询"); onDenied(failure); } })
      .finally(() => { if (valid()) setCandidateReading(false); });
    return () => abort.abort();
  }, [scope, bindingId, action, binding, query, trail, loadCandidates, onDenied]);
  const chosen = Object.values(selected), quantity = chosen.reduce((sum, item) => sum + item.quantity, 0);
  const sameGroup = binding !== null && chosen.length > 0 && groupIdentity(chosen) === groupIdentity(binding.items);
  const newGroupReady = chosen.length > 0 && chosen.length <= 50 && itemQuantity !== null && quantity === itemQuantity && !sameGroup;
  const ready = !!binding && binding.state === "active" && !reading && !!reason && confirmed && (action === "release" || newGroupReady);
  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!ready || disabled || !binding || live.current.scope !== scope) return;
    const base = { expectedRevision: binding.revision, expectedItemsChecksum: binding.itemsChecksum,
      expectedObservationSequence: binding.observationSequence, source, reasonCode: reason, idempotencyKey: createEntityId(), confirmed: true };
    const input = ChangeFactoryErpBindingSchema.safeParse(action === "correct" ? { ...base, action, items: pins(chosen), wholeGroupConfirmed: true } : { ...base, action });
    if (!input.success) { setError("完整原组 来源或确认依据无法核对 未截断提交"); return; }
    onPrepare({ bindingId, input: input.data, sent: false });
  }
  return <section className="fei-correction" aria-label="解除或更正原工厂绑定">
    <h4><Link2Off size={15} aria-hidden="true" />解除或更正原工厂绑定</h4>
    <p>先读取完整原组依据 再明确选择解除或更正 原行私人列值不复制到变更请求与回执</p>
    <p>本次有效来源 <code>{source.importId}</code> · 原表第 {source.rowNumber} 行 · 原商品总数 {itemQuantity ?? "未知"}</p>
    <button className="oc-button" type="button" disabled={disabled || reading} onClick={() => setReload(value => value + 1)}><RefreshCw size={14} aria-hidden="true" />重新读取原绑定完整依据</button>
    {reading && <p role="status">正在读取原绑定修订 完整组与最后观察序号</p>}
    {error && <p role="alert" className="oc-delivery-error">{error}</p>}
    {binding && <><FactoryErpBindingSummary value={binding} />
      {binding.state !== "active" && <p role="alert">原关联已解除 只能读取历史 请重新读取当前原表后核对最新关联</p>}
      <form className="fei-form" aria-label="选择原工厂绑定变更" onSubmit={prepare}>
        <fieldset disabled={disabled || reading || binding.state !== "active"}>
          <label>绑定变更方式<select value={action} onChange={event => { setAction(event.target.value as "release" | "correct"); setConfirmed(false); setSelected({}); setPage(null); }}>
            <option value="release">仅解除完整旧组关联</option><option value="correct">解除旧组并应用本行到新组</option>
          </select></label>
          <label>绑定变更原因<select value={reason} required onChange={event => { setReason(event.target.value as FactoryErpBindingReason | ""); setConfirmed(false); }}>
            <option value="">明确选择核对原因</option>{Object.entries(reasons).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select></label>
        </fieldset>
      </form>
      <div className="fei-correction-selection" data-open={action === "correct"} inert={action !== "correct"} aria-hidden={action !== "correct"}>
        <div>
          <p>允许保留当前旧组中的部分成员 其他活动关联的成员不可选 完全相同组不能作为更正</p>
          <form className="fei-search" aria-label="查询更正新组原生产候选" onSubmit={event => {
            event.preventDefault(); setQuery(String(new FormData(event.currentTarget).get("q") ?? "").trim()); setTrail([undefined]);
          }}><label>查询更正新组原生产文件<input name="q" maxLength={200} disabled={disabled || binding.state !== "active"} /></label>
            <button className="oc-button" type="submit" disabled={disabled || candidateReading || binding.state !== "active"}><Search size={14} aria-hidden="true" />查询更正原生产候选</button></form>
          {candidateReading && <p role="status">正在读取可核对的新组候选</p>}
          {candidateError && <p role="alert" className="oc-delivery-error">{candidateError}</p>}
          {page && <><div className="fei-actions"><button className="oc-button" type="button" disabled={disabled || candidateReading || trail.length < 2} onClick={() => setTrail(value => value.slice(0, -1))}>上一页更正候选</button>
            <button className="oc-button" type="button" disabled={disabled || candidateReading || !page.nextCursor} onClick={() => setTrail(value => [...value, page.nextCursor!])}>下一页更正候选</button></div>
            <p>本扫描页 {page.items.length} 个候选{page.nextCursor ? " 可继续下一页" : " 当前查询已到末页"} 已选成员跨页保留</p>
            <ul className="fei-candidates">{page.items.map(item => <li key={item.deliveryItemId}><label className="fei-check">
              <input type="checkbox" aria-label={"选择更正原交付项 " + item.deliveryItemId} checked={!!selected[item.deliveryItemId]}
                disabled={disabled || binding.state !== "active" || item.bindingId !== null && item.bindingId !== bindingId} onChange={event => {
                  setConfirmed(false); setSelected(previous => { const next = { ...previous }; if (event.target.checked) next[item.deliveryItemId] = item; else delete next[item.deliveryItemId]; return next; });
                }} /><span>{item.orderNumber} · 原生产计数 {item.quantity}<br />原交付项 <code>{item.deliveryItemId}</code>
                {item.bindingId && <span className="fei-hint">{item.bindingId === bindingId ? " 当前旧组成员 可明确保留" : " 已被其他活动组绑定 不可选择"} <code>{item.bindingId}</code></span>}</span>
            </label><details className="fei-details"><summary>核对更正候选完整来源</summary><FactoryErpItemPins items={[item]} /><p>真实提交 {item.submittedAt} · 凭据 <code>{item.submittedFeedbackId}</code></p></details></li>)}</ul></>}
          <h4>更正新组已选 {chosen.length} 个交付项</h4><p>已选原生产计数 {quantity} · 当前原表商品总数 {itemQuantity ?? "未知 不允许猜测"}</p>
          {sameGroup && <p role="alert" className="oc-delivery-error">新旧完整组完全相同 不能作为更正 请核对真正需要替换的原生产组</p>}
          {chosen.length > 0 && <><FactoryErpItemPins items={chosen} /><div className="fei-actions">{chosen.map(item => <button className="oc-button" type="button" disabled={disabled} key={item.deliveryItemId}
            onClick={() => { setConfirmed(false); setSelected(previous => { const next = { ...previous }; delete next[item.deliveryItemId]; return next; }); }}>移出新组 {item.deliveryItemId.slice(-8)}</button>)}</div></>}
        </div>
      </div>
      <form className="fei-form" aria-label="确认原工厂绑定变更依据" onSubmit={prepare}>
        <fieldset disabled={disabled || reading || binding.state !== "active"}>
          <label className="fei-check fei-wide"><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
            我已核对完整原组 修订及最后观察序号{action === "correct" ? " 并确认本行完整新组及原数量 不传播旧工厂状态" : " 确认仅解除旧关联 不取消或转移原业务事实"}</label>
          <div className="fei-actions fei-wide"><button className="oc-button primary" type="submit" disabled={disabled || !ready}><Check size={14} aria-hidden="true" />固定原请求并核对变更</button></div>
        </fieldset>
      </form>
    </>}
    <button className="oc-button" type="button" onClick={onCancel}><X size={14} aria-hidden="true" />关闭未提交的绑定变更</button>
  </section>;
}

export function FactoryErpBindingHistory({ scope, factoryId, disabled, request, onDenied, onReviewVoids }: {
  scope: string; factoryId: string; disabled: boolean; request: FactoryErpBindingRead; onDenied(error: unknown): void; onReviewVoids?(bindingId: string): void;
}) {
  const [open, setOpen] = useState(false), [page, setPage] = useState<z.infer<typeof FactoryErpBindingPageSchema> | null>(null);
  const [trail, setTrail] = useState<Array<string | undefined>>([undefined]), [reading, setReading] = useState(false), [error, setError] = useState("");
  const [draft, setDraft] = useState(""), [binding, setBinding] = useState<FactoryErpBindingView | null>(null), [bindingReading, setBindingReading] = useState(false);
  const [changes, setChanges] = useState<z.infer<typeof FactoryErpBindingChangePageSchema> | null>(null), [changeTrail, setChangeTrail] = useState<Array<string | undefined>>([undefined]);
  const [changesReading, setChangesReading] = useState(false), [changeDraft, setChangeDraft] = useState(""), [receipt, setReceipt] = useState<FactoryErpBindingChangeResult | null>(null), [receiptReading, setReceiptReading] = useState(false);
  const live = useRef({ scope, factoryId, open }); live.current = { scope, factoryId, open };
  const reads = useRef({ list: 0, detail: 0, changes: 0, receipt: 0, controllers: new Set<AbortController>() });
  const known = useRef(new Set<string>());
  const cancel = useCallback(() => { const current = reads.current; current.list++; current.detail++; current.changes++; current.receipt++; current.controllers.forEach(value => value.abort()); current.controllers.clear(); }, []);
  useEffect(() => () => cancel(), [cancel]);
  const failed = useCallback((failure: unknown, previouslyKnown: boolean) => {
    if (failedStatus(failure) !== 404 || previouslyKnown) onDenied(failure);
    setError("绑定或变更历史读取未完成 请核对原 ID 后重新读取 未以当前列表补填");
  }, [onDenied]);
  const begin = (lane: "list" | "detail" | "changes" | "receipt") => {
    const current = reads.current, token = ++current[lane], abort = new AbortController(); current.controllers.add(abort);
    return { abort, valid: () => !abort.signal.aborted && live.current.scope === scope && live.current.factoryId === factoryId && live.current.open && current[lane] === token,
      done: () => current.controllers.delete(abort) };
  };
  async function readList(cursor?: string, nextTrail: Array<string | undefined> = [undefined]) {
    const ticket = begin("list"); setReading(true); setError("");
    try {
      const result = await request("bindings?" + new URLSearchParams({ factoryId, limit: "20", ...(cursor ? { cursor } : {}) }), FactoryErpBindingPageSchema, ticket.abort.signal);
      if (!ticket.valid()) return;
      if (result.items.some(item => item.factoryId !== factoryId)) throw new Error("parent");
      result.items.forEach(item => known.current.add(item.id)); setPage(result); setTrail(nextTrail);
    } catch (failure) { if (ticket.valid()) failed(failure, page !== null); }
    finally { ticket.done(); if (ticket.valid()) setReading(false); }
  }
  async function readBinding(rawId: string) {
    const id = EntityIdSchema.safeParse(rawId.trim()); if (!id.success) { setError("请填写完整有效的原绑定 ID"); return; }
    const bindingId = id.data.toLowerCase(), ticket = begin("detail");
    reads.current.changes++; reads.current.receipt++; setBindingReading(true); setBinding(null); setChanges(null); setReceipt(null); setChangesReading(false); setReceiptReading(false); setChangeDraft(""); setError("");
    try {
      const result = await request("bindings/" + bindingId, FactoryErpBindingViewSchema, ticket.abort.signal);
      if (!ticket.valid()) return;
      if (result.id !== bindingId || result.factoryId !== factoryId) throw new Error("parent");
      known.current.add(bindingId); setBinding(result); setDraft(bindingId); setChangeTrail([undefined]);
    } catch (failure) { if (ticket.valid()) failed(failure, known.current.has(bindingId)); }
    finally { ticket.done(); if (ticket.valid()) setBindingReading(false); }
  }
  const bindingRef = useRef(binding); bindingRef.current = binding;
  const readChanges = useCallback(async (bindingId: string, cursor?: string, nextTrail: Array<string | undefined> = [undefined]) => {
    const current = reads.current, token = ++current.changes, abort = new AbortController(); current.controllers.add(abort);
    const valid = () => !abort.signal.aborted && live.current.scope === scope && live.current.open && live.current.factoryId === factoryId && current.changes === token && bindingRef.current?.id === bindingId;
    setChangesReading(true); setError("");
    try {
      const result = await request("bindings/" + bindingId + "/changes?" + new URLSearchParams({ limit: "20", ...(cursor ? { cursor } : {}) }), FactoryErpBindingChangePageSchema, abort.signal);
      if (!valid()) return;
      if (result.items.some(item => item.bindingId !== bindingId || item.factoryId !== factoryId)) throw new Error("parent");
      result.items.forEach(item => known.current.add(item.id)); setChanges(result); setChangeTrail(nextTrail);
    } catch (failure) { if (valid()) failed(failure, true); }
    finally { current.controllers.delete(abort); if (valid()) setChangesReading(false); }
  }, [scope, factoryId, request, failed]);
  useEffect(() => { if (open && binding) void readChanges(binding.id); }, [open, binding, readChanges]);
  async function readReceipt(rawId: string) {
    const id = EntityIdSchema.safeParse(rawId.trim()); if (!id.success || !binding) { setError("请先读取原绑定 再填写有效的原变更 ID"); return; }
    const parent = binding.id, changeId = id.data.toLowerCase(), ticket = begin("receipt"); setReceiptReading(true); setReceipt(null); setError("");
    try {
      const result = await request("bindings/" + parent + "/changes/" + changeId, FactoryErpBindingChangeResultSchema, ticket.abort.signal);
      if (!ticket.valid() || bindingRef.current?.id !== parent) return;
      if (result.id !== changeId || result.bindingId !== parent || result.factoryId !== factoryId) throw new Error("parent");
      known.current.add(changeId); setReceipt(result); setChangeDraft(changeId);
    } catch (failure) { if (ticket.valid()) failed(failure, known.current.has(changeId)); }
    finally { ticket.done(); if (ticket.valid()) setReceiptReading(false); }
  }
  return <details className="fei-details fei-binding-history" onToggle={event => {
    if (event.target !== event.currentTarget) return;
    const expanded = event.currentTarget.open; setOpen(expanded);
    if (expanded) { live.current.open = true; void readList(); }
    else { live.current.open = false; cancel(); setPage(null); setBinding(null); setChanges(null); setReceipt(null); setReading(false); setBindingReading(false); setChangesReading(false); setReceiptReading(false); setError(""); }
  }}><summary>读取本工厂完整绑定与变更历史</summary>
    {open && <section aria-label="工厂完整绑定修订历史">
      <p>完整修订按登记 ID 降序分页 原关联解除后仍保留全部历史 只读取编号 校验值与原回执 不读取原表私人列值</p>
      <div className="fei-actions"><button className="oc-button" type="button" disabled={disabled || reading} onClick={() => void readList()}>重新读取绑定历史</button>
        <button className="oc-button" type="button" disabled={disabled || reading || trail.length < 2} onClick={() => { const next = trail.slice(0, -1); void readList(next.at(-1), next); }}>上一页绑定修订</button>
        <button className="oc-button" type="button" disabled={disabled || reading || !page?.nextCursor} onClick={() => void readList(page!.nextCursor!, [...trail, page!.nextCursor!])}>下一页绑定修订</button></div>
      {reading && <p role="status">正在读取完整绑定修订页</p>}
      {error && <p role="alert" className="oc-delivery-error">{error}</p>}
      {page && <><p>本页 {page.items.length} 个关联修订{page.nextCursor ? " 还有下一页" : " 本次查询已到末页"}</p><ul className="fei-history">{page.items.map(item => <li key={item.id}>
        <p>修订 {item.revision} · {item.state === "active" ? "活动关联" : "已解除"} · 原计数 {item.quantity}</p><p>原绑定 <code>{item.id}</code> · 登记时间 {item.createdAt}</p>
        <button className="oc-button" type="button" disabled={disabled || bindingReading} onClick={() => void readBinding(item.id)}>读取绑定完整依据 {item.id.slice(-8)}</button>
        {onReviewVoids && <button className="oc-button" type="button" disabled={disabled} onClick={() => onReviewVoids(item.id)}>读取该绑定作废核对 {item.id.slice(-8)}</button>}</li>)}</ul>
        {!page.items.length && <p>当前工厂尚无已登记绑定修订</p>}</>}
      <form className="fei-search" aria-label="按原绑定 ID 读取完整依据" onSubmit={event => { event.preventDefault(); void readBinding(draft); }}>
        <label>原绑定 ID<input value={draft} disabled={disabled || bindingReading} autoComplete="off" onChange={event => setDraft(event.target.value)} /></label>
        <button className="oc-button" type="submit" disabled={disabled || bindingReading || !draft}><Search size={14} aria-hidden="true" />按绑定 ID 读取</button></form>
      {bindingReading && <p role="status">正在读取完整原绑定</p>}
      {binding && <><FactoryErpBindingSummary value={binding} /><div className="fei-actions">
        {onReviewVoids && <button className="oc-button" type="button" disabled={disabled} onClick={() => onReviewVoids(binding.id)}>读取这条绑定的完整作废核对</button>}
        {binding.previousBindingId && <button className="oc-button" type="button" disabled={disabled || bindingReading} onClick={() => void readBinding(binding.previousBindingId!)}>读取前一关联修订</button>}
        {binding.nextBindingId && <button className="oc-button" type="button" disabled={disabled || bindingReading} onClick={() => void readBinding(binding.nextBindingId!)}>读取后一关联修订</button>}</div>
        <section className="fei-change-history" aria-label="原绑定变更历史"><h4>原绑定变更历史</h4>
          <div className="fei-actions"><button className="oc-button" type="button" disabled={disabled || changesReading} onClick={() => void readChanges(binding.id)}>重新读取原绑定变更历史</button>
            <button className="oc-button" type="button" disabled={disabled || changesReading || changeTrail.length < 2} onClick={() => { const next = changeTrail.slice(0, -1); void readChanges(binding.id, next.at(-1), next); }}>上一页绑定变更</button>
            <button className="oc-button" type="button" disabled={disabled || changesReading || !changes?.nextCursor} onClick={() => void readChanges(binding.id, changes!.nextCursor!, [...changeTrail, changes!.nextCursor!])}>下一页绑定变更</button></div>
          {changesReading && <p role="status">正在读取原绑定变更记录</p>}
          {changes && <><p>本页 {changes.items.length} 笔变更{changes.nextCursor ? " 还有下一页" : " 本次查询已到末页"}</p><ul className="fei-history">{changes.items.map(item => <li key={item.id}>
            <p>{item.action === "release" ? "仅解除" : "更正并应用本行"} · {reasons[item.reasonCode]} · {item.createdAt}</p><p>原变更 <code>{item.id}</code></p>
            <button className="oc-button" type="button" disabled={disabled || receiptReading} onClick={() => void readReceipt(item.id)}>读取原绑定变更回执 {item.id.slice(-8)}</button></li>)}</ul>
            {!changes.items.length && <p>该修订尚无已登记变更</p>}</>}
          <form className="fei-search" aria-label="按原变更 ID 读取回执" onSubmit={event => { event.preventDefault(); void readReceipt(changeDraft); }}>
            <label>原绑定变更 ID<input value={changeDraft} disabled={disabled || receiptReading} autoComplete="off" onChange={event => setChangeDraft(event.target.value)} /></label>
            <button className="oc-button" type="submit" disabled={disabled || receiptReading || !changeDraft}>读取原绑定变更回执</button></form>
          {receiptReading && <p role="status">正在读取原绑定变更回执</p>}
          {receipt && <FactoryErpBindingChangeReceipt value={receipt} />}
          {(receipt || receiptReading) && <button className="oc-button" type="button" onClick={() => { reads.current.receipt++; setReceipt(null); setReceiptReading(false); }}>关闭原绑定变更回执读取</button>}
        </section>
      </>}
    </section>}
  </details>;
}
