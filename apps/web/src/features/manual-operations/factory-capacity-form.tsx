"use client";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import { CreateFactoryCapacityPoolSchema, ReviseFactoryCapacityPoolSchema, FactoryCapacityPoolViewSchema,
  type FactoryCapacityPoolProfile, type FactoryCapacityPoolView } from "@yummyai/contracts/suppliers/factory-capacity";
import type { FactoryCapabilityView, FactoryView } from "@yummyai/contracts/suppliers/factory-directory";
import { RecordDialog } from "./record-form";
import { capacityDenied, capacityError, capacityRequest, CapacityRequestError, capacityUnitName, type CapacityIdentity } from "../order-centers/production-capacity-api";
import "./factory-capacity.css";

const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
type Intervals = FactoryCapacityPoolProfile["weekly"][number]["intervals"];
function IntervalsEditor({ name, values, onChange }: { name: string; values: Intervals; onChange(value: Intervals): void }) {
  return <div>{!values.length && <small>该日不安排工作</small>}{values.map((value, index) => <div className="fc-interval" key={index}>
    <label>开始<input aria-label={`${name}区间${index + 1}开始`} type="time" required value={value.start} onChange={event => onChange(values.map((item, i) => i === index ? { ...item, start: event.target.value } : item))} /></label>
    <label>结束<input aria-label={`${name}区间${index + 1}结束`} required placeholder="HH:mm 或 24:00" pattern={"(?:[01][0-9]|2[0-3]):[0-5][0-9]|24:00"} value={value.end} onChange={event => onChange(values.map((item, i) => i === index ? { ...item, end: event.target.value } : item))} /></label>
    <button type="button" aria-label={`移除${name}区间${index + 1}`} onClick={() => onChange(values.filter((_, i) => i !== index))}><Trash2 size={14} aria-hidden="true" /></button>
  </div>)}<button type="button" disabled={values.length >= 12} onClick={() => onChange([...values, { start: "09:00", end: "18:00" }])}><Plus size={14} aria-hidden="true" />增加{name}工作区间</button></div>;
}
function CapacityPoolReceipt({ saved, onFinish }: { saved: FactoryCapacityPoolView; onFinish(): void }) {
  const title = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => { const heading = title.current, dialog = heading?.closest("dialog"); if (dialog) dialog.scrollTop = 0; heading?.focus({ preventScroll: true }); }, []);
  return <section aria-label="产能池版本已登记"><h3 ref={title} tabIndex={-1}>产能池版本已登记</h3><p>{saved.profile.name} · V{saved.versionNumber} · {saved.timeZone} · {capacityUnitName(saved.unit)}</p>
    <p>资源池 <code>{saved.id}</code><br />固定版本 <code>{saved.versionId}</code></p><p>已有生产预留仍保留原版本 此次修订不会替换历史安排</p>
    <button className="primary" type="button" onClick={onFinish}><Check size={14} aria-hidden="true" />确认资源池版本并返回</button></section>;
}
export function FactoryCapacityForm({ factory, capabilities, record, identity, onClose, onSaved, onDenied }: {
  factory: FactoryView; capabilities: FactoryCapabilityView[]; record?: FactoryCapacityPoolView; identity: CapacityIdentity;
  onClose(): void; onSaved(value: FactoryCapacityPoolView): void; onDenied(): void;
}) {
  const profile = record?.profile;
  const [weekly, setWeekly] = useState<FactoryCapacityPoolProfile["weekly"]>(() => profile?.weekly ?? weekdays.map((_, index) => ({ weekday: index + 1, intervals: [] })));
  const [exceptions, setExceptions] = useState<FactoryCapacityPoolProfile["exceptions"]>(profile?.exceptions ?? []);
  const [bindings, setBindings] = useState<Array<{ capabilityVersionId: string; unitsPerItem: string; manual?: boolean }>>(() => profile?.bindings.map(row => ({ ...row, unitsPerItem: String(row.unitsPerItem), manual: !capabilities.some(item => item.versionId === row.capabilityVersionId) })) ?? []);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState<FactoryCapacityPoolView | null>(null);
  const [frozen, setFrozen] = useState<unknown>(null), alive = useRef(true), sending = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function send(body: unknown) {
    if (sending.current) return; sending.current = true; setBusy(true); setError(""); setFrozen(body);
    try {
      const value = await capacityRequest(`factories/${factory.id}/capacity-pools${record ? `/${record.id}/revisions` : ""}`, FactoryCapacityPoolViewSchema, identity, body);
      if (alive.current) { setSaved(value); setFrozen(null); }
    } catch (failure) { if (alive.current) {
      if (capacityDenied(failure)) { setFrozen(null); onDenied(); return; }
      if (failure instanceof CapacityRequestError && [400, 409, 413, 415, 422].includes(failure.status)) setFrozen(null);
      setError(capacityError(failure));
    } } finally { sending.current = false; if (alive.current) setBusy(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || frozen || saved) return;
    const data = new FormData(event.currentTarget), text = (name: string) => String(data.get(name) ?? "").trim();
    try {
      const nextProfile = { name: text("name"), status: text("status"), dailyCapacityUnits: text("dailyCapacityUnits") ? Number(text("dailyCapacityUnits")) : null,
        weekly, exceptions, cutoffTime: text("cutoffTime") || null, bindings: bindings.map(binding => ({ capabilityVersionId: binding.capabilityVersionId, unitsPerItem: Number(binding.unitsPerItem) })),
        evidenceReference: text("evidenceReference"), notes: text("notes") };
      const body = record ? ReviseFactoryCapacityPoolSchema.parse({ expectedVersion: record.versionNumber, profile: nextProfile, idempotencyKey: crypto.randomUUID() })
        : CreateFactoryCapacityPoolSchema.parse({ factoryVersionId: factory.versionId, code: text("code"), timeZone: text("timeZone"), unit: text("unit"), profile: nextProfile, idempotencyKey: crypto.randomUUID() });
      void send(body);
    } catch { setError("请核对七日区间 例外日期 整数额度 能力用量与实际依据 启用时不能留空额度或绑定"); }
  }
  return <RecordDialog title={record ? "修订共享产能池" : "新增共享产能池"} onClose={() => saved ? onSaved(saved) : onClose()} protectEdits><div className="fc-workspace">
    {saved ? <CapacityPoolReceipt saved={saved} onFinish={() => onSaved(saved)} />
      : <form className="fc-form" aria-label={record ? "修订共享产能池" : "新增共享产能池"} onSubmit={submit}>
        <p>以实际工作规则和依据登记 额度留空表示未知 不从旧日产能参考值补填 跨午夜工作须拆成两个当地日</p>
        {error && <p className="fc-error" role="alert">{error}</p>}
        {Boolean(frozen) && !busy && <div className="fc-note" role="status"><p>原响应尚未确认 本页已固定原正文与原提交键 不得改填后重复建立</p><button type="button" onClick={() => void send(frozen)}>按原正文与原键核对保存结果</button><p>关闭页面会丢失本页重试副本 这不是跨会话原提交恢复</p></div>}
        <fieldset disabled={busy} inert={!!frozen} aria-disabled={!!frozen}>
          <div className="fc-grid"><label>产能池名称<input name="name" required maxLength={200} defaultValue={profile?.name ?? ""} /></label><label>状态<select name="status" defaultValue={profile?.status ?? "draft"}><option value="draft">草稿</option><option value="active">启用</option><option value="paused">暂停</option><option value="archived">归档</option></select></label>
            {record ? <p className="fc-full">固定编码 {record.code} · 时区 {record.timeZone} · 产能单位 {capacityUnitName(record.unit)} · 原版本 V{record.versionNumber}<br />编码 时区和单位不能在原池内更改</p>
              : <><label>固定资源池编码<input name="code" required maxLength={64} pattern={"[A-Za-z0-9][A-Za-z0-9_.\\-]{0,63}"} /></label>
                <label>工厂实际 IANA 时区<input name="timeZone" required maxLength={80} defaultValue={factory.profile.timeZone ?? ""} placeholder="例如 Asia/Shanghai" /></label>
                <label>固定产能单位<select name="unit" defaultValue="each"><option value="each">件产能单位</option><option value="minute">分钟</option></select></label></>}
            <label>每日产能额度<input type="number" name="dailyCapacityUnits" min={0} max={1_000_000_000} step={1} defaultValue={profile?.dailyCapacityUnits ?? ""} placeholder="未知时留空" /></label>
            <label>当地截单时间<input name="cutoffTime" type="time" defaultValue={profile?.cutoffTime ?? ""} /></label>
          </div>
          <fieldset><legend>每周工厂当地工作区间</legend>{weekdays.map((name, index) => <div className="fc-weekday" key={name}><strong>{name}</strong><IntervalsEditor name={name} values={weekly.find(day => day.weekday === index + 1)?.intervals ?? []} onChange={intervals => setWeekly(days => days.map(day => day.weekday === index + 1 ? { ...day, intervals } : day))} /></div>)}</fieldset>
          <fieldset><legend>当地日期例外 覆盖该日整份规则</legend>{exceptions.map((day, index) => <div className="fc-weekday" key={index}><div className="fc-grid"><label>例外日期<input aria-label={`例外日期${index + 1}`} type="date" min="2000-01-01" max="2099-12-31" required value={day.localDate} onChange={event => setExceptions(days => days.map((item, i) => i === index ? { ...item, localDate: event.target.value } : item))} /></label>
            <label>例外产能额度<input aria-label={`例外产能额度${index + 1}`} type="number" min={0} max={1_000_000_000} required value={day.capacityUnits} onChange={event => setExceptions(days => days.map((item, i) => i === index ? { ...item, capacityUnits: Number(event.target.value) } : item))} /></label></div>
            <IntervalsEditor name={`例外${index + 1}`} values={day.intervals} onChange={intervals => setExceptions(days => days.map((item, i) => i === index ? { ...item, intervals, ...(!intervals.length ? { capacityUnits: 0 } : {}) } : item))} />
            <button type="button" onClick={() => setExceptions(days => days.filter((_, i) => i !== index))}>移除此日期例外</button></div>)}
            <button type="button" disabled={exceptions.length >= 366} onClick={() => setExceptions(days => [...days, { localDate: "", intervals: [], capacityUnits: 0 }])}><Plus size={14} aria-hidden="true" />增加日期例外</button></fieldset>
          <fieldset><legend>每件产品的真实资源用量</legend><p>相同资源池可绑定多个能力 所有能力共同占用该池 不以不同产品拆开余额</p>{bindings.map((binding, index) => <div className="fc-binding" key={index}>
            <div><label>固定能力版本<select aria-label={`固定能力版本${index + 1}`} required value={binding.manual ? "history" : binding.capabilityVersionId} onChange={event => setBindings(rows => rows.map((row, i) => i === index ? { ...row, manual: event.target.value === "history", capabilityVersionId: event.target.value === "history" ? "" : event.target.value } : row))}><option value="">选择实际能力版本</option>
              {capabilities.map(capability => <option key={capability.versionId} value={capability.versionId}>{capability.profile.name} · V{capability.versionNumber}</option>)}<option value="history">使用已核对的历史能力版本 ID</option></select></label>
              {binding.manual && <label>已核对历史能力版本 ID<input aria-label={`已核对历史能力版本 ID${index + 1}`} required value={binding.capabilityVersionId} maxLength={36} onChange={event => setBindings(rows => rows.map((row, i) => i === index ? { ...row, capabilityVersionId: event.target.value } : row))} /><small>仅填写本工厂版本历史或原生产凭据中已读取的真实 ID 保存时会验证归属 不替换为当前能力</small></label>}</div>
            <label>每件占用单位<input aria-label={`每件占用单位${index + 1}`} type="number" min={1} max={1_000_000} step={1} required value={binding.unitsPerItem} onChange={event => setBindings(rows => rows.map((row, i) => i === index ? { ...row, unitsPerItem: event.target.value } : row))} /></label>
            <button type="button" aria-label={`移除能力绑定${index + 1}`} onClick={() => setBindings(rows => rows.filter((_, i) => i !== index))}><Trash2 size={14} aria-hidden="true" /></button></div>)}
            <button type="button" disabled={bindings.length >= 100} onClick={() => setBindings(rows => [...rows, { capabilityVersionId: "", unitsPerItem: "" }])}><Plus size={14} aria-hidden="true" />增加能力绑定</button></fieldset>
          <label>实际产能依据<input name="evidenceReference" maxLength={2000} defaultValue={profile?.evidenceReference ?? ""} placeholder="现场核对或工厂确认的安全凭据编号" /></label><label>产能规则备注<textarea name="notes" maxLength={4000} rows={3} defaultValue={profile?.notes ?? ""} /></label>
        </fieldset>
        <footer className="fc-actions"><button data-record-cancel type="button" disabled={busy} onClick={onClose}>取消填写</button><button className="primary" disabled={busy || !!frozen}>{busy ? "正在登记原资源池版本" : "保存产能池版本"}</button></footer>
      </form>}
  </div></RecordDialog>;
}
