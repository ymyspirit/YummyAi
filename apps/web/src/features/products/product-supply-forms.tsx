"use client";

import { useState } from "react";
import type { ProductSupplyView, ProductSupplyWorkspace } from "@yummyai/contracts/catalog/product-supply";
import { Field, RecordDialog, RecordForm, RecordSelect } from "../manual-operations/record-form";
import { CurrencySelect, MasterRecordDialog, mergeRecords, type MasterKind } from "../manual-operations/master-record-dialog";
import { formDate, formText, localDateTime, moneyMinor, unitNames } from "../manual-operations/operation-types";

type Saved = (record: Record<string, unknown>) => void;
const modes = { custom_order: "定制订单", fba_replenishment: "FBA 备货" };

export function ProductSupplyEditor({ data, link, productPlanId, supplierId, onClose, onSaved }: {
  data: ProductSupplyWorkspace; link?: ProductSupplyView; productPlanId?: string; supplierId?: string; onClose: () => void; onSaved: Saved;
}) {
  const [product, setProduct] = useState(link?.productPlanId ?? productPlanId ?? "");
  const [supplier, setSupplier] = useState(link?.supplierId ?? supplierId ?? "");
  const [sku, setSku] = useState(link?.skuId ?? "");
  const [stock, setStock] = useState(link?.terms.stockItemId ?? "");
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
  const title = link ? "维护供货与报价" : supplierId ? "关联产品" : "关联供应商";
  return <><RecordDialog title={title} onClose={onClose}>
    <RecordForm operation={link ? "supply.revise" : "supply.create"} id={link?.id} onCancel={onClose} onSaved={onSaved} submitLabel="保存供货资料"
      description={link ? "每次保存都会建立新版本，已有采购单保留原报价。" : "先选择产品和供应商，再登记双方约定的规格与供货条件。"}
      build={(form) => {
        if (!fulfillmentModes.length) throw new Error("请至少选择一种供货用途。");
        const nextTerms = {
          fulfillmentModes, supplierCode: formText(form, "supplierCode"), purchaseUrl: formText(form, "purchaseUrl"),
          specifications: formText(form, "specifications"), process: formText(form, "process"), stockItemId: stock || null,
          unitCostMinor: formText(form, "cost") ? moneyMinor(formText(form, "cost")) : null,
          currency: formText(form, "currency"), minimumOrderQuantity: Number(formText(form, "moq")),
          leadTimeDays: formText(form, "leadTime") ? Number(formText(form, "leadTime")) : null,
          validFrom: formDate(form, "validFrom"), validUntil: formText(form, "validUntil") ? formDate(form, "validUntil") : null,
          status: formText(form, "status"), preference: formText(form, "preference"), sampleStatus: formText(form, "sampleStatus"), notes: formText(form, "notes"),
        };
        return link ? { expectedVersion: link.currentVersion, terms: nextTerms } : { productPlanId: product, supplierId: supplier, skuId: sku || null, terms: nextTerms };
      }}>
      {link ? <p className="record-notice">{link.productName} · {link.supplierName} · {link.skuCode ?? "产品通用"} · V{link.currentVersion}</p> : <>
        {productPlanId ? <p>产品：{selectedProduct?.name}</p> : <RecordSelect label="产品" value={product} onChange={(id) => { setProduct(id); setSku(""); setStock(""); }} options={products.filter((item) => item.status !== "archived").map((item) => ({ id: item.id, label: item.name }))} onCreate={() => setCreating("product")} />}
        {supplierId ? <p>供应商：{suppliers.find((item) => item.id === supplier)?.name}</p> : <RecordSelect label="供应商" value={supplier} onChange={setSupplier} options={suppliers.filter((item) => item.status === "active").map((item) => ({ id: item.id, label: item.name }))} onCreate={() => setCreating("supplier")} />}
        <RecordSelect label="供货 SKU" value={sku} onChange={(id) => { setSku(id); setStock(""); }} options={(selectedProduct?.skus ?? []).map((item) => ({ id: item.id, label: `${item.code} ${Object.values(item.attributes).join(" / ")}` }))} required={false} emptyLabel="产品通用（尚未细分 SKU）" />
      </>}
      <div className="supply-mode-fields"><span>供货用途</span>{Object.entries(modes).map(([value, label]) => <label key={value}><input type="checkbox" checked={fulfillmentModes.includes(value as typeof fulfillmentModes[number])} onChange={(event) => setFulfillmentModes((current) => event.target.checked ? [...current, value as typeof fulfillmentModes[number]] : current.filter((mode) => mode !== value))} />{label}</label>)}</div>
      <div className="record-grid"><Field label="供应商货号"><input name="supplierCode" maxLength={200} defaultValue={terms?.supplierCode} /></Field><Field label="加工工艺"><input name="process" maxLength={200} placeholder="如刺绣、UV 打印、热转印" defaultValue={terms?.process} /></Field></div>
      <Field label="供货规格 / 定制范围"><textarea name="specifications" maxLength={2000} rows={2} placeholder="材质、尺寸、可定制位置、包装要求等" defaultValue={terms?.specifications} /></Field>
      <Field label="采购链接"><input type="url" name="purchaseUrl" maxLength={2000} placeholder="https://…" defaultValue={terms?.purchaseUrl} /></Field>
      <RecordSelect label="库存物料" value={stock} onChange={setStock} options={stocks.filter((item) => (item.status === "active" && (!item.skuId || item.skuId === sku)) || item.id === stock).map((item) => ({ id: item.id, label: `${item.name} · ${item.code} · ${unitNames[item.baseUnit]}` }))} required={false} emptyLabel="暂不关联（创建采购前需补齐）" onCreate={() => setCreating("stock")} />
      <div className="record-grid"><Field label="采购单价" help={stock ? `按每${unitNames[stocks.find((item) => item.id === stock)!.baseUnit]}计价` : "可先留空；创建采购草稿前需报价。"}><input type="number" name="cost" min="0" step="0.01" defaultValue={terms?.unitCostMinor == null ? "" : (terms.unitCostMinor / 100).toFixed(2)} /></Field><Field label="报价币种"><CurrencySelect key={supplier} defaultValue={terms?.currency ?? suppliers.find((item) => item.id === supplier)?.settlementCurrency ?? "CNY"} /></Field>
        <Field label="起订量"><input name="moq" type="number" required min="1" max="2147483647" defaultValue={terms?.minimumOrderQuantity ?? 1} /></Field><Field label="交期（天）"><input name="leadTime" type="number" min="0" max="3650" defaultValue={terms?.leadTimeDays ?? ""} /></Field>
        <Field label="报价生效时间"><input name="validFrom" type="datetime-local" required defaultValue={localDateTime(terms ? new Date(terms.validFrom) : new Date())} /></Field><Field label="报价截止时间"><input name="validUntil" type="datetime-local" defaultValue={terms?.validUntil ? localDateTime(new Date(terms.validUntil)) : ""} /></Field>
        <Field label="供货状态"><select name="status" defaultValue={terms?.status ?? "active"}><option value="active">供货中</option><option value="paused">暂停供货</option><option value="discontinued">停止供货</option></select></Field>
        <Field label="供货优先级" help="每个产品规格最多设置一个主供供应商。"><select name="preference" defaultValue={terms?.preference ?? "alternative"}><option value="alternative">备选</option><option value="primary">主供</option></select></Field>
        <Field label="验样状态"><select name="sampleStatus" defaultValue={terms?.sampleStatus ?? "untested"}><option value="untested">未验样</option><option value="passed">验样通过</option><option value="failed">验样未通过</option></select></Field>
      </div>
      <Field label="供货备注"><textarea name="notes" rows={2} maxLength={4000} defaultValue={terms?.notes} /></Field>
    </RecordForm>
  </RecordDialog>
    {creating === "product" && <RecordDialog title="新增产品" onClose={() => setCreating(undefined)}><RecordForm operation="product.create" onCancel={() => setCreating(undefined)} submitLabel="保存产品" onSaved={(saved) => { setExtraProducts((current) => [...current, { id: String(saved.id), name: String(saved.name), status: "researching", skus: [] }]); setProduct(String(saved.id)); setSku(""); setStock(""); setCreating(undefined); }} build={(form) => ({ name: formText(form, "name"), description: formText(form, "description"), sourceReportIds: [], customization: { version: 1, fields: [] } })}>
      <Field label="产品名称"><input name="name" required maxLength={200} /></Field><Field label="产品描述"><textarea name="description" maxLength={2000} /></Field>
    </RecordForm></RecordDialog>}
    {creating && creating !== "product" && <MasterRecordDialog kind={creating} onClose={() => setCreating(undefined)} onSaved={(saved) => {
      if (creating === "supplier") { setExtraSuppliers((current) => [...current, saved as unknown as ProductSupplyWorkspace["suppliers"][number]]); setSupplier(String(saved.id)); }
      if (creating === "stock") { setExtraStock((current) => [...current, saved as unknown as ProductSupplyWorkspace["stockItems"][number]]); setStock(String(saved.id)); }
      setCreating(undefined);
    }} />}
  </>;
}

