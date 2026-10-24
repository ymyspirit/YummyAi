"use client";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { CreateQualityStandardInputSchema } from "@yummyai/contracts/order/production";
import { OrderCenterOptionsSchema, type OrderCenterOptions } from "@yummyai/contracts/order/workspace";
import { centerRead, centerRequest } from "./order-center-model";
import { useFormEdits, formFingerprint } from "../navigation/use-form-edits";
import { useLeaveGuard } from "../navigation/use-leave-guard";
import "./order-centers.css";

export function OrderFulfillmentSettings() {
  const [options, setOptions] = useState<OrderCenterOptions | null>(null), [reading, setReading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [refresh, setRefresh] = useState(0);
  const forms = useFormEdits(); useLeaveGuard(forms.dirty, busy);
  useEffect(() => {
    const abort = new AbortController(); setReading(true); setError("");
    void centerRead("options", abort.signal).then(value => { if (!abort.signal.aborted) setOptions(OrderCenterOptionsSchema.parse(value)); })
      .catch(() => { if (!abort.signal.aborted) setError("履约配置暂时无法读取，请重试。"); }).finally(() => { if (!abort.signal.aborted) setReading(false); });
    return () => abort.abort();
  }, [refresh]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || reading || !options) return;
    const form = event.currentTarget, fingerprint = formFingerprint(form), data = new FormData(form);
    setBusy(true); setError(""); setNotice("");
    try {
      const input = CreateQualityStandardInputSchema.parse({ name: String(data.get("name")), minimumScoreBps: Math.round(Number(data.get("score")) * 100),
        criteria: [{ code: "GENERAL", label: String(data.get("criterion")), weightBps: 10000, blocking: true }] });
      await centerRequest("quality-standards", input); forms.commit(form, fingerprint); setNotice("新质检标准版本已保存。订单选择后固定该版本，原检验记录继续保留。"); setRefresh(value => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "标准保存失败，请保留填写内容后重试。"); }
    finally { setBusy(false); }
  }
  return <main className="oc-page" ref={forms.ref} onInputCapture={forms.check} onChangeCapture={forms.check}>
    <header className="oc-header"><div><h1>履约配置</h1><p>维护质检标准。工厂承接能力和 ShipOS 渠道对应关系在所属供应商档案配置。</p></div><Link className="oc-button" href="/production">返回生产列表</Link></header>
    {error && <p className="oc-error" role="alert">{error}</p>}{notice && <p className="oc-notice" role="status">{notice}</p>}
    <section className="oc-section" aria-label="质检标准配置" aria-busy={reading}><div className="oc-whole-heading"><h2>质检标准</h2><button className="oc-button" disabled={busy || reading} onClick={() => setRefresh(value => value + 1)}>刷新标准</button></div>
      {reading && <p role="status">正在读取已保存标准…</p>}
      {!reading && options && (!options.standards.length ? <p className="oc-hint">尚未配置质检标准，先保存标准，再在整单生产中登记检验。</p> : <div className="oc-table-wrap"><table className="oc-table"><thead><tr><th>标准名称</th><th>版本</th><th>最低合格分数</th></tr></thead><tbody>{options.standards.map(standard => <tr key={standard.id}><td>{standard.name}</td><td>V{standard.versionNumber}</td><td>{standard.minimumScoreBps / 100} 分</td></tr>)}</tbody></table></div>)}
      <form className="oc-operation-form" aria-label="维护质检标准" onSubmit={save}><fieldset disabled={busy || reading || !options} className="oc-form-grid">
        <label>标准名称<input name="name" required maxLength={200} /></label><label>合格分数<input name="score" required type="number" min={0} max={100} step="0.01" /></label>
        <label className="oc-full-field">检验内容<input name="criterion" required maxLength={300} placeholder="例如每个抱枕的尺寸、图案、缝线和填充检查" /></label>
        <p className="oc-hint oc-full-field">同名保存会创建新版本，已有订单的检验依据保留原版本。</p><button className="oc-button primary">保存新标准版本</button>
      </fieldset></form>
    </section><p className="oc-hint"><Link href="/suppliers">管理工厂与物流连接配置</Link></p>
  </main>;
}
