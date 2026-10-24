"use client";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { ShipmentVersionEditorViewSchema, type ShipmentVersionEditorView } from "@yummyai/contracts/order/shipment";
import { centerRequest, OrderCenterRequestError } from "./order-center-model";
import { ShipmentProductionFields, readShipmentProductionAllocations } from "./shipment-production-fields";
import { FulfillmentCommandPrepareButton } from "./fulfillment-command-recovery";
import { useErpAccess } from "../identity/erp-access";
import { useAgentFulfillmentProposalHandoff, useAgentFulfillmentProposalInput } from "../ai-tasks/agent-fulfillment-proposal-handoff";

export function ShipmentSourceEditor({ shipmentId, refresh, disabled, onEditsChanged, onSave, onPrepare }: {
  shipmentId: string; refresh: string; disabled: boolean; onEditsChanged(): void;
  onSave(event: FormEvent<HTMLFormElement>, payload: Record<string, unknown>): Promise<boolean | undefined>;
  onPrepare?(event: FormEvent<HTMLFormElement>, payload: Record<string, unknown>): Promise<boolean | undefined>;
}) {
  const access = useErpAccess(), proposalHandoff = useAgentFulfillmentProposalHandoff(), suggestion = useAgentFulfillmentProposalInput("shipment_version", shipmentId);
  const [open, setOpen] = useState(false), [current, setCurrent] = useState<ShipmentVersionEditorView | null>(null),
    [basis, setBasis] = useState<ShipmentVersionEditorView | null>(null), [reading, setReading] = useState(false),
    [error, setError] = useState(""), [readFailed, setReadFailed] = useState(false), [reload, setReload] = useState(0);
  useEffect(() => { if (proposalHandoff?.formKey) { setOpen(!!suggestion); setBasis(null); setCurrent(null); setError(""); } }, [proposalHandoff?.formKey, suggestion]);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setReading(true); setReadFailed(false); setError("");
    void centerRequest(`shipments/${shipmentId}/source-editor`, undefined, AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]), proposalHandoff?.formKey ? access.authority ?? undefined : undefined).then(raw => {
      if (abort.signal.aborted) return;
      const next = ShipmentVersionEditorViewSchema.parse(raw); setCurrent(next); setBasis(previous => previous ?? next);
    }).catch(cause => {
      if (abort.signal.aborted) return;
      setReadFailed(true); setError(cause instanceof OrderCenterRequestError ? cause.message : "包裹资料暂时无法核对 请保留填写后重新读取");
      if (cause instanceof OrderCenterRequestError && [401, 403].includes(cause.status)) { setCurrent(null); setBasis(null); }
    }).finally(() => { if (!abort.signal.aborted) setReading(false); });
    return () => abort.abort();
  }, [open, shipmentId, refresh, reload, access.authority, proposalHandoff?.formKey]);
  const staleVersion = !!current && !!basis && current.versionId !== basis.versionId;
  const suggestionVersionChanged = !!suggestion && suggestion.expectedCurrentVersion !== undefined && current?.versionNumber !== suggestion.expectedCurrentVersion;
  const suggestionPackagesChanged = !!suggestion?.packages?.some(pkg => {
    const original = basis?.content.packages.find(row => row.packageReferenceId === pkg.packageReferenceId);
    return !original || pkg.lines?.some(line => !original.lines.some(row => row.orderLineId === line.orderLineId && row.quantity === line.quantity));
  });
  const blocked = disabled || reading || readFailed || !current?.canRevise || staleVersion || !!proposalHandoff && (proposalHandoff.blocked || !suggestion || suggestionVersionChanged || suggestionPackagesChanged);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (blocked || !basis || !current) return;
    const prepareOnly = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("data-agent-fulfillment-prepare") === "true";
    if (prepareOnly && !onPrepare || proposalHandoff && !prepareOnly) return;
    try {
      const form = new FormData(event.currentTarget), packages = basis.content.packages.map(pkg => ({ ...pkg,
        lines: pkg.lines.map(line => ({ ...line, productionAllocations: readShipmentProductionAllocations(form, line.orderLineId, line.quantity, pkg.packageReferenceId + ":") })),
      }));
      setError("");
      const saveOriginal = prepareOnly && onPrepare ? onPrepare : onSave;
      if (await saveOriginal(event, { ...basis.content, packages, expectedCurrentVersion: basis.versionNumber })) {
        setOpen(false); setBasis(null); setCurrent(null);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "请核对每个包裹的生产来源与数量"); }
  }
  return <details className="oc-shipment-source-editor" open={open} onToggle={event => { const next = event.currentTarget.open; setOpen(next); if (!next) setReading(false); }}>
    <summary>核对生产来源并建立新版本</summary>
    {(open || basis || current) && <>
      <p className="oc-hint">按当前包裹的原商品和数量重新核对实物 来源、生产版本和质检将保存为新发货版本 原包裹与原审核保留 新版本需要重新审核</p>
      {proposalHandoff && <p className="oc-hint">这里只补齐原包裹的生产来源 运单与商品数量仍须和本页原版本一致 不用今天的新包裹替换建议来源</p>}
      {(suggestionVersionChanged || suggestionPackagesChanged) && <p className="oc-error" role="alert">原建议的包裹版本 商品或数量与当前原记录不符 请返回原任务核对 本页不替换为新版本准备</p>}
      <button type="button" className="oc-text-button" disabled={disabled || reading} onClick={() => setReload(value => value + 1)}>重新读取包裹与生产来源</button>
      {reading && <p role="status">正在核对包裹与生产来源</p>}
      {error && <p className="oc-error" role="alert">{error}</p>}
      {current?.blockers.map(reason => <p className="oc-error" key={reason}>{reason}</p>)}
      {current?.sourceOnly && <p className="oc-notice">平台已有发货确认 此处只核对生产来源 运单和商品数量保持原样 原平台回执保留 新版本需另行核对平台</p>}
      {staleVersion && <div className="oc-notice" role="alert"><p>发货版本已变化 当前填写已保留 请先核对新包裹再重新分配</p>
        <button type="button" className="oc-button" disabled={disabled || reading || !!proposalHandoff} onClick={() => { setBasis(current); setError(""); }}>核对新包裹并重新分配</button></div>}
      {basis && current && <form key={proposalHandoff?.formKey} aria-label="修订包裹生产来源" data-order-action="shipment-sources" onSubmit={event => void save(event)}>
        <fieldset className="oc-shipment-revision-fields" disabled={blocked}>
          {basis.content.packages.map(pkg => <section key={`${basis.versionId}:${pkg.packageReferenceId}`} className="oc-shipment-revision-package">
            <h4>{pkg.packageReferenceId}</h4><p>{pkg.carrierName} · {pkg.carrierService} · {pkg.trackingNumber}</p>
            <ShipmentProductionFields sources={current.sources} prefix={pkg.packageReferenceId + ":"} disabled={blocked} onEditsChanged={onEditsChanged}
              resetKey={proposalHandoff?.formKey} initialAllocations={proposalHandoff ? suggestion?.packages?.find(row => row.packageReferenceId === pkg.packageReferenceId)?.lines?.map(line => ({ lineId: line.orderLineId, productionAllocations: line.productionAllocations })) ?? null : undefined}
              lines={pkg.lines.map(line => ({ lineId: line.orderLineId, quantity: line.quantity, title: basis.lines.find(row => row.lineId === line.orderLineId)?.title ?? `商品 ${line.orderLineId.slice(-8)}` }))} />
          </section>)}
          <button className="oc-button primary" disabled={!!proposalHandoff}>保存新的发货版本</button>
          {onPrepare && <FulfillmentCommandPrepareButton disabled={blocked} />}
        </fieldset>
      </form>}
      {basis?.lines[0] && <p className="oc-hint">缺少原生产版本的逐项质检时 <Link href={`/production?line=${basis.lines[0].lineId}`}>返回生产中心核对原实物</Link></p>}
    </>}
  </details>;
}
