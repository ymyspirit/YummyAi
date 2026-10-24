"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";
import type { ProductSupplyView, ProductSupplyWorkspace } from "@yummyai/contracts/catalog/product-supply";
import type { ProcurementWorkspaceView } from "@yummyai/contracts/procurement";
import { PrepareProcurementCommandSchema, type PrepareProcurementCommand } from "@yummyai/contracts/procurement/procurement-command";
import { Field, RecordSelect } from "../manual-operations/record-form";
import { MasterRecordDialog, mergeRecords } from "../manual-operations/master-record-dialog";
import { formDate, formText, localDateTime, unitNames } from "../manual-operations/operation-types";
import { ProcurementCycleDialog, type ProcurementExternalForm } from "./procurement-command-workbench";
import { procurementCommandDenied, ProcurementCommandRequestError } from "../../lib/procurement-command-client";
import { formatMinorAmount } from "@yummyai/contracts/common/money";
import { formatStockQuantity, stockQuantityString, compareStockQuantity } from "@yummyai/contracts/inventory/quantity";
import { pinProcurementStockBasis, procurementAmountMinor, type ProcurementStockBasis } from "@yummyai/contracts/procurement/measurement";
import { ProcurementMeasure, procurementPrecisionMessage, readProcurementQuantity } from "./procurement-cycle-form";

export function ProcurementSupplyPurchaseDialog({ data, link, onClose, onSaved }: {
  data: ProductSupplyWorkspace; link: ProductSupplyView; onClose(): void; onSaved(record: Record<string, unknown>): void;
}) {
  const workspace = useMemo<ProcurementWorkspaceView>(() => ({ suppliers: data.suppliers, stockItems: data.stockItems,
    locations: data.locations, requisitions: [], rfqs: [], quotes: [], purchaseOrders: [], receipts: [], invoices: [], policies: [], suggestions: [] }), [data]);
  const externalForm = useMemo<ProcurementExternalForm>(() => ({ kind: "supply_purchase_create", targetId: link.id,
    render: props => <SupplyPurchaseForm data={data} link={link} {...props} /> }), [data, link]);
  return <ProcurementCycleDialog data={workspace} externalForm={externalForm} onClose={onClose} onChanged={() => undefined} onCompleted={onSaved} />;
}

