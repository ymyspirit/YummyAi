"use client";
import { ManufacturingDeliverySummary, manufacturingQuantityUnit } from "../manufacturing-recipes/manufacturing-delivery-summary";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Download, PackageCheck, RefreshCw } from "lucide-react";
import { ProductionDeliveryPackageViewSchema, ProductionDeliveryWorkspaceSchema, pillowFactoryDeliveryProgress,
  type ProductionDeliveryPackageView, type ProductionDeliveryWorkspace } from "@yummyai/contracts/order/production-delivery";
import { centerRead, centerRequest, dateTime, OrderCenterRequestError } from "./order-center-model";
import { formFingerprint, useFormEdits } from "../navigation/use-form-edits";
import { useLeaveGuard } from "../navigation/use-leave-guard";
import "./order-production-delivery.css";
import type { OrderReviewState } from "./order-work-detail";
import { ReviewedArtworkRemakeForm as RemakeForm } from "./reviewed-artwork-remake-form";
import { FactoryErpImportWorkspace } from "./factory-erp-import-workspace";
import { normalizeFulfillmentCommand } from "@yummyai/contracts/order/fulfillment-command";
import { FulfillmentCommandPrepareButton, useFulfillmentCommandScope } from "./fulfillment-command-recovery";
import { fulfillmentCommandForOperation } from "./fulfillment-command-intent";
import { useAgentFulfillmentProposalHandoff, useAgentFulfillmentProposalInput, agentFulfillmentProposalLocalTime } from "../ai-tasks/agent-fulfillment-proposal-handoff";
import { FulfillmentCommandRequestError } from "./fulfillment-command-client";

