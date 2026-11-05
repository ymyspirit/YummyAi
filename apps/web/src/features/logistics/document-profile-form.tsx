"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Plus, Save, Trash2, Undo2 } from "lucide-react";
import { FactoryDocumentProfileSchema, type DocumentOptions, type FactoryDocumentProfile, type ParcelSpecification } from "@yummyai/contracts/logistics/documents";
import { useLeaveGuard } from "../navigation/use-leave-guard";
import { logisticsError, logisticsRequest } from "./logistics-client";

function emptyProfile(name: string, country = "US"): FactoryDocumentProfile {
  return { name, route: country === "US" ? "printeque" : "yunexpress", productionAdapter: country === "US" ? "printeque_factory" : "yicai_folder",
    originCountryCode: country, destinationCountries: [country === "US" ? "US" : "CA"], originCompany: "", factoryCode: "",
    carrierProvider: "", carrierService: "", useAccountSender: false, specifications: [], evidence: "" };
}
function emptySpec(id: string): ParcelSpecification {
  return { specificationVersionId: id, productKind: "shaped_pillow", sizeIn: null, supplierSku: "", weight: 0,
    weightUnit: "lb", length: null, width: null, height: null, dimensionUnit: "in", declaredUnitValueMinor: null,
    nameEn: "Pillow", nameCn: "抱枕", hsCode: "" };
}
export function DocumentProfileForm({ options, onSaved, onStateChange }: { options: DocumentOptions; onSaved(profileVersionId: string): Promise<void>; onStateChange?(state: { dirty: boolean; busy: boolean }): void }) {
  const [factoryId, setFactoryId] = useState(""), [profile, setProfile] = useState<FactoryDocumentProfile>(() => emptyProfile(""));
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [baseVersion, setBaseVersion] = useState(0);
  const alive = useRef(true), key = useRef(crypto.randomUUID());
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useLeaveGuard(dirty, busy);
  useEffect(() => { onStateChange?.({ dirty, busy }); return () => onStateChange?.({ dirty: false, busy: false }); }, [dirty, busy, onStateChange]);
  function selectFactory(id: string) {
    const found = options.profiles.find(row => row.factoryId === id), factory = options.factories.find(row => row.id === id);
    setFactoryId(id); setProfile(structuredClone(found?.profile ?? emptyProfile(factory?.name ?? "", factory?.countryCode ?? "US")));
    setBaseVersion(found?.version ?? 0);
    setDirty(false); setError(""); setNotice(""); key.current = crypto.randomUUID();
  }
  function change(update: Partial<FactoryDocumentProfile>) { setProfile(value => ({ ...value, ...update })); setDirty(true); setNotice(""); key.current = crypto.randomUUID(); }
  function changeSpec(index: number, update: Partial<ParcelSpecification>) { change({ specifications: profile.specifications.map((spec, i) => i === index ? { ...spec, ...update } : spec) }); }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    const parsed = FactoryDocumentProfileSchema.safeParse(profile);
    if (!parsed.success) { setError(parsed.error.issues.map(issue => `${issue.path[0] === "specifications" ? "包裹规格" : "配置"} ${issue.message}`).slice(0, 4).join("；")); return; }
    setBusy(true); setError("");
    try {
      const result = await logisticsRequest("documents/profiles", { factoryId, expectedVersion: baseVersion, profile: parsed.data, idempotencyKey: key.current });
      if (!alive.current) return;
      setBaseVersion(result.version); setDirty(false); setNotice("已保存工厂导单配置 新导出使用此版本"); await onSaved(result.id);
    } catch (e) { if (alive.current) setError(logisticsError(e)); }
    finally { if (alive.current) setBusy(false); }
  }
  return <form className="logistics-form document-profile" onSubmit={event => void submit(event)}>
    <label>选择工厂<select aria-label="配置工厂" value={factoryId} disabled={busy || dirty} onChange={event => selectFactory(event.target.value)}><option value="">请选择</option>{options.factories.map(factory => <option key={factory.id} value={factory.id}>{factory.name}{factory.status === "active" ? "" : " · 未启用"}</option>)}</select></label>
    {!options.factories.length && <p>请先在供应商与工厂档案建立实际工厂</p>}
    {factoryId && <>
      <fieldset className="logistics-fields" disabled={busy}>
        <label>配置名称<input required value={profile.name} onChange={e => change({ name: e.target.value })}/></label>
        <label>物流表<select value={profile.route} onChange={e => change({ route: e.target.value as FactoryDocumentProfile["route"], productionAdapter: "none" })}><option value="printeque">Printeque 快递打单</option><option value="yunexpress">云途标准模板</option></select></label>
        <label>生产导单<select value={profile.productionAdapter} onChange={e => change({ productionAdapter: e.target.value as FactoryDocumentProfile["productionAdapter"] })}><option value="none">暂不配置</option>{profile.route === "printeque" ? <option value="printeque_factory">Printeque ERP</option> : <option value="yicai_folder">义彩文件夹</option>}</select></label>
        <label>实际发货国<input required maxLength={2} value={profile.originCountryCode} onChange={e => change({ originCountryCode: e.target.value.toUpperCase() })}/></label>
        <label>收货国代码<input required placeholder="US 或 CA 多个用逗号分隔" value={profile.destinationCountries.join(",")} onChange={e => change({ destinationCountries: e.target.value.toUpperCase().split(/[,，]/).map(code => code.trim()) })}/></label>
        {profile.productionAdapter === "printeque_factory" && <><label>工厂编号<input required value={profile.factoryCode} onChange={e => change({ factoryCode: e.target.value })}/></label><label>订单来源 origin<input required value={profile.originCompany} onChange={e => change({ originCompany: e.target.value })}/></label><label>物流渠道提供方<input required value={profile.carrierProvider} onChange={e => change({ carrierProvider: e.target.value })}/></label><label>物流服务 可留空<input value={profile.carrierService} onChange={e => change({ carrierService: e.target.value })}/></label></>}
        {profile.route === "yunexpress" && <label className="logistics-check logistics-wide"><input type="checkbox" checked={profile.useAccountSender} onChange={e => change({ useAccountSender: e.target.checked })}/>已确认云途账户默认发件人对应此实际工厂</label>}
        <label className="logistics-wide">包裹数据依据<input required minLength={5} maxLength={1000} placeholder="例如 规格尺寸表的文件名、确认日期与调整原因" value={profile.evidence} onChange={e => change({ evidence: e.target.value })}/></label>
      </fieldset>
      <p className="oc-muted">规格关联产品档案中的 SPU 规格版本 包裹尺寸与生产图尺寸分别维护</p>
      {profile.specifications.map((spec, index) => <fieldset className="logistics-fields document-spec" key={index} disabled={busy}>
        <legend>包裹规格 {index + 1}</legend>
        <label className="logistics-wide">产品规格<select aria-label={`产品规格 ${index + 1}`} value={spec.specificationVersionId} required onChange={e => changeSpec(index, { specificationVersionId: e.target.value })}><option value="">请选择产品规格</option>{options.specifications.map(row => <option key={row.id} value={row.id}>{row.spuName} / {row.name} · V{row.version}</option>)}{spec.specificationVersionId && !options.specifications.some(row => row.id === spec.specificationVersionId) && <option value={spec.specificationVersionId}>已固定历史规格版本</option>}</select></label>
        <label>产品类型<select value={spec.productKind} onChange={e => changeSpec(index, { productKind: e.target.value as ParcelSpecification["productKind"] })}><option value="shaped_pillow">异形抱枕</option><option value="custom_hanger">定制衣架</option><option value="other">其他产品</option></select></label>
        <label>产品尺寸 in<input type="number" min="0.01" step="any" value={spec.sizeIn ?? ""} onChange={e => changeSpec(index, { sizeIn: numberOrNull(e.target.value) })}/></label>
        <label>工厂 parent_sku<input value={spec.supplierSku} onChange={e => changeSpec(index, { supplierSku: e.target.value })}/></label>
        <label>单件含包装重量<input type="number" min="0.001" step="any" required value={spec.weight || ""} onChange={e => changeSpec(index, { weight: Number(e.target.value) })}/></label>
        <label>重量单位<select value={spec.weightUnit} onChange={e => changeSpec(index, { weightUnit: e.target.value as ParcelSpecification["weightUnit"] })}><option value="lb">lb</option><option value="kg">kg</option><option value="g">g</option></select></label>
        <label>申报单价 USD<input type="number" min="0.01" step="0.01" required value={spec.declaredUnitValueMinor === null ? "" : spec.declaredUnitValueMinor / 100} onChange={e => changeSpec(index, { declaredUnitValueMinor: e.target.value ? Math.round(Number(e.target.value) * 100) : null })}/></label>
        {(["length", "width", "height"] as const).map((field, i) => <label key={field}>{["包裹长", "包裹宽", "包裹高"][i]}<input type="number" min="0.001" step="any" required={profile.route === "printeque"} value={spec[field] ?? ""} onChange={e => changeSpec(index, { [field]: numberOrNull(e.target.value) })}/></label>)}
        <label>尺寸单位<select value={spec.dimensionUnit} onChange={e => changeSpec(index, { dimensionUnit: e.target.value as ParcelSpecification["dimensionUnit"] })}><option value="in">in</option><option value="cm">cm</option><option value="mm">mm</option></select></label>
        <label>英文申报品名<input required value={spec.nameEn} onChange={e => changeSpec(index, { nameEn: e.target.value })}/></label><label>中文申报品名<input required value={spec.nameCn} onChange={e => changeSpec(index, { nameCn: e.target.value })}/></label>
        <label>海关编码 可留空<input value={spec.hsCode} onChange={e => changeSpec(index, { hsCode: e.target.value })}/></label>
        <button className="oc-button" type="button" aria-label={`移除包裹规格 ${index + 1}`} onClick={() => change({ specifications: profile.specifications.filter((_, i) => i !== index) })}><Trash2 size={15}/>移除规格</button>
      </fieldset>)}
      <div className="oc-actions"><button className="oc-button" type="button" disabled={busy || profile.specifications.length >= 200} onClick={() => change({ specifications: [...profile.specifications, emptySpec("")] })}><Plus size={16}/>添加包裹规格</button><button className="oc-button primary" type="submit" disabled={busy || !dirty}><Save size={16}/>{busy ? "正在保存" : "保存配置"}</button><button className="oc-button" type="button" disabled={busy || !dirty} onClick={() => selectFactory(factoryId)}><Undo2 size={16}/>放弃本次修改</button></div>
    </>}
    {error && <p role="alert" className="logistics-error">{error}</p>}{notice && <p role="status">{notice}</p>}
  </form>;
}
function numberOrNull(value: string) { return value === "" ? null : Number(value); }