export function SupplyPurchaseDialog({ data, link, onClose, onSaved }: { data: ProductSupplyWorkspace; link: ProductSupplyView; onClose: () => void; onSaved: Saved }) {
  const [location, setLocation] = useState("");
  const [purpose, setPurpose] = useState(link.terms.fulfillmentModes[0]!);
  const [extraLocations, setExtraLocations] = useState<ProductSupplyWorkspace["locations"]>([]);
  const [creating, setCreating] = useState(false);
  const [code] = useState(() => `PO-${crypto.randomUUID().slice(0, 8).toUpperCase()}`);
  const [quantity, setQuantity] = useState(String(link.terms.minimumOrderQuantity));
  const stock = data.stockItems.find((item) => item.id === link.terms.stockItemId);
  const missing = !stock || link.terms.unitCostMinor === null;
  const locations = mergeRecords(data.locations, extraLocations).filter((item) => item.status === "active" && (extraLocations.some((extra) => extra.id === item.id) || data.warehouses.find((warehouse) => warehouse.id === item.warehouseId)?.status === "active"));
  return <><RecordDialog title="从供货报价创建采购草稿" onClose={onClose}>
    {missing ? <div className="supply-history"><p className="record-notice error" role="alert">请先关闭此窗口，在“维护供货 / 报价”中填写采购单价并关联库存物料。</p><button onClick={onClose}>返回供货资料</button></div> : <RecordForm operation="supply.purchase" id={link.id} onCancel={onClose} onSaved={onSaved} submitLabel="创建采购草稿" description="草稿按所选报价锁定供应商、物料、币种和单价，创建后进入采购补货审核。"
      build={(form) => ({ expectedVersion: link.currentVersion, purpose, code: formText(form, "code").toUpperCase(), destinationLocationId: location, quantity: Number(quantity), expectedAt: formDate(form, "expectedAt") })}>
      <p className="record-notice">{link.productName} · {link.skuCode ?? "产品通用"} · {link.supplierName}<br />{link.terms.currency} {(link.terms.unitCostMinor! / 100).toFixed(2)} / {unitNames[stock.baseUnit]} · 报价 V{link.currentVersion}</p>
      <Field label="采购用途"><select value={purpose} onChange={(event) => setPurpose(event.target.value as typeof purpose)}>{link.terms.fulfillmentModes.map((mode) => <option key={mode} value={mode}>{modes[mode]}</option>)}</select></Field>
      {purpose === "fba_replenishment" && <p className="record-help">先选择实际验收地点。供应商发到自有仓后再送 FBA 的，先收至自有仓；FBA 在途与平台接收需另行跟踪。</p>}
      {purpose === "custom_order" && <p className="record-help">本草稿记录定制生产所需的采购费用；买家定制信息、设计确认和逐单生产进度在订单履约中处理。</p>}
      <div className="record-grid"><Field label="采购单号"><input name="code" required maxLength={64} defaultValue={code} /></Field><Field label={`采购数量（${unitNames[stock.baseUnit]}）`}><input name="quantity" type="number" required min={link.terms.minimumOrderQuantity} max="2147483647" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></Field>
        <Field label="预计到货时间"><input name="expectedAt" type="datetime-local" required defaultValue={localDateTime(new Date(Date.now() + (link.terms.leadTimeDays ?? 7) * 86400000))} /></Field></div>
      <RecordSelect label="收货库位" value={location} onChange={setLocation} options={locations.map((item) => ({ id: item.id, label: `${data.warehouses.find((warehouse) => warehouse.id === item.warehouseId)?.name ?? "仓库"} / ${item.name} · ${item.code}` }))} onCreate={() => setCreating(true)} />
      <p>预计金额：{link.terms.currency} {(Number(quantity || 0) * link.terms.unitCostMinor! / 100).toFixed(2)}</p>
    </RecordForm>}
  </RecordDialog>{creating && <MasterRecordDialog kind="location" warehouses={data.warehouses} onClose={() => setCreating(false)} onSaved={(saved) => { setExtraLocations((current) => [...current, saved as unknown as ProductSupplyWorkspace["locations"][number]]); setLocation(String(saved.id)); setCreating(false); }} />}</>;
}
