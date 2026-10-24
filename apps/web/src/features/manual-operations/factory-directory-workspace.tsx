"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, RefreshCw, X } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { FactoryHistorySchema, type FactoryDirectory, type FactoryHistory, type FactoryView, type FactoryCapabilityView } from "@yummyai/contracts/suppliers/factory-directory";
import type { BusinessAddress } from "@yummyai/contracts/suppliers/supplier-profile";
import type { FulfillmentSupplierView } from "@yummyai/contracts/order/routing";
import { FactoryRecordDialog, FactoryCapabilityDialog, productNames, processNames } from "./factory-record-dialog";
import { loadFactoryHistory } from "./operation-actions";
import { useErpAccess } from "../identity/erp-access";
import { FactoryCapacityWorkspace } from "./factory-capacity-workspace";
import "./factory-directory.css";

const statusNames: Record<string, string> = { draft: "草稿", active: "启用", suspended: "暂停", paused: "暂停", archived: "归档", pending: "待核验", confirmed: "已核验", failed: "未通过", untested: "未试样", passed: "通过" };
function useFactoryDirectoryAuthority(directory: FactoryDirectory, resourceId: string) {
  const access = useErpAccess(), readCeiling = access.canTenant(Permission.OrderRead), writeCeiling = access.canTenant(Permission.OrderWrite);
  const stamp = JSON.stringify([access.preferenceScope, access.authority, resourceId, directory.contextAuthority, readCeiling, writeCeiling, directory.access?.canRead, directory.access?.canWrite]);
  const [denial, setDenial] = useState<{ stamp: string; source: FactoryDirectory; reason: string } | null>(null);
  const reason = denial?.stamp === stamp && denial.source === directory ? denial.reason : "";
  const matches = access.localDevelopment || Boolean(access.authority && access.authority === directory.contextAuthority);
  const canRead = matches && readCeiling && directory.access?.canRead === true && !reason;
  const canWrite = canRead && writeCeiling && directory.access?.canWrite === true;
  const reject = useCallback((message: string) => { setDenial({ stamp, source: directory, reason: message }); window.dispatchEvent(new Event("focus")); }, [stamp, directory]);
  return { stamp, authority: access.authority, localDevelopment: access.localDevelopment, canRead, canWrite, reason, reject };
}
function FactoryAccessNotice({ reason, onReload }: { reason: string; onReload(): void }) {
  return <><p className="record-notice" role="status">{reason || "工厂资料与当前读取权限尚未核对 旧资料和填写已隐藏 请重新读取"}</p><button type="button" onClick={onReload}><RefreshCw size={14} aria-hidden="true" />重新核对工厂目录</button></>;
}
export function addressText(address: BusinessAddress | null) { return address ? [address.countryCode, address.province, address.city, address.district, address.street, address.postalCode, address.recipient, address.phone].filter(Boolean).join(" · ") || "未填写" : "未填写"; }
function profileDetails(factory: FactoryView) {
  const profile = factory.profile;
  return <dl className="factory-overview"><div><dt>生产地址</dt><dd>{addressText(profile.productionAddress)}</dd></div><div><dt>提货地址</dt><dd>{addressText(profile.pickupAddress)}</dd></div>
    <div><dt>退货地址</dt><dd>{addressText(profile.returnAddress)}</dd></div><div><dt>联系人</dt><dd>{profile.contacts.length ? profile.contacts.map(contact => `${({ business: "商务", production: "生产", quality: "质检", shipping: "收发货" })[contact.role]}：${[contact.name, contact.phone, contact.wechat, contact.email].filter(Boolean).join(" · ")}`).join("\n") : "未填写"}</dd></div>
    <div><dt>工作时间与时区</dt><dd>{profile.workingHours || "工作时间未填写"} · {profile.timeZone ?? "时区未确认"}{profile.cutoffTime && ` · ${profile.cutoffTime} 截单`}</dd></div>
    <div><dt>备注</dt><dd>{profile.notes || "未填写"}</dd></div></dl>;
}
export function SupplierBusinessDetails({ supplier }: { supplier: FulfillmentSupplierView }) {
  const profile = supplier.profile;
  const roles = { manufacturing: "生产加工", blank_goods: "空白载体供货", raw_material: "原材料供货", packaging: "包装供货" };
  return <section className="factory-workspace" aria-label="合作主体资料"><h2>合作主体资料</h2><dl className="factory-overview">
    <div><dt>企业全称与简称</dt><dd>{profile.legalName || "企业全称未填写"}{profile.alias && ` · ${profile.alias}`}</dd></div>
    <div><dt>业务角色</dt><dd>{profile.roles.length ? profile.roles.map(role => roles[role]).join("、") : "尚未确认"}</dd></div>
    <div><dt>办公地址</dt><dd>{addressText(profile.officeAddress)}</dd></div>
    <div><dt>商务及其他联系人</dt><dd>{profile.contacts.length ? profile.contacts.map(contact => [contact.name, contact.phone, contact.wechat, contact.email].filter(Boolean).join(" · ")).join("\n") : "未填写"}</dd></div>
    <div><dt>付款与结算条件</dt><dd>{profile.paymentTerms || "未填写"}</dd></div><div><dt>开票信息</dt><dd>{profile.invoiceInformation || "未填写"}</dd></div>
    <div><dt>合作备注</dt><dd>{profile.notes || "未填写"}</dd></div>
  </dl></section>;
}
export function SupplierFactories({ supplierId, directory }: { supplierId: string; directory: FactoryDirectory }) {
  const grant = useFactoryDirectoryAuthority(directory, supplierId);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { setHydrated(true); }, []);
  const router = useRouter(), [editor, setEditor] = useState<{ stamp: string; source: FactoryDirectory; value: FactoryView | "new"; sequence: number }>(), [message, setMessage] = useState(""), [includeArchived, setIncludeArchived] = useState(false);
  const sequence = useRef(0), current = useRef({ stamp: grant.stamp, directory, canWrite: grant.canWrite }); current.current = { stamp: grant.stamp, directory, canWrite: grant.canWrite };
  useLayoutEffect(() => { sequence.current++; setEditor(undefined); setMessage(""); setIncludeArchived(false); return () => { sequence.current++; }; }, [grant.stamp, directory]);
  const editing = grant.canWrite && editor?.stamp === grant.stamp && editor.source === directory ? editor : null;
  const ownsEditor = () => Boolean(editing && current.current.stamp === editing.stamp && current.current.directory === editing.source && current.current.canWrite && sequence.current === editing.sequence);
  const close = () => { sequence.current++; setEditor(undefined); };
  const open = (value: FactoryView | "new") => { if (grant.canWrite) setEditor({ stamp: grant.stamp, source: directory, value, sequence: ++sequence.current }); };
  const denied = () => { close(); setMessage(""); grant.reject("当前工厂操作权限或记录可见范围已变化 私有资料和填写已清除 请重新核对"); router.refresh(); };
  if (!grant.canRead) return <section className="factory-workspace" aria-label="所属与合作工厂"><h2>所属与合作工厂</h2><FactoryAccessNotice reason={grant.reason} onReload={() => router.refresh()} /></section>;
  const factories = directory.factories.filter(factory => factory.supplierId === supplierId && (includeArchived || factory.profile.status !== "archived"));
  return <section className="factory-workspace" aria-label="所属与合作工厂"><h2>所属与合作工厂</h2><p className="record-help">每个工厂独立维护地址、联系人和产品能力。启用并核验能力后，生产人员才能选择具体工厂。</p>
    <div className="record-toolbar">{grant.canWrite && <button className="primary" type="button" disabled={!hydrated} onClick={() => open("new")}><Plus size={15} />新增工厂</button>}<label className="factory-checkboxes"><input disabled={!hydrated} type="checkbox" checked={includeArchived} onChange={event => setIncludeArchived(event.target.checked)} />显示已归档工厂</label></div>
    {!grant.canWrite && <p className="record-help">当前可读取工厂资料 创建与修订需要租户级订单操作权限</p>}
    {message && <p className="record-notice success" role="status">{message}</p>}
    {!factories.length ? <p className="record-notice">暂无工厂档案。请添加实际生产地点，原供应商资料不会自动转换为工厂。</p> : <div className="record-table-scroll"><table className="record-table"><thead><tr><th>工厂</th><th>性质与状态</th><th>生产地址</th><th>产品与工艺能力</th><th>操作</th></tr></thead><tbody>{factories.map(factory => <tr key={factory.id}>
      <td><Link href={`/suppliers/${supplierId}/factories/${factory.id}`}>{factory.profile.name}</Link><small className="factory-table-help">{factory.code} · V{factory.versionNumber}</small></td>
      <td>{factory.profile.ownership === "owned" ? "自有" : "外部合作"} · {statusNames[factory.profile.status]}<small className="factory-table-help">{factory.profile.cooperationMode === "subcontract" ? "委外／转包" : "直接合作／直营"}</small>{factory.supplierBlockers.length > 0 && <small className="factory-table-help">所属主体需核对：{factory.supplierBlockers.join("；")}</small>}</td>
      <td>{addressText(factory.profile.productionAddress)}</td><td>{directory.capabilities.filter(capability => capability.factoryId === factory.id && capability.profile.status !== "archived").map(capability => <small className="factory-table-help" key={capability.id}>{capability.profile.name} · {statusNames[capability.profile.status]}</small>)}{!directory.capabilities.some(capability => capability.factoryId === factory.id) && "尚未配置"}</td>
      <td>{grant.canWrite && <button type="button" disabled={!hydrated} onClick={() => open(factory)}>编辑工厂</button>}<Link href={`/suppliers/${supplierId}/factories/${factory.id}`}>{grant.canWrite ? "管理能力" : "查看能力"}</Link></td>
    </tr>)}</tbody></table></div>}
    {editing && <FactoryRecordDialog supplierId={supplierId} record={editing.value === "new" ? undefined : editing.value} onClose={close} onDenied={() => { if (ownsEditor()) denied(); }} onSaved={() => {
      if (!ownsEditor()) return;
      close(); setMessage("工厂资料已保存，原版本历史保留。"); router.refresh();
    }} />}
  </section>;
}

