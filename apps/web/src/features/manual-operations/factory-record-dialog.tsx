"use client";

import { useState } from "react";
import type { FactoryView, FactoryCapabilityView, FactoryDirectory } from "@yummyai/contracts/suppliers/factory-directory";
import { SHAPED_PILLOW_FACTORY_STANDARD } from "@yummyai/contracts/pod/production-editor";
import { AddressFields, ContactFields, addressFromForm, contactsFromForm } from "./business-profile-fields";
import { Field, RecordDialog, RecordForm } from "./record-form";
import { CurrencySelect } from "./master-record-dialog";
import { formText, localDateTime, moneyMinor } from "./operation-types";
import "./factory-directory.css";

const numberOrNull = (form: FormData, name: string) => formText(form, name) ? Number(formText(form, name)) : null;
const lines = (value: string) => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
export const productNames = { shaped_pillow: "异形抱枕", tire_cover: "备胎罩", rectangular_print: "平面印花", engraving: "雕刻产品", other: "其他产品" };
export const processNames = { PRINT: "印刷", CUT: "裁切", SEW: "缝制", FILL: "填充", PACK: "包装", ENGRAVE: "雕刻", EMBROIDER: "刺绣", OTHER: "其他" };
const factoryStatuses = { draft: "草稿", active: "启用", suspended: "暂停", archived: "归档" };
export function FactoryRecordDialog({ supplierId, record, onClose, onSaved, onDenied }: { supplierId: string; record?: FactoryView; onClose(): void; onSaved(): void; onDenied?(): void }) {
  const [code] = useState(() => `FAC-${crypto.randomUUID().slice(0, 8).toUpperCase()}`), profile = record?.profile;
  return <RecordDialog title={record ? "编辑工厂" : "新增工厂"} onClose={onClose} protectEdits><RecordForm operation={record ? "factory.revise" : "factory.create"} id={record?.id} onCancel={onClose} onSaved={onSaved} onDenied={onDenied} submitLabel="保存工厂"
    description="填写工厂名称即可保存草稿，编码已自动生成。地址和联系人可稍后补充；启用前须确认所属主体性质、生产加工角色、完整生产地址和可联系的生产负责人。"
    build={form => ({ ...(record ? { expectedVersion: record.versionNumber } : { supplierId, code: formText(form, "code") }), profile: {
      name: formText(form, "name"), ownership: formText(form, "ownership"), cooperationMode: formText(form, "cooperationMode"), status: formText(form, "status"),
      productionAddress: addressFromForm(form, "productionAddress"), pickupAddress: addressFromForm(form, "pickupAddress"), returnAddress: addressFromForm(form, "returnAddress"), contacts: contactsFromForm(form, "contacts"),
      timeZone: formText(form, "timeZone") || null, workingHours: formText(form, "workingHours"), cutoffTime: formText(form, "cutoffTime"), fulfillmentModes: form.getAll("fulfillmentModes"), notes: formText(form, "notes"),
    } })}>
    <Field label="工厂名称" help="必填"><input required name="name" maxLength={200} defaultValue={profile?.name ?? ""} /></Field><div className="record-grid">
      {!record && <Field label="工厂编码" help="已自动生成，可按实际业务修改。"><input required name="code" maxLength={64} defaultValue={code} /></Field>}
      <Field label="工厂性质"><select name="ownership" defaultValue={profile?.ownership ?? "partner"}><option value="partner">外部合作工厂</option><option value="owned">自有工厂／车间</option></select></Field>
      <Field label="合作关系"><select name="cooperationMode" defaultValue={profile?.cooperationMode ?? "direct"}><option value="direct">直接合作／直营</option><option value="subcontract">委外／转包</option></select></Field>
      <Field label="工厂状态"><select name="status" defaultValue={profile?.status ?? "draft"}>{Object.entries(factoryStatuses).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Field>
    </div><AddressFields title="生产地址" prefix="productionAddress" address={profile?.productionAddress} forActivation /><ContactFields prefix="contacts" defaultRole="production" contacts={profile?.contacts ?? []} forActivation />
    <AddressFields title="提货地址" prefix="pickupAddress" address={profile?.pickupAddress} /><AddressFields title="退货地址" prefix="returnAddress" address={profile?.returnAddress} />
    <div className="record-grid"><Field label="工厂时区" help="未知时留空保存草稿，启用前须确认"><select name="timeZone" defaultValue={profile?.timeZone ?? ""}><option value="">尚未确认</option>{[...new Set([profile?.timeZone, "Asia/Shanghai", "America/Los_Angeles", "America/New_York", "UTC"])].filter((zone): zone is string => Boolean(zone)).map(zone => <option key={zone}>{zone}</option>)}</select></Field>
      <Field label="工作时间"><input name="workingHours" maxLength={300} defaultValue={profile?.workingHours ?? ""} placeholder="例如周一至周六 09:00–18:00" /></Field>
      <Field label="接单截止时间"><input type="time" name="cutoffTime" defaultValue={profile?.cutoffTime ?? ""} /></Field></div>
    <fieldset className="factory-form-section"><legend>发货能力</legend><div className="factory-checkboxes">{Object.entries({ self_ship: "自发货", dropship: "一件代发", bulk_to_warehouse: "批量发往仓库" }).map(([value, label]) => <label key={value}><input type="checkbox" name="fulfillmentModes" value={value} defaultChecked={profile?.fulfillmentModes.some(mode => mode === value)} />{label}</label>)}</div></fieldset>
    <Field label="工厂备注"><textarea name="notes" maxLength={4000} rows={3} defaultValue={profile?.notes ?? ""} /></Field>
  </RecordForm></RecordDialog>;
}

export function FactoryCapabilityDialog({ factoryId, record, directory, onClose, onSaved, onDenied }: { factoryId: string; record?: FactoryCapabilityView; directory: FactoryDirectory; onClose(): void; onSaved(): void; onDenied?(): void }) {
  const profile = record?.profile, [productType, setProductType] = useState(profile?.productType ?? "shaped_pillow"), [plan, setPlan] = useState(profile?.productPlanId ?? "");
  const product = directory.products.find(product => product.id === plan);
  return <RecordDialog title={record ? "编辑产品与工艺能力" : "新增产品与工艺能力"} onClose={onClose} protectEdits><RecordForm operation={record ? "factoryCapability.revise" : "factoryCapability.create"} id={record?.id ?? factoryId} onSaved={onSaved} onCancel={onClose} onDenied={onDenied} submitLabel="保存工厂能力"
    description="填写能力名称即可先保存草稿；工序和核验资料可后补。仅承接部分工序的能力不会用于整件生产，启用前须确认工序和实际核验依据。"
    build={form => ({ ...(record ? { expectedVersion: record.versionNumber } : {}), profile: {
      name: formText(form, "name"), productType: formText(form, "productType"), productPlanId: formText(form, "productPlanId") || null, skuId: formText(form, "skuId") || null,
      fulfillmentScope: formText(form, "fulfillmentScope"), processCodes: form.getAll("processCodes"), materials: lines(formText(form, "materials")), specifications: formText(form, "specifications"),
      minimumLongestMm: numberOrNull(form, "minimumLongestMm"), maximumLongestMm: numberOrNull(form, "maximumLongestMm"), sideModes: form.getAll("sideModes"),
      factoryStandardId: formText(form, "factoryStandardId"), acceptedTemplateVersionIds: form.getAll("acceptedTemplateVersionIds"), status: formText(form, "status"),
      verificationStatus: formText(form, "verificationStatus"), verificationReference: formText(form, "verificationReference"), sampleStatus: formText(form, "sampleStatus"),
      unitCostMinor: formText(form, "unitCost") ? moneyMinor(formText(form, "unitCost")) : null, currency: formText(form, "currency"), minimumOrderQuantity: numberOrNull(form, "minimumOrderQuantity"),
      leadTimeDays: numberOrNull(form, "leadTimeDays"), dailyCapacity: numberOrNull(form, "dailyCapacity"), validFrom: new Date(formText(form, "validFrom")).toISOString(), validUntil: formText(form, "validUntil") ? new Date(formText(form, "validUntil")).toISOString() : null,
      afterSalesTerms: formText(form, "afterSalesTerms"), evidenceReferences: lines(formText(form, "evidenceReferences")), notes: formText(form, "notes"),
    } })}>
    <Field label="能力名称" help="必填"><input required name="name" maxLength={200} defaultValue={profile?.name ?? ""} placeholder="例如异形抱枕整件制作" /></Field><div className="record-grid">
      <Field label="产品类型"><select name="productType" value={productType} onChange={event => setProductType(event.target.value as typeof productType)}>{Object.entries(productNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      <Field label="承接范围"><select name="fulfillmentScope" defaultValue={profile?.fulfillmentScope ?? "process_only"}><option value="process_only">仅承接部分工序</option><option value="full_product">整件制作与交付</option></select></Field>
      <Field label="适用产品"><select name="productPlanId" value={plan} onChange={event => setPlan(event.target.value)}><option value="">该类型通用能力</option>{profile?.productPlanId && !directory.products.some(product => product.id === profile.productPlanId) && <option value={profile.productPlanId}>原产品（当前列表未显示）</option>}{directory.products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select></Field>
      <Field label="适用规格 SKU"><select name="skuId" key={plan} defaultValue={profile?.productPlanId === plan ? profile.skuId ?? "" : ""}><option value="">产品全部规格</option>{profile?.productPlanId === plan && profile.skuId && !product?.skus.some(sku => sku.id === profile.skuId) && <option value={profile.skuId}>原 SKU（当前列表未显示）</option>}{product?.skus.map(sku => <option key={sku.id} value={sku.id}>{sku.code}</option>)}</select></Field>
    </div><fieldset className="factory-form-section"><legend>承接工序</legend><div className="factory-checkboxes">{Object.entries(processNames).map(([value, label]) => <label key={value}><input type="checkbox" name="processCodes" value={value} defaultChecked={profile?.processCodes.some(code => code === value)} />{label}</label>)}</div></fieldset>
    <Field label="材料范围" help="每行一种材料或填充规格。"><textarea name="materials" maxLength={4000} rows={3} defaultValue={profile?.materials.join("\n") ?? ""} /></Field>
    <Field label="产品与制作规格"><textarea name="specifications" maxLength={4000} rows={3} defaultValue={profile?.specifications ?? ""} /></Field><div className="record-grid">
      <Field label="最长边下限（mm）" help="有尺寸的生产单须确认上下限，留空不会视为尺寸不限"><input type="number" step="0.1" min="0.1" max="5000" name="minimumLongestMm" defaultValue={profile?.minimumLongestMm ?? ""} /></Field>
      <Field label="最长边上限（mm）"><input type="number" step="0.1" min="0.1" max="5000" name="maximumLongestMm" defaultValue={profile?.maximumLongestMm ?? ""} /></Field>
    </div><fieldset className="factory-form-section"><legend>抱枕印刷面数</legend><div className="factory-checkboxes">{Object.entries({ single: "单面", double: "双面" }).map(([value, label]) => <label key={value}><input type="checkbox" name="sideModes" value={value} defaultChecked={profile?.sideModes.some(mode => mode === value)} />{label}</label>)}</div></fieldset>
    <Field label="已确认的工艺标准"><select name="factoryStandardId" defaultValue={profile?.factoryStandardId ?? ""}><option value="">尚未确认</option><option value={SHAPED_PILLOW_FACTORY_STANDARD.id}>异形抱枕 JPG 标准（2026-09-17）</option>{profile?.factoryStandardId && profile.factoryStandardId !== SHAPED_PILLOW_FACTORY_STANDARD.id && <option value={profile.factoryStandardId}>{profile.factoryStandardId}</option>}</select></Field>
    <fieldset className="factory-form-section"><legend>可接受的工艺模板版本</legend><p className="record-help">未限定模板时，仍须满足已确认的产品类型与工艺标准。</p><div className="factory-checkboxes">{[...directory.templates, ...(profile?.acceptedTemplateVersionIds ?? []).filter(id => !directory.templates.some(template => template.id === id)).map(id => ({ id, name: `原模板 ${id}（当前列表未显示）`, versionNumber: 0 }))].map(template => <label key={template.id}><input type="checkbox" name="acceptedTemplateVersionIds" value={template.id} defaultChecked={profile?.acceptedTemplateVersionIds.includes(template.id)} />{template.name}{template.versionNumber > 0 ? ` · V${template.versionNumber}` : ""}</label>)}</div>{!directory.templates.length && <p className="record-help">尚无可选工艺模板。</p>}</fieldset>
    <div className="record-grid"><Field label="能力状态"><select name="status" defaultValue={profile?.status ?? "draft"}><option value="draft">草稿</option><option value="active">启用</option><option value="paused">暂停</option><option value="archived">归档</option></select></Field>
      <Field label="核验状态"><select name="verificationStatus" defaultValue={profile?.verificationStatus ?? "pending"}><option value="pending">待核验</option><option value="confirmed">已核验确认</option><option value="failed">核验未通过</option></select></Field>
      <Field label="样品状态"><select name="sampleStatus" defaultValue={profile?.sampleStatus ?? "untested"}><option value="untested">尚未试样</option><option value="passed">样品通过</option><option value="failed">样品未通过</option></select></Field></div>
    <Field label="核验依据"><textarea name="verificationReference" maxLength={1000} rows={2} defaultValue={profile?.verificationReference ?? ""} placeholder="填写实际确认记录、凭证编号及日期" /></Field><div className="record-grid">
      <Field label="单价" help="未知时留空；报价不自动形成应付或付款。"><input name="unitCost" inputMode="decimal" defaultValue={profile?.unitCostMinor == null ? "" : (profile.unitCostMinor / 100).toFixed(2)} /></Field>
      <Field label="报价币种"><CurrencySelect defaultValue={profile?.currency ?? "CNY"} /></Field>
      <Field label="最低接单量" help="未知时留空保存草稿，启用前须确认"><input type="number" name="minimumOrderQuantity" min="1" max="100000" defaultValue={profile?.minimumOrderQuantity ?? ""} /></Field>
      <Field label="生产交期（天）"><input type="number" name="leadTimeDays" min="0" max="3650" defaultValue={profile?.leadTimeDays ?? ""} /></Field>
      <Field label="日产能（件）" help="作为排产参考，尚不自动预留产能。"><input type="number" name="dailyCapacity" min="0" max="1000000" defaultValue={profile?.dailyCapacity ?? ""} /></Field>
      <Field label="生效时间"><input required type="datetime-local" name="validFrom" defaultValue={localDateTime(profile ? new Date(profile.validFrom) : new Date())} /></Field>
      <Field label="到期时间"><input type="datetime-local" name="validUntil" defaultValue={profile?.validUntil ? localDateTime(new Date(profile.validUntil)) : ""} /></Field>
    </div><Field label="返工、退货与运费责任"><textarea name="afterSalesTerms" maxLength={2000} rows={3} defaultValue={profile?.afterSalesTerms ?? ""} /></Field>
    <Field label="凭证与文档引用" help="每行填写一个凭证编号或文档链接，系统不会自动读取或对外发送。"><textarea name="evidenceReferences" maxLength={8000} rows={3} defaultValue={profile?.evidenceReferences.join("\n") ?? ""} /></Field>
    <Field label="能力备注"><textarea name="notes" maxLength={4000} rows={3} defaultValue={profile?.notes ?? ""} /></Field>
  </RecordForm></RecordDialog>;
}
