"use client";

import { useEffect, useState } from "react";
import type { InventoryWarehouseView } from "@yummyai/contracts/inventory";
import { Field, RecordDialog, RecordForm, RecordSelect } from "./record-form";
import { formText, unitNames, materialKindNames } from "./operation-types";
import { loadWarehouseChoices } from "./operation-actions";
import { SupplierProfileSchema } from "@yummyai/contracts/suppliers/supplier-profile";
import { SupplierProfileFields, supplierProfileFromForm } from "./business-profile-fields";

export type MasterKind = "supplier" | "warehouse" | "location" | "stock";
export const masterNames = { supplier: "供应商", warehouse: "仓库", location: "库位", stock: "物料" };

export function MasterRecordDialog({ kind, record, warehouses, onClose, onSaved }: {
  kind: MasterKind; record?: Record<string, unknown>; warehouses?: InventoryWarehouseView[];
  onClose: () => void; onSaved: (record: Record<string, unknown>) => void;
}) {
  const [code] = useState(() => `${({ supplier: "SUP", warehouse: "WH", location: "LOC", stock: "MAT" })[kind]}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`);
  const [warehouseId, setWarehouseId] = useState("");
  const [extraWarehouses, setExtraWarehouses] = useState<InventoryWarehouseView[]>([]);
  const [createWarehouse, setCreateWarehouse] = useState(false);
  const [loadedWarehouses, setLoadedWarehouses] = useState<InventoryWarehouseView[]>([]);
  const [warehouseError, setWarehouseError] = useState("");
  useEffect(() => {
    if (kind !== "location" || record || warehouses) return;
    let live = true;
    void loadWarehouseChoices().then((result) => { if (live) { setLoadedWarehouses(result.warehouses); setWarehouseError(result.error ?? ""); } });
    return () => { live = false; };
  }, [kind, record, warehouses]);
  const allWarehouses = mergeRecords(warehouses ?? loadedWarehouses, extraWarehouses).filter((item) => item.status === "active");
  const title = `${record ? "编辑" : "新增"}${masterNames[kind]}`;
  return <>
    <RecordDialog title={title} onClose={onClose} protectEdits={kind === "supplier"}>
      <RecordForm operation={`${kind}.${record ? "update" : "create"}`} id={record?.id as string | undefined}
        onCancel={onClose} onSaved={onSaved} submitLabel={`保存${masterNames[kind]}`}
        description={kind === "supplier" ? "仅供应商名称必填。地址、联系人及商务资料可留空或先填一部分，之后再补充。" : record ? "修改资料后，已有业务记录仍保留。编码和库存单位保持固定。" : "填写基本资料即可保存，保存后可在业务表单中选择。"}
        build={(form) => {
          const name = formText(form, "name");
          if (kind === "supplier") return { name, regionCode: formText(form, "regionCode"), settlementCurrency: formText(form, "settlementCurrency"), profile: supplierProfileFromForm(form), ...(record ? { status: formText(form, "supplier.status") } : { kind: "manual", externalConnectionRef: null }) };
          if (kind === "warehouse") return { name, countryCode: formText(form, "countryCode").toUpperCase() || null, timeZone: formText(form, "timeZone"), ...(record ? {} : { code: formText(form, "code").toUpperCase(), type: formText(form, "type") }) };
          if (record) return { name };
          if (kind === "location") return { name, code: formText(form, "code").toUpperCase(), warehouseId };
          return { name, code: formText(form, "code").toUpperCase(), baseUnit: formText(form, "baseUnit"), skuId: null, materialKind: formText(form, "materialKind") || null };
        }}>
        <Field label={`${masterNames[kind]}名称`} help={kind === "supplier" ? "必填" : undefined}><input autoFocus required name="name" maxLength={200} defaultValue={String(record?.name ?? "")} /></Field>
        {kind !== "supplier" && !record && <Field label={`${masterNames[kind]}编码`} help="已自动生成，可改为已有业务编码；支持字母、数字、点、横线和下划线。"><input name="code" required maxLength={64} defaultValue={code} /></Field>}
        {kind === "stock" && !record && <Field label="物料分类" help="尚未核实可暂不分类，分类本身不代表收货检验通过"><select name="materialKind" defaultValue=""><option value="">待分类</option>{Object.entries(materialKindNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></Field>}
        {kind === "supplier" && <div className="record-grid">
          <Field label="所在地区" help="选填"><input name="regionCode" maxLength={40} defaultValue={String(record?.regionCode ?? "")} placeholder="例如 CN、US 或所在地区" /></Field>
          <Field label="结算币种"><CurrencySelect name="settlementCurrency" defaultValue={String(record?.settlementCurrency ?? "CNY")} /></Field>
        </div>}
        {kind === "supplier" && <>{record && <Field label="供应商状态"><select name="supplier.status" defaultValue={String(record.status ?? "active")}><option value="active">启用</option><option value="suspended">暂停</option><option value="archived">归档</option></select></Field>}<SupplierProfileFields profile={SupplierProfileSchema.parse(record?.profile ?? {})} /></>}
        {kind === "warehouse" && <div className="record-grid">
          {!record && <Field label="仓库类型"><select name="type"><option value="owned">自有仓库</option><option value="third_party">第三方仓库</option><option value="supplier">供应商仓库</option><option value="fba">FBA 仓库档案</option><option value="virtual">虚拟仓</option></select></Field>}
          <Field label="国家代码" help="可留空；填写两位代码，例如 CN 或 US。"><input name="countryCode" maxLength={2} pattern="[A-Za-z]{2}" defaultValue={String(record?.countryCode ?? "CN")} /></Field>
          <Field label="仓库时区"><select name="timeZone" defaultValue={String(record?.timeZone ?? "Asia/Shanghai")}>{[...new Set([String(record?.timeZone ?? "Asia/Shanghai"), "Asia/Shanghai", "America/Los_Angeles", "America/New_York", "Europe/London", "Europe/Berlin", "Asia/Tokyo", "UTC"])].map((zone) => <option key={zone}>{zone}</option>)}</select></Field>
        </div>}
        {kind === "location" && !record && <>{warehouseError && <p className="record-notice error" role="alert">{warehouseError}</p>}<RecordSelect label="仓库" value={warehouseId} onChange={setWarehouseId} options={allWarehouses.map((item) => ({ id: item.id, label: `${item.name} · ${item.code}` }))} onCreate={() => setCreateWarehouse(true)} /></>}
        {kind === "stock" && !record && <Field label="库存单位" help="件、双、套按整数计量，米、克、千克支持精确小数"><select name="baseUnit">{Object.entries(unitNames).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field>}
      </RecordForm>
    </RecordDialog>
    {createWarehouse && <MasterRecordDialog kind="warehouse" onClose={() => setCreateWarehouse(false)} onSaved={(saved) => {
      const warehouse = saved as unknown as InventoryWarehouseView;
      setExtraWarehouses((current) => [...current, warehouse]); setWarehouseId(warehouse.id); setCreateWarehouse(false);
    }} />}
  </>;
}

export function CurrencySelect({ name = "currency", defaultValue = "CNY", onChange }: { name?: string; defaultValue?: string; onChange?: (value: string) => void }) {
  return <select name={name} defaultValue={defaultValue} onChange={(event) => onChange?.(event.target.value)}>{[...new Set([defaultValue, "CNY", "USD", "EUR", "GBP", "CAD", "AUD"])].map((value) => <option key={value}>{value}</option>)}</select>;
}

export function mergeRecords<T extends { id: string }>(base: T[], extra: T[]): T[] {
  return [...new Map([...base, ...extra].map((record) => [record.id, record])).values()];
}