export function FactoryWorkspace({ factory, directory }: { factory: FactoryView; directory: FactoryDirectory }) {
  const grant = useFactoryDirectoryAuthority(directory, factory.id);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { setHydrated(true); }, []);
  const router = useRouter(), [editor, setEditor] = useState<{ stamp: string; source: FactoryDirectory; kind: "factory" | "capability"; value: FactoryCapabilityView | "new"; sequence: number }>(), [message, setMessage] = useState(""), [includeArchived, setIncludeArchived] = useState(false);
  const [historyRead, setHistoryRead] = useState<{ stamp: string; source: FactoryDirectory; reading: boolean; value: FactoryHistory | null; error: string } | null>(null);
  const historySequence = useRef(0), editorSequence = useRef(0), alive = useRef(true);
  const current = useRef({ stamp: grant.stamp, directory, factoryId: factory.id, canRead: grant.canRead, canWrite: grant.canWrite }); current.current = { stamp: grant.stamp, directory, factoryId: factory.id, canRead: grant.canRead, canWrite: grant.canWrite };
  useLayoutEffect(() => { historySequence.current++; editorSequence.current++; setEditor(undefined); setHistoryRead(null); setMessage(""); setIncludeArchived(false); }, [grant.stamp, directory]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; historySequence.current++; editorSequence.current++; }; }, []);
  const activeHistory = grant.canRead && historyRead?.stamp === grant.stamp && historyRead.source === directory ? historyRead : null;
  const history = activeHistory?.value, historyBusy = activeHistory?.reading ?? false;
  const editing = grant.canWrite && editor?.stamp === grant.stamp && editor.source === directory ? editor : null;
  const ownsEditor = () => Boolean(editing && alive.current && current.current.stamp === editing.stamp && current.current.directory === editing.source && current.current.canWrite && editorSequence.current === editing.sequence);
  const closeHistory = () => { historySequence.current++; setHistoryRead(null); };
  const closeEditor = () => { editorSequence.current++; setEditor(undefined); closeHistory(); };
  const denied = (reason = "当前工厂操作权限或记录可见范围已变化 私有资料和填写已清除 请重新核对") => { closeEditor(); setMessage(""); grant.reject(reason); router.refresh(); };
  const open = (kind: "factory" | "capability", value: FactoryCapabilityView | "new" = "new") => { if (!grant.canWrite) return; closeHistory(); setEditor({ stamp: grant.stamp, source: directory, kind, value, sequence: ++editorSequence.current }); };
  async function readHistory() {
    if (!grant.canRead || !current.current.canRead) return;
    const token = ++historySequence.current, captured = { ...current.current };
    const valid = () => alive.current && historySequence.current === token && current.current.stamp === captured.stamp && current.current.directory === captured.directory && current.current.factoryId === captured.factoryId && current.current.canRead;
    setHistoryRead({ stamp: captured.stamp, source: captured.directory, reading: true, value: null, error: "" });
    try {
      const result = await loadFactoryHistory(captured.factoryId);
      if (!valid()) return;
      if (result.error) {
        const statusCode = "statusCode" in result && typeof result.statusCode === "number" ? result.statusCode : null;
        if ("denied" in result && result.denied === true || statusCode !== null && [401, 403, 404].includes(statusCode)) { denied("原工厂历史当前不可访问 私有资料和填写已清除 请重新核对"); return; }
        setHistoryRead({ stamp: captured.stamp, source: captured.directory, reading: false, value: null, error: result.error }); return;
      }
      const parsed = FactoryHistorySchema.safeParse(result.data);
      if (!parsed.success || parsed.data.factoryId !== captured.factoryId || parsed.data.factories.some(row => row.supplierId !== factory.supplierId)) {
        setHistoryRead({ stamp: captured.stamp, source: captured.directory, reading: false, value: null, error: "历史响应与当前工厂或固定版本格式不一致 未显示返回资料" }); return;
      }
      if (!grant.localDevelopment && parsed.data.contextAuthority !== grant.authority || !parsed.data.access.canRead) { denied("历史响应的当前身份依据已变化 私有资料和填写已清除"); return; }
      setHistoryRead({ stamp: captured.stamp, source: captured.directory, reading: false, value: parsed.data, error: "" });
    } catch {
      if (valid()) setHistoryRead({ stamp: captured.stamp, source: captured.directory, reading: false, value: null, error: "版本历史暂时无法读取 请重新读取 不使用旧历史补填" });
    }
  }
  const saved = () => {
    if (!ownsEditor()) return;
    closeEditor(); setMessage("资料已保存为新版本，已有生产单的固定资料保留。"); router.refresh();
  };
  if (!grant.canRead || !directory.factories.some(row => row.id === factory.id && row.supplierId === factory.supplierId && row.versionId === factory.versionId)) return <section id="factory-profile" className="factory-workspace" aria-label="工厂资料与生产能力"><h2>工厂资料与生产能力</h2><FactoryAccessNotice reason={grant.reason} onReload={() => router.refresh()} /></section>;
  const capabilities = directory.capabilities.filter(capability => capability.factoryId === factory.id && (includeArchived || capability.profile.status !== "archived"));
  return <section id="factory-profile" className="factory-workspace" aria-label="工厂资料与生产能力"><h2>{factory.profile.name}</h2><div className="record-toolbar">{grant.canWrite && <><button disabled={!hydrated} onClick={() => open("factory")} type="button">编辑工厂资料</button><button className="primary" disabled={!hydrated} onClick={() => open("capability")} type="button"><Plus size={15} />新增产品与工艺能力</button><Link href={`/factory-collaboration?${new URLSearchParams({ factoryId: factory.id })}`}>管理本工厂的协作授权</Link></>}
    <button type="button" disabled={!hydrated || historyBusy} onClick={() => void readHistory()}>{historyBusy ? "正在读取历史…" : "查看版本历史"}</button></div>
    {!grant.canWrite && <p className="record-help">当前可读取工厂及版本历史 创建与修订需要租户级订单操作权限</p>}
    {message && <p className="record-notice success" role="status">{message}</p>}
    {factory.supplierBlockers.length > 0 && <p className="record-notice error" role="alert">{factory.supplierBlockers.join("；")}</p>}
    <p>{factory.profile.ownership === "owned" ? "自有工厂／车间" : "外部合作工厂"} · {statusNames[factory.profile.status]} · {factory.code} · 资料 V{factory.versionNumber}</p>{profileDetails(factory)}
    <h2 id="factory-capabilities">产品与工艺能力</h2><p className="record-help">同一工厂可维护多个产品或工序的能力、报价和交期。未核验、停用或仅部分工序的能力不能用于整件生产。</p>
    <label className="factory-checkboxes"><input type="checkbox" checked={includeArchived} onChange={event => setIncludeArchived(event.target.checked)} />显示已归档能力</label>
    {!capabilities.length ? <p className="record-notice">尚未配置产品与工艺能力。</p> : <div className="record-table-scroll"><table className="record-table"><thead><tr><th>能力与产品</th><th>承接范围</th><th>核验与状态</th><th>报价与交期</th><th>操作</th></tr></thead><tbody>{capabilities.map(capability => <tr id={`capability-${capability.id}`} key={capability.id}>
      <td>{capability.profile.name}<small className="factory-table-help">{productNames[capability.profile.productType]} · V{capability.versionNumber}</small><small className="factory-table-help">{capability.profile.productPlanId ? directory.products.find(product => product.id === capability.profile.productPlanId)?.name ?? "已固定产品（当前名称不可用）" : "该类型通用能力"}</small></td>
      <td>{capability.profile.fulfillmentScope === "full_product" ? "整件制作与交付" : "部分工序"}<small className="factory-table-help">{capability.profile.processCodes.map(code => processNames[code]).join("、")}</small><small className="factory-table-help">{capability.profile.minimumLongestMm ?? "下限未确认"}–{capability.profile.maximumLongestMm ?? "上限未确认"} mm</small></td>
      <td>{statusNames[capability.profile.status]} · {statusNames[capability.profile.verificationStatus]}<small className="factory-table-help">样品：{statusNames[capability.profile.sampleStatus]}</small><small className="factory-table-help">{capability.profile.verificationReference || "尚无核验依据"}</small></td>
      <td>{capability.profile.unitCostMinor === null ? "未报价" : `${(capability.profile.unitCostMinor / 100).toFixed(2)} ${capability.profile.currency}`}<small className="factory-table-help">{capability.profile.minimumOrderQuantity === null ? "最低接单量未确认" : `MOQ ${capability.profile.minimumOrderQuantity}`} · {capability.profile.leadTimeDays === null ? "交期未知" : `${capability.profile.leadTimeDays} 天`}</small><small className="factory-table-help">{capability.profile.dailyCapacity === null ? "产能未填写" : `日产能参考 ${capability.profile.dailyCapacity} 件`}</small></td>
      <td>{grant.canWrite && <button type="button" disabled={!hydrated} onClick={() => open("capability", capability)}>编辑能力</button>}<details><summary>查看规格与依据</summary><p>{capability.profile.specifications || "规格尚未填写"}</p><p>{capability.profile.materials.join("、") || "材料尚未填写"}</p><p>{capability.profile.afterSalesTerms || "售后责任尚未填写"}</p>{capability.profile.evidenceReferences.map(reference => <p key={reference}>{reference}</p>)}</details></td>
    </tr>)}</tbody></table></div>}
    {activeHistory && <section aria-label="工厂版本历史" aria-busy={historyBusy}><div className="record-toolbar"><h3>工厂版本历史</h3><button type="button" disabled={historyBusy} onClick={() => void readHistory()}><RefreshCw size={14} aria-hidden="true" />重新读取版本历史</button><button type="button" onClick={closeHistory}><X size={14} aria-hidden="true" />关闭版本历史</button></div>
      {historyBusy && <p role="status">正在读取当前工厂的版本历史</p>}{activeHistory.error && <p className="record-notice error" role="alert">{activeHistory.error}</p>}
      {history && <><h3>工厂资料历史</h3>{history.factories.map(version => <details className="factory-version-row" key={version.versionId}><summary>资料 V{version.versionNumber} · {version.profile.name} · {new Date(version.updatedAt).toLocaleString("zh-CN")}</summary>{profileDetails(version)}</details>)}<h3>能力版本历史</h3>{history.capabilities.map(version => <details className="factory-version-row" key={version.versionId}><summary>{version.profile.name} · V{version.versionNumber} · {statusNames[version.profile.status]}</summary><p>固定能力版本 <code>{version.versionId}</code></p><p>{productNames[version.profile.productType]} · {version.profile.processCodes.map(code => processNames[code]).join("、")}</p><p>{version.profile.verificationReference || "未核验"}</p><p>{version.profile.specifications || "规格尚未填写"}</p></details>)}{!history.factories.length && !history.capabilities.length && <p className="record-help">当前工厂没有可读取的版本历史</p>}</>}
    </section>}
    <FactoryCapacityWorkspace key={`${grant.stamp}:${factory.versionId}`} factory={factory} capabilities={directory.capabilities.filter(row => row.factoryId === factory.id)} canWrite={grant.canWrite} onDenied={() => denied("当前工厂产能权限或资料范围已变化 私有资料和填写已清除 请重新核对")} />
    {editing?.kind === "factory" && <FactoryRecordDialog supplierId={factory.supplierId} record={factory} onClose={closeEditor} onSaved={saved} onDenied={() => { if (ownsEditor()) denied(); }} />}
    {editing?.kind === "capability" && <FactoryCapabilityDialog factoryId={factory.id} record={editing.value === "new" ? undefined : editing.value} directory={directory} onClose={closeEditor} onSaved={saved} onDenied={() => { if (ownsEditor()) denied(); }} />}
  </section>;
}
