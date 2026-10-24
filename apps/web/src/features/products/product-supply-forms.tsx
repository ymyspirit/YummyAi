"use client";

import { useState } from "react";
import type { ProductSupplyView, ProductSupplyWorkspace } from "@yummyai/contracts/catalog/product-supply";
import { Field, RecordDialog, RecordForm, RecordSelect } from "../manual-operations/record-form";
import { MasterRecordDialog, mergeRecords, type MasterKind } from "../manual-operations/master-record-dialog";
import { formDate, formText, localDateTime, moneyMinor, unitNames } from "../manual-operations/operation-types";

import { ProcurementSupplyPurchaseDialog } from "../procurement/procurement-command-supply-dialog";
import { formatMinorAmount } from "@yummyai/contracts/common/money";
import { stockQuantityString } from "@yummyai/contracts/inventory/quantity";
import { pinProcurementStockBasis, type ProcurementUnit } from "@yummyai/contracts/procurement/measurement";
import { readProcurementQuantity, procurementPrecisionMessage } from "../procurement/procurement-cycle-form";

type Saved = (record: Record<string, unknown>) => void;
const modes = { custom_order: "定制订单", fba_replenishment: "FBA 备货" };

export function ProductSupplyEditor({ data, link, productPlanId, supplierId, onClose, onSaved }: {
  data: ProductSupplyWorkspace; link?: ProductSupplyView; productPlanId?: string; supplierId?: string; onClose: () => void; onSaved: Saved;
}) {
  const [product, setProduct] = useState(link?.productPlanId ?? productPlanId ?? "");
  const [supplier, setSupplier] = useState(link?.supplierId ?? supplierId ?? "");
  const [sku, setSku] = useState(link?.skuId ?? "");
  const [stock, setStock] = useState(link?.terms.stockItemId ?? "");
  const [currency, setCurrency] = useState(link?.terms.currency ?? data.suppliers.find(item => item.id === (supplierId ?? ""))?.settlementCurrency ?? "CNY");
  const [cost, setCost] = useState(link?.terms.unitCostMinor == null ? "" : formatMinorAmount(link.terms.unitCostMinor, link.terms.currency));
  const [minimum, setMinimum] = useState(stockQuantityString(link?.terms.minimumOrderQuantity ?? 1));
  const [purchaseUnit, setPurchaseUnit] = useState<ProcurementUnit | "">(link?.terms.purchaseUnit ?? "");
  const [priceBasis, setPriceBasis] = useState(link?.terms.priceBasisQuantity === undefined ? "" : stockQuantityString(link.terms.priceBasisQuantity));
  const [measureNotice, setMeasureNotice] = useState("");
  const [extraProducts, setExtraProducts] = useState<ProductSupplyWorkspace["products"]>([]);
  const [extraSuppliers, setExtraSuppliers] = useState<ProductSupplyWorkspace["suppliers"]>([]);
  const [extraStock, setExtraStock] = useState<ProductSupplyWorkspace["stockItems"]>([]);
  const [creating, setCreating] = useState<MasterKind | "product">();
  const [fulfillmentModes, setFulfillmentModes] = useState(link?.terms.fulfillmentModes ?? ["custom_order"]);
  const products = mergeRecords(data.products, extraProducts);
  const suppliers = mergeRecords(data.suppliers, extraSuppliers);
  const stocks = mergeRecords(data.stockItems, extraStock);
  const selectedProduct = products.find((item) => item.id === product);
  const terms = link?.terms;
  const selectedStock = stocks.find(item => item.id === stock), unit = purchaseUnit || selectedStock?.baseUnit;
  const units: ProcurementUnit[] = selectedStock ? ["gram", "kilogram"].includes(selectedStock.baseUnit) ? ["gram", "kilogram"] : [selectedStock.baseUnit] : ["each", "pair", "set", "meter", "gram", "kilogram"];
  const changeCurrency = (next: string) => { if (next !== currency) { setCost(""); setMeasureNotice("币种已变化 已清空原报价金额 请按新币种重新填写"); } setCurrency(next); };
  const selectStock = (id: string, newStock = stocks.find(item => item.id === id)) => {
    const nextUnit = newStock?.baseUnit;
    if (unit && nextUnit && unit !== nextUnit) { setCost(""); setMinimum(""); setPriceBasis(""); setMeasureNotice("库存物料单位已变化 已清空原数量和报价金额 请重新核对采购单位"); }
    setStock(id); setPurchaseUnit(nextUnit ?? "");
  };
  const title = link ? "维护供货与报价" : supplierId ? "关联产品" : "关联供应商";
  return <><RecordDialog title={title} onClose={onClose}>
    <RecordForm operation={link ? "supply.revise" : "supply.create"} id={link?.id} onCancel={onClose} onSaved={onSaved} submitLabel="保存供货资料"
      description={link ? "每次保存都会建立新版本，已有采购单保留原报价。" : "先选择产品和供应商，再登记双方约定的规格与供货条件。"}
      build={(form) => {
        if (!fulfillmentModes.length) throw new Error("请至少选择一种供货用途。");
        if (!unit) throw new Error("请明确采购单位 再填写起订量和报价");
        const minimumOrderQuantity = readProcurementQuantity(minimum, unit), priceBasisQuantity = priceBasis ? readProcurementQuantity(priceBasis, unit) : undefined;
        try { if (selectedStock) pinProcurementStockBasis({ quantity: minimumOrderQuantity, unit, ...(priceBasisQuantity === undefined ? {} : { priceBasisQuantity }) }, selectedStock.baseUnit); }
        catch (failure) { throw new Error(procurementPrecisionMessage(failure)); }
        const nextTerms = {
          fulfillmentModes, supplierCode: formText(form, "supplierCode"), purchaseUrl: formText(form, "purchaseUrl"),
          specifications: formText(form, "specifications"), process: formText(form, "process"), stockItemId: stock || null,
          unitCostMinor: cost ? moneyMinor(cost, currency) : null,
          currency, minimumOrderQuantity, purchaseUnit: unit, ...(priceBasisQuantity === undefined ? {} : { priceBasisQuantity }),
          leadTimeDays: formText(form, "leadTime") ? Number(formText(form, "leadTime")) : null,
          validFrom: formDate(form, "validFrom"), validUntil: formText(form, "validUntil") ? formDate(form, "validUntil") : null,
          status: formText(form, "status"), preference: formText(form, "preference"), sampleStatus: formText(form, "sampleStatus"), notes: formText(form, "notes"),
        };
        return link ? { expectedVersion: link.currentVersion, terms: nextTerms } : { productPlanId: product, supplierId: supplier, skuId: sku || null, terms: nextTerms };
      }}>
      {measureNotice && <p className="record-notice" role="status">{measureNotice}</p>}
      {link ? <p className="record-notice">{link.productName} · {link.supplierName} · {link.skuCode ?? "产品通用"} · V{link.currentVersion}</p> : <>
        {productPlanId ? <p>产品：{selectedProduct?.name}</p> : <RecordSelect label="产品" value={product} onChange={(id) => { setProduct(id); setSku(""); setStock(""); setPurchaseUnit(""); setCost(""); setPriceBasis(""); setMinimum(""); setMeasureNotice("产品已变化 请重新核对库存物料与采购报价"); }} options={products.filter((item) => item.status !== "archived").map((item) => ({ id: item.id, label: item.name }))} onCreate={() => setCreating("product")} />}
        {supplierId ? <p>供应商：{suppliers.find((item) => item.id === supplier)?.name}</p> : <RecordSelect label="供应商" value={supplier} onChange={id => { setSupplier(id); changeCurrency(suppliers.find(item => item.id === id)?.settlementCurrency ?? "CNY"); }} options={suppliers.filter((item) => item.status === "active").map((item) => ({ id: item.id, label: item.name }))} onCreate={() => setCreating("supplier")} />}
        <RecordSelect label="供货 SKU" value={sku} onChange={(id) => { setSku(id); setStock(""); setPurchaseUnit(""); setCost(""); setPriceBasis(""); setMinimum(""); setMeasureNotice("供货SKU已变化 请重新核对物料与采购单位"); }} options={(selectedProduct?.skus ?? []).map((item) => ({ id: item.id, label: `${item.code} ${Object.values(item.attributes).join(" / ")}` }))} required={false} emptyLabel="产品通用（尚未细分 SKU）" />
      </>}
      <div className="supply-mode-fields"><span>供货用途</span>{Object.entries(modes).map(([value, label]) => <label key={value}><input type="checkbox" checked={fulfillmentModes.includes(value as typeof fulfillmentModes[number])} onChange={(event) => setFulfillmentModes((current) => event.target.checked ? [...current, value as typeof fulfillmentModes[number]] : current.filter((mode) => mode !== value))} />{label}</label>)}</div>
      <div className="record-grid"><Field label="供应商货号"><input name="supplierCode" maxLength={200} defaultValue={terms?.supplierCode} /></Field><Field label="加工工艺"><input name="process" maxLength={200} placeholder="如刺绣、UV 打印、热转印" defaultValue={terms?.process} /></Field></div>
      <Field label="供货规格 / 定制范围"><textarea name="specifications" maxLength={2000} rows={2} placeholder="材质、尺寸、可定制位置、包装要求等" defaultValue={terms?.specifications} /></Field>
      <Field label="采购链接"><input type="url" name="purchaseUrl" maxLength={2000} placeholder="https://…" defaultValue={terms?.purchaseUrl} /></Field>
      <RecordSelect label="库存物料" value={stock} onChange={id => selectStock(id)} options={stocks.filter((item) => (item.status === "active" && (!item.skuId || item.skuId === sku)) || item.id === stock).map((item) => ({ id: item.id, label: `${item.name} · ${item.code} · ${unitNames[item.baseUnit]}` }))} required={false} emptyLabel="暂不关联（创建采购前需补齐）" onCreate={() => setCreating("stock")} />
      <div className="record-grid"><Field label="采购单位" help="只支持同单位或克与千克换算"><select required value={unit ?? ""} onChange={event => { setPurchaseUnit(event.target.value as ProcurementUnit); setMinimum(""); setPriceBasis(""); setCost(""); setMeasureNotice("采购单位已变化 已清空原起订量和报价 请重新核对"); }}><option value="">请选择采购单位</option>{[...new Set([...units, ...(unit ? [unit] : [])])].map(value => <option key={value} value={value}>{unitNames[value]}</option>)}</select></Field><Field label="采购单价" help="此金额对应下方计价数量 可先留空"><input type="text" inputMode="decimal" name="cost" maxLength={40} value={cost} onChange={event => setCost(event.target.value)} /></Field><Field label="报价币种"><select name="currency" value={currency} onChange={event => changeCurrency(event.target.value)}>{[...new Set([currency, "CNY", "USD", "EUR", "GBP", "CAD", "AUD", "JPY", "KWD"])].map(value => <option key={value}>{value}</option>)}</select></Field>
        <Field label={`计价数量（${unit ? unitNames[unit] : "单位待选"}）`} help="留空按1计算"><input type="text" inputMode="decimal" maxLength={41} placeholder="1" value={priceBasis} onChange={event => setPriceBasis(event.target.value)} /></Field><Field label="起订量" help={`采购单位 ${unit ? unitNames[unit] : "待核对"} 最多9位小数`}><input name="moq" type="text" inputMode="decimal" required maxLength={41} value={minimum} onChange={event => setMinimum(event.target.value)} /></Field><Field label="交期（天）"><input name="leadTime" type="number" min="0" max="3650" defaultValue={terms?.leadTimeDays ?? ""} /></Field>
        <Field label="报价生效时间"><input name="validFrom" type="datetime-local" required defaultValue={localDateTime(terms ? new Date(terms.validFrom) : new Date())} /></Field><Field label="报价截止时间"><input name="validUntil" type="datetime-local" defaultValue={terms?.validUntil ? localDateTime(new Date(terms.validUntil)) : ""} /></Field>
        <Field label="供货状态"><select name="status" defaultValue={terms?.status ?? "active"}><option value="active">供货中</option><option value="paused">暂停供货</option><option value="discontinued">停止供货</option></select></Field>
        <Field label="供货优先级" help="每个产品规格最多设置一个主供供应商。"><select name="preference" defaultValue={terms?.preference ?? "alternative"}><option value="alternative">备选</option><option value="primary">主供</option></select></Field>
        <Field label="验样状态"><select name="sampleStatus" defaultValue={terms?.sampleStatus ?? "untested"}><option value="untested">未验样</option><option value="passed">验样通过</option><option value="failed">验样未通过</option></select></Field>
      </div>
      {selectedStock && unit && <p className="procurement-measure-check"><span>采购单位 {unitNames[unit]}</span><span>库存基本单位 {unitNames[selectedStock.baseUnit]} · 起订量 {minimum || "待填写"} {unitNames[unit]} · 计价 {priceBasis || "按1计算"} {unitNames[unit]}</span></p>}
      <Field label="供货备注"><textarea name="notes" rows={2} maxLength={4000} defaultValue={terms?.notes} /></Field>
    </RecordForm>
  </RecordDialog>
    {creating === "product" && <RecordDialog title="新增产品" onClose={() => setCreating(undefined)}><RecordForm operation="product.create" onCancel={() => setCreating(undefined)} submitLabel="保存产品" onSaved={(saved) => { setExtraProducts((current) => [...current, { id: String(saved.id), name: String(saved.name), status: "researching", skus: [] }]); setProduct(String(saved.id)); setSku(""); setStock(""); setCreating(undefined); }} build={(form) => ({ name: formText(form, "name"), description: formText(form, "description"), sourceReportIds: [], customization: { version: 1, fields: [] } })}>
      <Field label="产品名称"><input name="name" required maxLength={200} /></Field><Field label="产品描述"><textarea name="description" maxLength={2000} /></Field>
    </RecordForm></RecordDialog>}
    {creating && creating !== "product" && <MasterRecordDialog kind={creating} onClose={() => setCreating(undefined)} onSaved={(saved) => {
      if (creating === "supplier") { setExtraSuppliers((current) => [...current, saved as unknown as ProductSupplyWorkspace["suppliers"][number]]); setSupplier(String(saved.id)); changeCurrency(String(saved.settlementCurrency)); }
      if (creating === "stock") { const item = saved as unknown as ProductSupplyWorkspace["stockItems"][number]; setExtraStock((current) => [...current, item]); selectStock(item.id, item); }
      setCreating(undefined);
    }} />}
  </>;
}

export function SupplyPurchaseDialog({ data, link, onClose, onSaved }: { data: ProductSupplyWorkspace; link: ProductSupplyView; onClose: () => void; onSaved: Saved }) {
  return <ProcurementSupplyPurchaseDialog data={data} link={link} onClose={onClose} onSaved={onSaved} />;
}
