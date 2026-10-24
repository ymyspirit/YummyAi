"use client";

import type { InventoryWorkspaceView, InventoryLocationView, InventoryStockItemView } from "@yummyai/contracts/inventory";
import { Plus, ClipboardPen, PackagePlus, History } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { compareStockQuantity, stockQuantityMatchesUnit, stockQuantityValue, stockQuantityWithinCommandLimit } from "@yummyai/contracts/inventory/quantity";
import { MasterRecordDialog, masterNames, mergeRecords, type MasterKind } from "../manual-operations/master-record-dialog";
import { Field, RecordDialog, RecordForm, RecordSelect } from "../manual-operations/record-form";
import { formDate, formText, localDateTime, unitNames, materialKindNames } from "../manual-operations/operation-types";
import { StockClassificationDialog } from "./stock-classification-dialog";

export function InventoryOperations({ data }: { data: InventoryWorkspaceView }) {
  const [master, setMaster] = useState<{ kind: MasterKind; record?: Record<string, unknown> }>();
  const [movement, setMovement] = useState<"opening" | "adjustment">();
  const [classification, setClassification] = useState<InventoryStockItemView>();
  const [message, setMessage] = useState("");
  const router = useRouter();
  const saved = (record: Record<string, unknown>) => { setMessage(`${record.name ?? "资料"}已保存。`); setMaster(undefined); router.refresh(); };
  const rows = [
    ...data.warehouses.map((record) => ({ kind: "warehouse" as const, record, detail: `${record.countryCode ?? "未指定国家"} · ${record.timeZone}` })),
    ...data.locations.map((record) => ({ kind: "location" as const, record, detail: data.warehouses.find((warehouse) => warehouse.id === record.warehouseId)?.name ?? record.code })),
    ...data.stockItems.map((record) => ({ kind: "stock" as const, record, detail: `${record.classification ? materialKindNames[record.classification.kind] : "待分类"} · ${unitNames[record.baseUnit]}` })),
  ];
  return <>
    <div className="record-toolbar">{(["warehouse", "location", "stock"] as const).map((kind) => <button key={kind} onClick={() => setMaster({ kind })}><Plus size={15} />新增{masterNames[kind]}</button>)}
      <button className="primary" onClick={() => setMovement("opening")}><PackagePlus size={15} />期初入库</button><button onClick={() => setMovement("adjustment")}><ClipboardPen size={15} />库存调整</button>
    </div>
    {message && <p className="record-notice success" role="status">{message}</p>}
    <details className="record-master-list" open={data.balances.length === 0}><summary>仓库、库位与物料 · {rows.length} 条档案</summary>
      {rows.length ? <div className="record-table-scroll"><table className="record-table"><thead><tr><th>类型</th><th>名称 / 编码</th><th>所属 / 单位</th><th>操作</th></tr></thead><tbody>{rows.map(({ kind, record, detail }) => <tr key={record.id}><td>{masterNames[kind]}</td><td>{record.name}<small>{record.code}</small></td><td>{detail}</td><td><button aria-label={`编辑${masterNames[kind]} ${record.name}`} onClick={() => setMaster({ kind, record: { ...record } })}>编辑资料</button>{kind === "stock" && <button className="stock-classification-open" aria-label={`分类与历史 ${record.name}`} onClick={() => setClassification(record)}><History size={14} />分类与历史</button>}</td></tr>)}</tbody></table></div> : <p className="record-help">先新增仓库和库位，再新增物料并登记期初库存。</p>}
    </details>
    {master && <MasterRecordDialog {...master} warehouses={data.warehouses} onClose={() => { setMaster(undefined); router.refresh(); }} onSaved={saved} />}
    {classification && <StockClassificationDialog stock={classification} onClose={() => setClassification(undefined)} onSaved={() => { setMessage("物料分类已保存"); setClassification(undefined); router.refresh(); }} />}
    {movement && <MovementDialog data={data} type={movement} onClose={() => { setMovement(undefined); router.refresh(); }} onSaved={() => { setMessage(movement === "opening" ? "期初库存已登记。" : "库存调整已记录，余额已更新。"); setMovement(undefined); router.refresh(); }} />}
  </>;
}