const empty: ProductionDeliveryWorkspace = { candidates: [], packages: [], truncated: false };
const feedbackLabels = { pending: "待运营提交", submitted: "已提交工厂 ERP", received: "工厂已收到文件", accepted: "工厂接受文件", rejected: "工厂拒收文件", rework: "返工跟进" };
const nextFeedback = (status: Item["status"]) => status === "pending" ? "submitted" : status === "submitted" ? "received" : status === "received" ? "accepted" : status === "accepted" ? "rejected" : "rework";
const idleImport: OrderReviewState = { dirty: false, busy: false, loading: false };
type Item = ProductionDeliveryPackageView["items"][number];
type DeliveryCommandIntent = { kind: "packet" | "remake"; path: string; body: Record<string, unknown>; success: string; prepareOnly?: boolean; settle(saved: boolean): void };
export function OrderProductionDeliveryPanel({ line, orderId, focusPackageId, orderItems, refreshToken, onChanged, factories: factoryChoices, onStateChange, onSelectItem }: {
  line: string | null; orderId?: string; focusPackageId?: string; orderItems?: Array<{ id: string; quantity: number; title?: string }>; refreshToken: number; onChanged(): void;
  factories: Array<{ id: string; name: string; supplierName: string }>;
  onStateChange?(state: OrderReviewState): void; onSelectItem?(lineId: string): void;
}) {
  const proposalHandoff = useAgentFulfillmentProposalHandoff(), createSuggestion = useAgentFulfillmentProposalInput("delivery_create", orderId ?? "");
  const fulfillment = useFulfillmentCommandScope();
  const [view, setView] = useState(empty), [loading, setLoading] = useState(true), [working, setBusy] = useState(false);
  const [importState, setImportState] = useState(idleImport), [privateDenied, setPrivateDenied] = useState(false);
  const controlBlocked = !fulfillment || fulfillment.blocked;
  const deliveryBusy = working || controlBlocked || Boolean(fulfillment?.busy);
  const busy = deliveryBusy || importState.busy;
  const actualBusy = working || importState.busy || Boolean(fulfillment?.busy);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [selected, setSelected] = useState<string[]>([]);
  const [supplier, setSupplier] = useState(""), [dueBefore, setDueBefore] = useState("");
  const [replacementOnly, setReplacementOnly] = useState(false);
  const requestKeys = useRef(new Map<string, string>()), requestNumber = useRef(0);
  const commandActive = useRef(false), alive = useRef(true), authority = useRef(0);
  const unsettled = useRef<((saved: boolean) => void) | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; authority.current++; unsettled.current?.(false); }; }, []);
  const clearPrivate = useCallback(() => { authority.current++; requestNumber.current++; unsettled.current?.(false); requestKeys.current.clear(); setView(empty); setSelected([]); setNotice(""); setPrivateDenied(true); }, []);
  const focused = useRef<string | null>(null);
  const focusOrderLineIds = (orderItems ?? []).map(item => item.id).sort().join(",");
  const forms = useFormEdits();
  useEffect(() => { onStateChange?.({ dirty: forms.dirty || importState.dirty, busy: actualBusy, loading: loading || importState.loading }); }, [forms.dirty, importState.dirty, importState.loading, actualBusy, loading, onStateChange]);
  useLeaveGuard(forms.dirty || importState.dirty, actualBusy);
  const query = new URLSearchParams(); if (orderId) query.set("order", orderId); if (line) query.set("line", line); if (supplier && !orderId) query.set("factory", supplier); if (dueBefore) query.set("dueBefore", new Date(`${dueBefore}T23:59:59.999`).toISOString());
  const path = query.size ? `deliveries?${query}` as const : "deliveries";
  const read = useCallback(async (signal?: AbortSignal) => {
    const current = ++requestNumber.current;
    let data: ProductionDeliveryWorkspace;
    try { data = ProductionDeliveryWorkspaceSchema.parse(await centerRead(path, signal ?? new AbortController().signal)); }
    catch (cause) {
      if (!signal?.aborted && current === requestNumber.current && cause instanceof OrderCenterRequestError && [401, 403, 404].includes(cause.status)) clearPrivate();
      throw cause;
    }
    if (focusPackageId && !data.packages.some(packet => packet.id === focusPackageId)) {
      const packet = ProductionDeliveryPackageViewSchema.parse(await centerRequest(`deliveries/${focusPackageId}`, undefined, signal));
      if (!orderId || !packet.items.some(item => item.snapshot && focusOrderLineIds.split(",").includes(item.snapshot.orderLineId))) throw new Error("交付包不属于当前订单，或资料已到期");
      data.packages = [packet, ...data.packages];
    }
    if (!signal?.aborted && current === requestNumber.current) {
      setView(data);
      setPrivateDenied(false);
      setSelected(ids => proposalHandoff?.formKey ? (createSuggestion?.items ?? []).flatMap(item => item.productionOrderId && data.candidates.some(candidate => candidate.productionOrderId === item.productionOrderId && (item.productionVersionId === undefined || candidate.productionVersionId === item.productionVersionId)
        && (item.expectedProjectionVersion === undefined || candidate.projectionVersion === item.expectedProjectionVersion)) ? [item.productionOrderId] : [])
        : orderId && !replacementOnly ? data.candidates.filter(candidate => !candidate.parentProductionOrderId).map(candidate => candidate.productionOrderId) : ids.filter(id => data.candidates.some(candidate => candidate.productionOrderId === id && !candidate.blockers.length)));
    }
  }, [path, orderId, replacementOnly, focusPackageId, focusOrderLineIds, clearPrivate, proposalHandoff?.formKey, createSuggestion]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError("");
    void read(controller.signal).catch(cause => { if (!controller.signal.aborted) setError(message(cause)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [read, refreshToken]);
  useEffect(() => {
    if (!loading && focusPackageId && focused.current !== focusPackageId && view.packages.some(packet => packet.id === focusPackageId)) {
      const element = document.getElementById(`delivery-package-${focusPackageId}`);
      if (element) { focused.current = focusPackageId; element.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" }); element.focus({ preventScroll: true }); }
    }
  }, [loading, focusPackageId, view.packages]);
  const visible = view.candidates.filter(candidate => (!supplier || candidate.factoryId === supplier) && (!dueBefore || localDay(candidate.expectedCompletionAt) <= dueBefore)).sort((a, b) => a.expectedCompletionAt.localeCompare(b.expectedCompletionAt) || a.productionOrderId.localeCompare(b.productionOrderId));
  const chosen = visible.filter(candidate => selected.includes(candidate.productionOrderId));
  const missingItems = orderId && !replacementOnly ? orderItems?.filter(item => view.candidates.filter(candidate => candidate.orderLineId === item.id && !candidate.parentProductionOrderId).reduce((sum, candidate) => sum + candidate.quantity, 0) !== item.quantity) ?? [] : [];
  const incompleteWhole = !!orderId && !replacementOnly && (missingItems.length > 0 || visible.some(candidate => !candidate.parentProductionOrderId && !selected.includes(candidate.productionOrderId)));
  const splitFactories = !!orderId && !replacementOnly && new Set(view.candidates.filter(candidate => !candidate.parentProductionOrderId).map(candidate => candidate.factoryId)).size > 1;
  const factories = [...new Map([...factoryChoices.map(factory => [factory.id, `${factory.name} · ${factory.supplierName}`] as const), ...view.candidates.filter(candidate => candidate.factoryId).map(candidate => [candidate.factoryId!, `${candidate.factoryName ?? "工厂名称不可用"} · ${candidate.supplierName}`] as const)]).entries()];
  function key(input: unknown) {
    if (proposalHandoff) return proposalHandoff.slotId;
    const signature = JSON.stringify(input);
    if (!requestKeys.current.has(signature)) requestKeys.current.set(signature, crypto.randomUUID());
    return requestKeys.current.get(signature)!;
  }
  async function perform(intent: DeliveryCommandIntent) {
    if (proposalHandoff && !intent.prepareOnly) { setError("当前为模型原提案补项 请明确选择只准备 不直接生成交付或登记回执"); intent.settle(false); return false; }
    if (commandActive.current) return false;
    commandActive.current = true; const epoch = authority.current; let committed = false, preparationSaved = false;
    setBusy(true); setError(""); setNotice("");
    try {
      if (!fulfillment || !orderId || fulfillment.orderId !== orderId) throw new Error("请从当前原整单读取履约恢复依据后提交");
      const command = intent.path === "deliveries"
        ? { kind: "delivery_create" as const, targetId: orderId, requestId: crypto.randomUUID(), input: intent.body }
        : /^deliveries\/[0-9a-f-]+\/items\/[0-9a-f-]+\/feedback$/.test(intent.path)
          ? { kind: "delivery_feedback" as const, packageId: intent.path.split("/")[1], targetId: intent.path.split("/")[3], requestId: crypto.randomUUID(), input: intent.body }
          : fulfillmentCommandForOperation(intent.path, intent.body, { orderId });
      if (!command) throw new Error("本次操作不是已登记的原履约命令");
      if (intent.prepareOnly) {
        await fulfillment.prepareAgent(normalizeFulfillmentCommand(command));
        if (!alive.current || epoch !== authority.current) return false;
        preparationSaved = true;
        setNotice("本次只交接原填写 未请求生成交付包 登记回执或建立补做 请到 AI 工作台核对后逐笔明确执行");
        return true;
      }
      const result = await fulfillment.submit(normalizeFulfillmentCommand(command));
      if (!alive.current || epoch !== authority.current) return false;
      if (intent.kind === "packet") {
        if (result.receipt?.kind !== "delivery_create" && result.receipt?.kind !== "delivery_feedback") throw new Error("原交付回执类型不一致 请只读核对原提交");
        committed = true;
        setNotice(intent.success);
      } else {
        const receipt = result.receipt;
        if (receipt?.kind !== "production_recovery") throw new Error("原补做回执类型不一致 请只读核对原提交");
        if (!receipt.replacementProductionOrderId) throw new Error("返回的返工生产回执不完整 请恢复本次提交结果");
        committed = true; setNotice(`返工生产单 ${receipt.replacementProductionOrderId.slice(-8)} 已创建。请在返工回执中关联该单，再为它创建新的交付包。`);
      }
      intent.settle(true); onChanged(); await read();
      return true;
    } catch (cause) {
      if (!alive.current || epoch !== authority.current) return committed;
      if (committed) { setError("本次记录已保存 当前列表暂时无法刷新 请重新读取"); return true; }
      if (cause instanceof OrderCenterRequestError && [401, 403, 404].includes(cause.status)) clearPrivate();
      setError(message(cause) + (cause instanceof FulfillmentCommandRequestError ? " 请在本单原履约提交恢复区核对 不重新填写发送" : "")); return false;
    } finally { intent.settle(committed || preparationSaved); commandActive.current = false; if (alive.current) setBusy(false); }
  }
  function begin(intent: Omit<DeliveryCommandIntent, "settle">) {
    if (busy || commandActive.current) return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
      let resolved = false;
      const settle = (saved: boolean) => { if (!resolved) { resolved = true; if (unsettled.current === settle) unsettled.current = null; resolve(saved); } };
      unsettled.current = settle; void perform({ ...intent, settle });
    });
  }
  async function update(path: string, input: Record<string, unknown>, success: string, prepareOnly = false) {
    if (busy || commandActive.current) return false;
    return begin({ kind: "packet", path, body: structuredClone({ ...input, idempotencyKey: key([path, input]) }), success, prepareOnly });
  }
  async function create(prepareOnly = false) {
    if (incompleteWhole || !chosen.length || chosen.some(candidate => !candidate.factoryId || candidate.blockers.length > 0) || new Set(chosen.map(candidate => candidate.factoryId)).size !== 1 || new Set(chosen.map(candidate => candidate.factoryVersionId)).size !== 1) { setError("请补齐本单全部商品，并核对同一工厂及固定版本的交付条件。"); return; }
    const input = { supplierId: chosen[0]!.supplierId, factoryId: chosen[0]!.factoryId, items: chosen.map(candidate => ({ productionOrderId: candidate.productionOrderId,
      productionVersionId: candidate.productionVersionId, expectedProjectionVersion: candidate.projectionVersion })).sort((a, b) => a.productionOrderId.localeCompare(b.productionOrderId)) };
    if (await update("deliveries", input, "正式交付包已锁定，可下载后人工交付工厂。", prepareOnly) && (!orderId || replacementOnly)) setSelected([]);
  }
  async function download(packet: ProductionDeliveryPackageView) {
    if (busy || commandActive.current) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/order-centers/deliveries/${packet.id}/file`, { cache: "no-store" });
      if (!response.ok) { const result = await response.json().catch(() => null); throw new Error(result?.message ?? "交付包下载失败，请刷新后重试"); }
      const url = URL.createObjectURL(await response.blob()), anchor = document.createElement("a");
      anchor.href = url; anchor.download = `pillow-delivery-${packet.id}.zip`; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("交付包已下载 实际上传工厂 ERP 后请登记提交凭据 下载不等于已排产");
    } catch (cause) { setError(message(cause)); await read().catch(() => undefined); }
    finally { setBusy(false); }
  }
  async function remake(input: Record<string, unknown>, prepareOnly = false) {
    if (busy || commandActive.current) return false;
    return begin({ kind: "remake", path: "recoveries", body: structuredClone({ ...input, idempotencyKey: key(["recoveries", input]) }), success: "返工生产单已创建", prepareOnly });
  }
  return <section ref={forms.ref} onInput={forms.check} onChange={forms.check} id={orderId ? undefined : "pillow-delivery"} className="oc-delivery" aria-label="抱枕交付与工厂回执" aria-busy={loading || working}>
    <div className="oc-delivery-heading"><div><h2><PackageCheck size={18} />抱枕交付与工厂回执</h2><p>已审核 JPG 按工厂打包 真实提交凭据登记后显示已排产 并标明按提交默认</p></div>
      <button className="oc-button" type="button" disabled={loading || busy} onClick={() => { setLoading(true); setError(""); void read().catch(cause => setError(message(cause))).finally(() => setLoading(false)); }}><RefreshCw size={16} />刷新交付</button></div>
    {error && <p role="alert" className="oc-delivery-error">{error}</p>}{notice && <p role="status" className="oc-delivery-notice">{notice}</p>}
    {loading && <p role="status">正在读取交付清单…</p>}
    <div className="oc-delivery-filters">{(!orderId || splitFactories) && <label>交付工厂<select aria-label="交付工厂" value={supplier} disabled={busy || forms.dirty || importState.dirty} onChange={event => { setSupplier(event.target.value); if (!orderId) setSelected([]); }}><option value="">{orderId ? "选择本单交付工厂" : "全部工厂"}</option>{factories.filter(([id]) => !orderId || view.candidates.some(candidate => candidate.factoryId === id)).map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label>}
      {!orderId && <label>交期截至<input type="date" value={dueBefore} disabled={busy || forms.dirty || importState.dirty} onChange={event => { setDueBefore(event.target.value); setSelected([]); }} /></label>}
      <button className="oc-button primary" type="button" disabled={!!proposalHandoff || loading || busy || incompleteWhole || !chosen.length || chosen.length > 50 || chosen.some(candidate => !candidate.factoryId || candidate.blockers.length > 0) || new Set(chosen.map(candidate => candidate.factoryId)).size !== 1 || new Set(chosen.map(candidate => candidate.factoryVersionId)).size !== 1} onClick={() => void create()}>{orderId ? replacementOnly ? "生成返工交付包" : splitFactories ? "生成本工厂交付包" : "生成本单完整交付包" : "生成交付包"}（{chosen.length}）</button>
      {fulfillment?.canPrepareAgent && <button className="oc-button afc-handoff-button" type="button" disabled={loading || busy || incompleteWhole || !chosen.length || chosen.length > 50 || chosen.some(candidate => !candidate.factoryId || candidate.blockers.length > 0) || new Set(chosen.map(candidate => candidate.factoryId)).size !== 1 || new Set(chosen.map(candidate => candidate.factoryVersionId)).size !== 1} onClick={() => void create(true)}>只准备交由 Agent 核对</button>}
      {orderId && visible.some(candidate => candidate.parentProductionOrderId) && <button className="oc-button" type="button" disabled={busy || forms.dirty || importState.dirty} onClick={() => { setSelected([]); setReplacementOnly(value => !value); }}>{replacementOnly ? "返回整单交付" : "单独交付返工文件"}</button>}</div>
    <FactoryErpImportWorkspace factories={factories.map(([id, name]) => ({ id, name }))} initialFactoryId={supplier}
      disabled={deliveryBusy} unavailable={privateDenied} onStateChange={setImportState} onDenied={clearPrivate}
      onChanged={() => { onChanged(); void read().catch(cause => setError(message(cause))); }} />
    {incompleteWhole && !loading && <div className="oc-delivery-error" role="alert"><p>交付包尚未包含本单全部商品，不能遗漏后生成。</p><ul>{missingItems.map(item => <li key={item.id}>{item.title ?? `商品 ${item.id.slice(-6)}`} · 需要完整 {item.quantity} 件的生产文件{onSelectItem && <button type="button" className="oc-text-button" disabled={busy} onClick={() => onSelectItem(item.id)}>核对该商品生产</button>}</li>)}</ul></div>}
    {splitFactories && <p className="oc-muted">本单由多个工厂生产。核对全部商品已排期后，逐工厂生成交付包；每包包含该工厂负责的完整数量及对应物流资料。</p>}
    {forms.dirty && <p className="oc-muted">有未保存的回执或返工内容，请先登记或清空表单，再更换工厂及交期筛选。</p>}
    {!loading && !view.candidates.length && <p className="oc-muted">还没有关联已审核正式文件的生产单。请在订单生产记录中选择文件并下达生产。</p>}
    <div className="oc-delivery-candidates">{visible.map(candidate => <label className="oc-delivery-candidate" key={candidate.productionOrderId}>
      <input type="checkbox" aria-label={`选择交付 ${candidate.orderNumber} ${candidate.productionOrderId.slice(-6)}`} checked={selected.includes(candidate.productionOrderId)} disabled={busy || candidate.blockers.length > 0 || !!orderId && (!replacementOnly || !candidate.parentProductionOrderId)}
        onChange={event => setSelected(ids => event.target.checked ? [...ids, candidate.productionOrderId] : ids.filter(id => id !== candidate.productionOrderId))} />
      <span><strong>{candidate.orderNumber}</strong><small>{candidate.quantity} 件 · 生产单 {candidate.productionOrderId.slice(-6)}</small></span><span>{candidate.factoryName ?? "具体工厂待确认"}<small>{candidate.supplierName}</small></span>
      <span>交期 {dateTime(candidate.expectedCompletionAt)}</span><span className={candidate.blockers.length ? "oc-delivery-error" : ""}>{candidate.blockers.length ? candidate.blockers.join("；") : "可创建交付包"}</span>
    </label>)}</div>
    {view.truncated && <p className="oc-muted">显示最近 100 个生产单及 20 个交付包。请从订单进入，以查看该订单的交付历史。</p>}
    <h3>交付包与回执</h3>
    {!loading && !view.packages.length && <p className="oc-muted">尚未创建交付包。</p>}
    {view.packages.map(packet => <details className="oc-delivery-package" id={`delivery-package-${packet.id}`} tabIndex={-1} key={packet.id} open={line || orderId ? true : undefined}>
      <summary>{packet.factory?.factoryProfile.name ?? "历史包：工厂归属未确认"} · {packet.supplierName} · {packet.items.length} 个文件 · {dateTime(packet.createdAt)}<small>交付包 {packet.id.slice(-8)} · {packet.canDownload ? "可下载" : "已阻止下载"}</small></summary>
      {packet.factory?.factoryProfile.productionAddress && <p className="oc-muted">固定生产地址：{[packet.factory.factoryProfile.productionAddress.countryCode, packet.factory.factoryProfile.productionAddress.province, packet.factory.factoryProfile.productionAddress.city, packet.factory.factoryProfile.productionAddress.district, packet.factory.factoryProfile.productionAddress.street].filter(Boolean).join(" · ")} · 资料 V{packet.factory.factoryVersionNumber}</p>}
      <div className="oc-delivery-package-tools"><button className="oc-button" type="button" disabled={busy || !packet.canDownload} onClick={() => void download(packet)}><Download size={16} />下载正式交付包</button><span>清单 SHA-256 <code title={packet.checksum}>{packet.checksum}</code></span></div>
      <p className="oc-muted">下载后到 <a href="https://v2.jmlonline.com/task/list" target="_blank" rel="noreferrer">工厂 ERP 上传</a> 并登记真实提交凭据 创建或下载交付包仍待提交 不代表已排产</p>
      <p className="oc-muted">工厂主跟进为已排产与已发货 从上方工厂 Excel／CSV 状态同步读取原表并确认整组应用 收到 接受和异常回执按需补充</p>
      {packet.items.filter(item => !orderItems || !item.snapshot || orderItems.some(line => line.id === item.snapshot!.orderLineId)).map(item => <DeliveryItem key={item.id} item={item} packetId={packet.id} candidates={view.candidates} busy={busy} remake={remake} onSelectItem={onSelectItem} commit={form => forms.commit(form, formFingerprint(form))}
        prepareRemake={input => remake(input, true)} prepare={input => update(`deliveries/${packet.id}/items/${item.id}/feedback`, input, "", true)}
        submit={(input) => update(`deliveries/${packet.id}/items/${item.id}/feedback`, input, input.kind === "submitted" ? "提交凭据已登记 已排产（按提交默认） 原文件及历史记录均已保留" : "工厂补充回执已登记 原文件及历史记录均已保留")} />)}
    </details>)}
  </section>;
}
function DeliveryItem({ item, packetId, candidates, busy, submit, prepare, commit, remake, prepareRemake, onSelectItem }: { item: Item; packetId: string; candidates: ProductionDeliveryWorkspace["candidates"]; busy: boolean; submit(input: Record<string, unknown>): Promise<boolean>; prepare(input: Record<string, unknown>): Promise<boolean>; commit(form: HTMLFormElement): void; remake(input: Record<string, unknown>): Promise<boolean>; prepareRemake(input: Record<string, unknown>): Promise<boolean>; onSelectItem?(id: string): void }) {
  const proposalHandoff = useAgentFulfillmentProposalHandoff(), suggestion = useAgentFulfillmentProposalInput("delivery_feedback", item.id, { packageId: packetId });
  const [kind, setKind] = useState(nextFeedback(item.status));
  const [error, setError] = useState("");
  const [baseSequence, setBaseSequence] = useState(item.sequence);
  const [defaultOccurredAt, setDefaultOccurredAt] = useState(localNow);
  const [commitRevision, setCommitRevision] = useState(0);
  const [feedbackOpen, setFeedbackOpen] = useState(item.status === "pending");
  useEffect(() => {
    if (!proposalHandoff?.formKey) return;
    setKind(suggestion?.kind ?? nextFeedback(item.status));
    setDefaultOccurredAt(agentFulfillmentProposalLocalTime(suggestion?.occurredAt));
    setBaseSequence(suggestion?.expectedSequence ?? item.sequence); setFeedbackOpen(!!suggestion);
  }, [proposalHandoff?.formKey, suggestion, item.sequence, item.status]);
  const pendingCommit = useRef<HTMLFormElement | null>(null);
  useLayoutEffect(() => {
    const form = pendingCommit.current;
    if (!form || item.sequence !== baseSequence) return;
    pendingCommit.current = null;
    if (form.isConnected) commit(form);
  }, [item.sequence, kind, baseSequence, defaultOccurredAt, commitRevision, commit]);
  const pin = item.snapshot;
  const progress = pillowFactoryDeliveryProgress(item.status);
  const releasedImport = item.factoryErp?.bindingReleased ? item.factoryErp : null;
  const imported = releasedImport ? null : item.factoryErp;
  const importedLabel = imported?.status === "shipped" ? "工厂已发货" : imported?.status === "scheduled" ? "已排产" :
    imported?.voidSummary && imported.voidSummary.pending === 0 ? imported.voidSummary.requiresOrderHandling > 0 ? "原作废已核对 待业务处理" : "作废记录已核对" : "工厂异常待核对";
  if (!pin) return <div className="oc-delivery-item"><p className="oc-muted">订单资料已到期或清理，仅保留不可变交付索引。工厂回执包含私人内容，已停止展示。</p></div>;
  async function record(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const form = event.currentTarget, data = new FormData(form), amount = String(data.get("amount") ?? "").trim();
    const prepareOnly = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("data-agent-fulfillment-prepare") === "true";
    try {
      if (baseSequence !== item.sequence) throw new Error("回执已有更新，输入已保留。请核对历史并清空表单后重新登记。");
      const cost = amount ? { amountMinor: toMinor(amount), currency: String(data.get("currency")).trim().toUpperCase(), basis: String(data.get("costBasis")), reference: String(data.get("costReference")).trim() } : null;
      await (prepareOnly ? prepare : submit)({ kind, expectedSequence: item.sequence, fileChecksum: pin!.file.checksum, reference: String(data.get("reference")).trim(), note: String(data.get("note")).trim(),
        manufacturingChecksum: pin!.manufacturing?.plan.checksum,
        occurredAt: new Date(String(data.get("occurredAt"))).toISOString(), verifiedByOperator: data.get("verified") === "on",
        affectedQuantity: ["rejected", "rework"].includes(kind) ? Number(data.get("quantity")) : null, cost,
        replacementProductionOrderId: kind === "rework" ? String(data.get("replacement") ?? "") || null : null }).then(saved => { if (saved) { if (prepareOnly) { form.reset(); commit(form); setFeedbackOpen(false); return; } form.reset(); pendingCommit.current = form; setDefaultOccurredAt(localNow()); setBaseSequence(item.sequence + 1); setKind(nextFeedback(kind as Item["status"])); setFeedbackOpen(false); setCommitRevision(value => value + 1); } });
    } catch (cause) { setError(message(cause)); }
  }
  return <div className="oc-delivery-item">
    <div className="oc-delivery-item-heading"><strong>{pin.orderNumber} · {pin.quantity} {manufacturingQuantityUnit(pin.manufacturing?.plan.unit)}</strong><span>{imported ? importedLabel : progress.label}<small>{imported ? "工厂表格来源" : progress.basis === "submission_default" ? "按提交默认" : ""}</small></span>{onSelectItem ? <button className="oc-text-button" type="button" disabled={busy} onClick={() => onSelectItem(pin.orderLineId)}>查看本件生产与返工</button> : <Link href={`/production?line=${pin.orderLineId}`}>订单生产与返工</Link>}</div>
    {releasedImport && <p className="oc-muted">旧工厂表格关联已解除 原修订 {releasedImport.bindingRevision} · 历史观察 {releasedImport.historicalStatus === "shipped" ? "工厂已发货" : releasedImport.historicalStatus === "scheduled" ? "已排产" : "异常待核对"} 继续保留 该观察不作为当前组跟进依据 · 解除 <code>{releasedImport.bindingReleaseId}</code></p>}
    {imported ? <><p className="oc-muted">工厂表格观察为主跟进依据 不代表承运揽收 质检通过或已发货数量</p>
      {imported.exception && <p className="oc-delivery-error">工厂原表已作废 异常待人工核对 不自动取消内部订单 不撤销既有发货</p>}
      {imported.voidSummary && imported.voidSummary.total > 0 && <details className="oc-delivery-history">
        <summary>核对原作废观察与人工记录</summary>
        <p>原作废 {imported.voidSummary.total} 条 · 待核对 {imported.voidSummary.pending} 条 · 确认作废后待订单处理 {imported.voidSummary.requiresOrderHandling} 条</p>
        {(imported.voidSummary.nextPending ?? imported.voidSummary.latest) && (() => {
          const observation = (imported.voidSummary.nextPending ?? imported.voidSummary.latest)!;
          return <><p>本条作废观察 <code>{observation.id}</code> · 原序号 {observation.sequence}</p>
            <p>作废来源导入 <code>{observation.importId}</code> · 第 {observation.rowNumber} 行 · {observation.sourceReadable ? "原来源仍在访问期" : "原来源已到期 新核对另选有效来源"}</p>
            <p className="oc-muted">在下方工厂作废观察核对按原绑定 <code>{imported.bindingId}</code> 读取完整组和所有观察</p></>;
        })()}
        <p className="oc-muted">人工核对结论保留原观察 不代替工厂接口验真 取消 停做 质检 实物数量和承运交运</p>
      </details>}
      {imported.privateSourceExpired && <p className="oc-muted">原工厂表格私人来源已到期 仅保留状态索引</p>}
        <details className="oc-delivery-history"><summary>核对工厂表格原来源</summary>
          <p>原状态 {imported.rawStatus}</p>
          <p>原导入 <code>{imported.importId}</code> · 观察 <code>{imported.observationId}</code> · 登记 {dateTime(imported.recordedAt)}</p>
          <p className="oc-muted">原编号 原更新时间与运单参考请在下方工厂表格工作区按原导入 ID 核对 以当前来源访问期限为准</p>
          <p className="oc-muted">运单仅作单独参考 不证明承运揽收 发货数量未知 不以原生产数量补填</p>
        </details></> :
      progress.status === "scheduled" ? <p className="oc-muted">已登记真实文件提交凭据 按提交默认跟进已排产 无需再依次登记收到 接受或开工 后续以工厂原表状态核对</p>
      : progress.exception ? <p className="oc-delivery-error">存在工厂异常 请按实际拒收或返工情况补充记录 原历史继续保留</p>
        : <p className="oc-muted">文件待实际提交 只有创建或下载记录时不显示已排产</p>}
    <small>生产单 {pin.productionOrderId.slice(-8)} · 订单子项 {pin.orderLineId.slice(-8)}</small>
    <p>图稿 V{pin.editorVersionNumber} · {pin.sizeMm} mm（{({ artwork: "图案", cut_contour: "裁线", finished: "成品" })[pin.sizeBasis]}）· {pin.sideMode === "single" ? "单面" : "双面"} · 裁线最窄处 ≥ {pin.minimumNeckMm} mm</p>
    <p className="oc-muted">{pin.file.width} × {pin.file.height} px · 150 DPI · {pin.ruleSnapshotStatus === "pinned" ? "已锁定历史规则快照" : "旧任务没有规则快照，请按已审核工艺人工核对"}</p>
    <p className="oc-delivery-checksum">文件 SHA-256 <code>{pin.file.checksum}</code></p>
    <ManufacturingDeliverySummary plan={pin.manufacturing?.plan} instructions={pin.instructions} />
    {pin.logistics && <p className="oc-muted">{pin.logistics.provider === "yunexpress" ? "云途面单已随包提供" : pin.logistics.labelMode === "factory_pull" ? "ShipOS 面单由工厂按物流订单编号拉取" : "ShipOS 面单已随包提供"} · {pin.logistics.externalReference} · {pin.logistics.trackingNumbers.join(" / ") || "跟踪号待返回"}</p>}
    {item.blockers.length > 0 && <p className="oc-delivery-error">{item.blockers.join("；")}</p>}
    <details className="oc-delivery-history"><summary>查看回执与返工历史（{item.feedback.length}）</summary>
      {!item.feedback.length && <p className="oc-muted">尚未登记文件提交或补充回执</p>}
      {item.feedback.map(event => <div key={event.id}><p><strong>{feedbackLabels[event.kind]}</strong> · {dateTime(event.occurredAt)} · 依据 {event.reference}</p><p>{event.note}</p>
        {event.affectedQuantity !== null && <p>涉及 {event.affectedQuantity} 件 · {event.cost ? `${event.cost.basis === "confirmed" ? "已确认费用" : "工厂报价"} ${(event.cost.amountMinor / 100).toFixed(2)} ${event.cost.currency} · ${event.cost.reference}` : "费用未登记"}</p>}
        {event.replacementProductionOrderId && <p>原稿 V{pin.editorVersionNumber} → 返工稿 {event.replacementEditorVersionNumber ? `V${event.replacementEditorVersionNumber}` : event.replacementEditorVersionId} · 返工单 {event.replacementProductionOrderId}</p>}
        <small>记录时间 {dateTime(event.recordedAt)} · {event.origin==="factory"?"工厂本人回执":"运营人工核对"}</small></div>)}
    </details>
    <details className="oc-delivery-history" open={feedbackOpen} onToggle={event => setFeedbackOpen(event.currentTarget.open)}>
      <summary>{item.status === "pending" ? "登记真实文件提交凭据" : "可选补充回执与异常处理"}</summary>
      {item.status !== "pending" && <p className="oc-muted">收到或接受不是继续排产的前置步骤 仅在有实际补充回执 拒收或返工时填写</p>}
    <form key={proposalHandoff?.formKey} className="oc-delivery-form" aria-label={`登记工厂回执 ${pin.orderNumber} ${packetId.slice(-6)}`} onSubmit={event => void record(event)}>
      <fieldset disabled={busy}><label>回执类型<select aria-label="回执类型" value={kind} onChange={event => setKind(event.target.value)}>
        {item.status === "pending" && <option value="submitted">已提交工厂 ERP</option>}{["pending", "submitted"].includes(item.status) && <option value="received">工厂已收到文件</option>}{item.status === "received" && <option value="accepted">工厂接受文件</option>}
        {item.status !== "rejected" && <option value="rejected">工厂拒收文件</option>}{item.status === "rejected" && <option value="rework">返工跟进</option>}
      </select></label><label>{kind === "submitted" ? "提交凭证依据" : "回复依据"}<input name="reference" required maxLength={200} defaultValue={suggestion?.reference} placeholder={kind === "submitted" ? "实际上传记录或提交凭证编号" : "工厂消息编号 / 内部凭证编号"} /></label>
      <label>发生时间<input name="occurredAt" type="datetime-local" required defaultValue={proposalHandoff ? agentFulfillmentProposalLocalTime(suggestion?.occurredAt) : defaultOccurredAt} /></label>
      <label className="oc-delivery-wide">{kind === "submitted" ? "文件提交说明" : "工厂回复与处理说明"}<textarea name="note" required minLength={5} maxLength={2000} rows={2} defaultValue={suggestion?.note} placeholder={kind === "submitted" ? "记录实际文件上传和提交凭据核对情况" : "记录工厂实际回复、拒收原因或返工处理进度"} /></label>
      {["rejected", "rework"].includes(kind) && <><label>涉及数量<input name="quantity" type="number" required min={1} max={pin.quantity} defaultValue={suggestion?.affectedQuantity ?? pin.quantity} /></label>
        <label>费用金额（可留空）<input name="amount" type="number" min={0} step="0.01" defaultValue={typeof suggestion?.cost?.amountMinor === "number" ? suggestion.cost.amountMinor / 100 : ""} /></label><label>币种<select name="currency" defaultValue={suggestion?.cost?.currency ?? "CNY"}><option value="CNY">CNY</option><option value="USD">USD</option></select></label>
        <label>费用口径<select name="costBasis" defaultValue={suggestion?.cost?.basis}><option value="quote">工厂报价</option><option value="confirmed">已确认费用</option></select></label><label>费用依据<input name="costReference" maxLength={200} defaultValue={suggestion?.cost?.reference} placeholder="有费用时必填" /></label>
        {kind === "rework" && <label>关联返工生产单<select name="replacement" defaultValue={candidates.some(candidate => candidate.productionOrderId === suggestion?.replacementProductionOrderId && candidate.parentProductionOrderId === pin.productionOrderId && !candidate.blockers.length) ? suggestion?.replacementProductionOrderId ?? "" : ""}><option value="">暂未创建，先记录处理情况</option>{candidates.filter(candidate => candidate.parentProductionOrderId === pin.productionOrderId && !candidate.blockers.length).map(candidate => <option key={candidate.productionOrderId} value={candidate.productionOrderId}>{candidate.productionOrderId.slice(-8)} · {candidate.quantity} 件</option>)}</select></label>}
      </>}
      <label className="oc-delivery-verify"><input name="verified" type="checkbox" required />{kind === "submitted" ? pin.manufacturing ? "我已核对真实文件提交凭据 文件及制造清单校验值" : "我已核对真实文件提交凭据及本文件校验值" : pin.manufacturing ? "我已核对工厂实际回复、文件及制造清单校验值" : "我已核对工厂实际回复及本文件校验值"}</label>
      <button className="oc-button" disabled={busy || !!proposalHandoff || baseSequence !== item.sequence || kind === "accepted" && item.blockers.length > 0}>登记回执</button>
      <FulfillmentCommandPrepareButton disabled={busy || baseSequence !== item.sequence || kind === "accepted" && item.blockers.length > 0} />
      <button className="oc-button" type="button" onClick={event => { const form = event.currentTarget.form!; form.reset(); pendingCommit.current = form; setDefaultOccurredAt(localNow()); setBaseSequence(item.sequence); setError(""); setKind(nextFeedback(item.status)); setCommitRevision(value => value + 1); }}>清空并重新核对</button>
      {baseSequence !== item.sequence && <p role="status" className="oc-delivery-wide">回执已有更新，当前输入已保留。请核对历史后再登记。</p>}
      </fieldset>{error && <p role="alert" className="oc-delivery-error">{error}</p>}
    </form>
    </details>
    {item.status === "rejected" && <details className="oc-delivery-history"><summary>按需登记返工生产</summary><RemakeForm pin={pin} busy={busy} create={remake} commit={commit} prepareAgent={prepareRemake} /></details>}
  </div>;
}
function message(cause: unknown) { return cause instanceof Error ? cause.message : "操作未完成，请稍后重试"; }
function localNow() { const now = new Date(); return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); }
function localDay(value: string) { const date = new Date(value); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function toMinor(value: string) { if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error("费用金额最多保留两位小数"); const [whole, decimal = ""] = value.split("."); const amount = Number(whole) * 100 + Number(decimal.padEnd(2, "0")); if (!Number.isSafeInteger(amount)) throw new Error("费用金额过大"); return amount; }