function SupplyPurchaseForm({ data, link, disabled, onPrepare, onClose }: { data: ProductSupplyWorkspace; link: ProductSupplyView;
  disabled: boolean; onPrepare(input: PrepareProcurementCommand): Promise<void>; onClose(): void;
}) {
  const [location, setLocation] = useState(""), [purpose, setPurpose] = useState(link.terms.fulfillmentModes[0]!);
  const [extraLocations, setExtraLocations] = useState<ProductSupplyWorkspace["locations"]>([]), [creating, setCreating] = useState(false);
  const [code] = useState(() => `PO-${crypto.randomUUID().slice(0, 8).toUpperCase()}`), [key] = useState(() => crypto.randomUUID());
  const [quantity, setQuantity] = useState(stockQuantityString(link.terms.minimumOrderQuantity)), [working, setWorking] = useState(false), [error, setError] = useState("");
  const [frozen, setFrozen] = useState<PrepareProcurementCommand | null>(null), busy = useRef(false), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const stock = data.stockItems.find(row => row.id === link.terms.stockItemId), current = data.links.find(row => row.id === link.id);
  const missing = !stock || link.terms.unitCostMinor === null || !current;
  const changed = current?.currentVersion !== link.currentVersion;
  const purchaseUnit = link.terms.purchaseUnit ?? stock?.baseUnit;
  let total: number | null = null, precisionError = "", preview: ProcurementStockBasis | undefined;
  try {
    if (quantity && stock && purchaseUnit && link.terms.unitCostMinor !== null) {
      const amount = readProcurementQuantity(quantity, purchaseUnit);
      preview = pinProcurementStockBasis({ quantity: amount, unit: purchaseUnit, ...(link.terms.priceBasisQuantity === undefined ? {} : { priceBasisQuantity: link.terms.priceBasisQuantity }) }, stock.baseUnit).stockBasis;
      total = procurementAmountMinor(amount, link.terms.unitCostMinor, link.terms.priceBasisQuantity ?? 1);
    }
  } catch (failure) { precisionError = procurementPrecisionMessage(failure); }
  const locations = mergeRecords(data.locations, extraLocations).filter(row => row.status === "active" &&
    (extraLocations.some(extra => extra.id === row.id) || data.warehouses.find(warehouse => warehouse.id === row.warehouseId)?.status === "active"));
  useEffect(() => { if (location && !locations.some(row => row.id === location)) { setLocation(""); setError("原收货库位已不可用 已清空选择 请重新核对"); } }, [location, locations]);
  const modes = { custom_order: "定制订单", fba_replenishment: "FBA 备货" };
  return <><form className="record-form procurement-cycle-form" aria-label="按商品供货建采购单" onSubmit={async event => {
    event.preventDefault(); if (busy.current || disabled || missing || changed) return;
    try {
      const form = new FormData(event.currentTarget);
      if (!purchaseUnit || !stock) throw new Error("原采购单位或库存单位不可读取 请返回供货资料核对");
      const amount = readProcurementQuantity(quantity, purchaseUnit);
      if (compareStockQuantity(amount, link.terms.minimumOrderQuantity) < 0) throw new Error("采购数量低于原供货起订量 请核对采购单位和数量");
      pinProcurementStockBasis({ quantity: amount, unit: purchaseUnit, ...(link.terms.priceBasisQuantity === undefined ? {} : { priceBasisQuantity: link.terms.priceBasisQuantity }) }, stock.baseUnit);
      procurementAmountMinor(amount, link.terms.unitCostMinor!, link.terms.priceBasisQuantity ?? 1);
      const original = frozen ?? PrepareProcurementCommandSchema.parse({ kind: "supply_purchase_create", targetId: link.id,
        input: { expectedVersion: link.currentVersion, purpose, code: formText(form, "code").toUpperCase(), destinationLocationId: location,
          quantity: amount, expectedAt: formDate(form, "expectedAt"), idempotencyKey: key } });
      busy.current = true; setWorking(true); setError("");
      try { await onPrepare(original); } catch (failure) { if (failure instanceof ProcurementCommandRequestError && (failure.status === 0 || failure.status >= 500)) setFrozen(original); throw failure; }
    } catch (failure) { if (active.current && !procurementCommandDenied(failure)) setError(failure instanceof ProcurementCommandRequestError ? failure.message : procurementPrecisionMessage(failure, "请核对采购用途、数量、采购单位、收货库位和日期")); }
    finally { busy.current = false; if (active.current) setWorking(false); }
  }}><h3>按商品供货建采购单</h3><p className="record-help">先保存原填写 核对后创建采购草稿 单价、物料、供应商与币种绑定原供货版本</p>
    {missing && <p className="record-notice error" role="alert">原供货资料或物料不可读取 或尚未填写采购单价 请返回供货资料核对</p>}
    {changed && <p className="record-notice error" role="alert">供货报价版本已变化 请返回供货资料重新选择 原填写不会自动改用新价格</p>}
    {error && <p className="record-notice error" role="alert">{error}</p>}
    {frozen && <p className="record-notice" role="status">保存结果待核对 已固定本次原填写 请读取原提交 或重试同一笔提交</p>}
    {!missing && <fieldset className="record-fields" disabled={disabled || working || changed} inert={Boolean(frozen)} aria-disabled={Boolean(frozen)}>
      <p className="record-notice">{link.productName} · {link.skuCode ?? "产品通用"} · {link.supplierName}<br />报价 {link.terms.currency} {formatMinorAmount(link.terms.unitCostMinor!, link.terms.currency)} / {formatStockQuantity(link.terms.priceBasisQuantity ?? 1)} {purchaseUnit ? unitNames[purchaseUnit] : "采购单位待核对"} · 报价 v{link.currentVersion}<br />起订 {formatStockQuantity(link.terms.minimumOrderQuantity)} {purchaseUnit ? unitNames[purchaseUnit] : "单位待核对"}</p>
      <Field label="采购用途"><select value={purpose} onChange={event => setPurpose(event.target.value as typeof purpose)}>{link.terms.fulfillmentModes.map(mode => <option key={mode} value={mode}>{modes[mode]}</option>)}</select></Field>
      <p className="record-help">{purpose === "fba_replenishment" ? "先选择实际验收地点 供应商发到自有仓后再送 FBA 的 先收至自有仓 FBA 在途与平台接收另行跟踪" : "本草稿记录定制生产的采购费用 买家定制信息、设计确认和逐单生产进度在订单履约中处理"}</p>
      <div className="record-grid"><Field label="采购单号"><input name="code" required maxLength={64} defaultValue={code} pattern={"[A-Za-z0-9][A-Za-z0-9._\\-]*"} /></Field><Field label={`采购数量（${purchaseUnit ? unitNames[purchaseUnit] : "单位待核对"}）`} help="最多9位小数 件、对和套须为整数"><input name="quantity" type="text" inputMode="decimal" autoComplete="off" required maxLength={41} value={quantity} onChange={event => setQuantity(event.target.value)} /></Field><Field label="预计到货时间"><input name="expectedAt" type="datetime-local" required defaultValue={localDateTime(new Date(Date.now() + (link.terms.leadTimeDays ?? 7) * 86400000))} /></Field></div>
      <RecordSelect label="收货库位" value={location} onChange={setLocation} options={locations.map(row => ({ id: row.id, label: `${data.warehouses.find(warehouse => warehouse.id === row.warehouseId)?.name ?? "仓库"} / ${row.name} · ${row.code}` }))} onCreate={() => setCreating(true)} />
      {preview && purchaseUnit && <ProcurementMeasure quantity={readProcurementQuantity(quantity, purchaseUnit)} unit={purchaseUnit} stockBasis={preview} />}
      <p className="record-totals">预计金额 {total === null ? "核对数量和原计价依据后计算" : `${link.terms.currency} ${formatMinorAmount(total, link.terms.currency)}`}</p>
      {precisionError && <p className="record-notice error" role="alert">{precisionError}</p>}
    </fieldset>}
    <footer><button type="button" data-record-cancel disabled={working} onClick={onClose}>返回供货资料</button><button className="primary" type="submit" disabled={disabled || working || missing || changed}><Check size={14} />{working ? "正在保存原填写" : frozen ? "重试保存同一笔原提交" : "保存原填写并核对"}</button></footer>
  </form>{creating && <MasterRecordDialog kind="location" warehouses={data.warehouses} onClose={() => setCreating(false)} onSaved={saved => { setExtraLocations(rows => [...rows, saved as unknown as ProductSupplyWorkspace["locations"][number]]); setLocation(String(saved.id)); setCreating(false); }} />}</>;
}