function MovementDialog({ data, type, onClose, onSaved }: { data: InventoryWorkspaceView; type: "opening" | "adjustment"; onClose: () => void; onSaved: () => void }) {
  const [stockId, setStockId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [lotId, setLotId] = useState("");
  const [newKind, setNewKind] = useState<"stock" | "location">();
  const [extras, setExtras] = useState<{ stock: InventoryStockItemView[]; locations: InventoryLocationView[] }>({ stock: [], locations: [] });
  const stock = mergeRecords(data.stockItems, extras.stock).filter((item) => item.status === "active");
  const locations = mergeRecords(data.locations, extras.locations).filter((item) => item.status === "active");
  const item = stock.find((record) => record.id === stockId);
  const balance = data.balances.find((row) => row.stockItemId === stockId && row.locationId === locationId && row.lotId === (lotId || null));
  const title = type === "opening" ? "期初入库" : "库存调整";
  const [occurredAt] = useState(() => localDateTime());
  return <>
    <RecordDialog title={title} onClose={onClose} protectEdits><RecordForm operation="movement.create" onCancel={onClose} onSaved={onSaved} submitLabel={`确认${title}`}
      description={type === "opening" ? "登记开始使用系统时的实际库存。采购到货请从采购单登记收货。" : "填写本次增加或减少的数量及原因，系统保留调整流水。"}
      build={(form) => {
        let quantity;
        try { quantity = stockQuantityValue(formText(form, "quantityDelta")); }
        catch { throw new Error("数量请填写整数或最多 9 位小数 不使用科学计数法"); }
        if (!stockQuantityWithinCommandLimit(quantity)) throw new Error("数量绝对值不能超过 2147483647");
        if (!stockQuantityMatchesUnit(quantity, item?.baseUnit ?? "each")) throw new Error("件、对和套的数量必须是整数");
        if (compareStockQuantity(quantity, 0) === 0) throw new Error("变动数量不能为 0");
        if (type === "opening" && compareStockQuantity(quantity, 0) <= 0) throw new Error("期初数量必须大于 0");
        return { stockItemId: stockId, locationId, lotId: lotId || null, unit: item?.baseUnit, type, bucket: "physical", quantityDelta: quantity,
          occurredAt: formDate(form, "occurredAt"), sourceType: type === "opening" ? "opening" : "adjustment", sourceId: formText(form, "reason"), reasonCode: type === "opening" ? "MANUAL_OPENING" : "MANUAL_ADJUSTMENT" };
      }}>
      <div className="record-grid"><RecordSelect label="物料" value={stockId} onChange={(id) => { setStockId(id); setLotId(""); }} options={stock.map((row) => ({ id: row.id, label: `${row.name} · ${row.code}` }))} onCreate={() => setNewKind("stock")} />
        <RecordSelect label="库位" value={locationId} onChange={setLocationId} options={locations.map((row) => ({ id: row.id, label: `${data.warehouses.find((warehouse) => warehouse.id === row.warehouseId)?.name ?? "仓库"} / ${row.name} · ${row.code}` }))} onCreate={() => setNewKind("location")} /></div>
      <RecordSelect label="批次" required={false} value={lotId} onChange={setLotId} options={data.lots.filter((lot) => lot.stockItemId === stockId).map((lot) => ({ id: lot.id, label: lot.code }))} />
      <div className="record-grid"><Field label={type === "opening" ? "期初数量" : "变动数量"} help={`单位：${item ? unitNames[item.baseUnit] : "请先选择物料"}。件、对和套填写整数，米和重量可填写小数。${type === "adjustment" ? "增加填正数，减少填负数。" : ""}`}><input name="quantityDelta" required type="text" inputMode="decimal" autoComplete="off" maxLength={41} placeholder={item && ["each", "pair", "set"].includes(item.baseUnit) ? "例如 10" : "例如 1.05"} /></Field>
        <Field label="发生时间"><input name="occurredAt" type="datetime-local" required defaultValue={occurredAt} /></Field></div>
      {stockId && locationId && <p className="record-help">当前所选维度实物库存：{balance?.physicalQuantity ?? 0}；已预占：{balance?.reservedQuantity ?? 0}。</p>}
      <Field label="记录原因"><input name="reason" required maxLength={200} placeholder={type === "opening" ? "例如：首次建账盘点" : "例如：盘点差异、破损或补录"} /></Field>
    </RecordForm></RecordDialog>
    {newKind && <MasterRecordDialog kind={newKind} warehouses={data.warehouses} onClose={() => setNewKind(undefined)} onSaved={(saved) => {
      if (newKind === "stock") { setExtras((value) => ({ ...value, stock: [...value.stock, saved as unknown as InventoryStockItemView] })); setStockId(String(saved.id)); setLotId(""); }
      else { setExtras((value) => ({ ...value, locations: [...value.locations, saved as unknown as InventoryLocationView] })); setLocationId(String(saved.id)); }
      setNewKind(undefined);
    }} />}
  </>;
}
