"use client";

import { useState, type FormEvent } from "react";
import { ClipboardCheck, X } from "lucide-react";
import {
  FactoryQuantityReportInputSchema,
  type FactoryQuantityReportInput,
  type FactoryQuantityReportView,
  type FactoryQuantityWorkspace,
} from "@yummyai/contracts/suppliers/factory-quantity";

type Basis = FactoryQuantityWorkspace["basis"];
type Quantities = FactoryQuantityReportInput["quantities"];
export type FactoryQuantityPending = {
  assignmentId: string;
  contextAuthority: string;
  taskFingerprint: string;
  basis: Basis;
  input: FactoryQuantityReportInput;
};
const buckets: Array<{ key: keyof Quantities; label: string }> = [
  { key: "unstartedQuantity", label: "未开工数量" },
  { key: "inProcessQuantity", label: "在制数量" },
  { key: "completedQuantity", label: "已完工数量" },
  { key: "scrappedQuantity", label: "实际报废数量" },
];
export const factoryQuantityUnit = (unit: Basis["unit"]) =>
  unit === "each" ? "件" : unit === "pair" ? "双" : unit === "set" ? "套" : "单位待核对";

export function FactoryPhysicalQuantities({ quantities, unit }: { quantities: Quantities | null; unit: Basis["unit"] }) {
  return <dl className="fq-counts">{buckets.map(({ key, label }) => <div key={key}>
    <dt>{label}</dt><dd>{quantities?.[key] === null || quantities?.[key] === undefined
      ? "未知 待实际清点" : String(quantities[key]) + " " + factoryQuantityUnit(unit)}</dd>
  </div>)}</dl>;
}

export function FactoryQuantityBasisSummary({ basis }: { basis: Basis }) {
  return <section className="fq-basis" aria-label="完整生产版本清点范围">
    <dl className="fq-counts">
      <div><dt>完整生产版本原数量</dt><dd>{basis.quantity} {factoryQuantityUnit(basis.unit)}</dd></div>
      <div><dt>固定生产版本</dt><dd>V{basis.versionNumber}</dd></div>
      <div><dt>此前运营已核准停做</dt><dd>{basis.stoppedQuantity} {factoryQuantityUnit(basis.unit)}</dd></div>
    </dl>
    <p>本报告覆盖这个生产版本的全部数量 不只覆盖当前看到的交付文件或某一个工序</p>
    <details><summary>核对原文件和本人接受凭据</summary><dl className="fq-pairs">
      <div><dt>原制作文件校验值</dt><dd><code>{basis.fileChecksum}</code></dd></div>
      <div><dt>原制造清单校验值</dt><dd><code>{basis.manufacturingChecksum ?? "原依据未知"}</code></dd></div>
      <div><dt>本人接受回执</dt><dd><code>{basis.acceptedFeedbackId ?? "尚无符合条件的本人接受回执"}</code></dd></div>
      <div><dt>本次清点读取依据</dt><dd><code>{basis.fingerprint}</code></dd></div>
    </dl></details>
    <details><summary>最近运营核准保存的实物数量</summary>
      <FactoryPhysicalQuantities quantities={basis.approvedQuantities} unit={basis.unit} />
      <p>这是上次核准保存值 并非今天重新清点 未知不能当作 0</p>
    </details>
  </section>;
}

export function FactoryQuantityOriginalSummary({ pending }: { pending: FactoryQuantityPending }) {
  const { input, basis } = pending;
  return <section className="fq-original" aria-label="原清点报告填写">
    <h4>本次保留的完整原报告</h4>
    <p>完整生产版本 V{basis.versionNumber} · 原数量 {basis.quantity} {factoryQuantityUnit(basis.unit)} · 此前核准停做 {basis.stoppedQuantity} {factoryQuantityUnit(basis.unit)}</p>
    <FactoryPhysicalQuantities quantities={input.quantities} unit={basis.unit} />
    <dl className="fq-pairs">
      <div><dt>实际清点时间</dt><dd>{input.observedAt}</dd></div>
      <div><dt>凭证编号</dt><dd>{input.evidenceCode}</dd></div>
      <div><dt>清点依据</dt><dd>{input.reference}</dd></div>
      <div><dt>原请求编号</dt><dd><code>{input.idempotencyKey}</code></dd></div>
      <div><dt>本人原接受回执</dt><dd><code>{input.acceptedFeedbackId}</code></dd></div>
      <div><dt>原文件校验值</dt><dd><code>{input.fileChecksum}</code></dd></div>
      <div><dt>原制造清单校验值</dt><dd><code>{input.manufacturingChecksum}</code></dd></div>
      <div><dt>原清点依据校验值</dt><dd><code>{input.expectedBasisFingerprint}</code></dd></div>
    </dl><p>已明确确认覆盖完整生产版本 重试继续使用以上原填写和同一请求编号</p>
  </section>;
}

export function FactoryQuantityReportSummary({ report, unit }: { report: FactoryQuantityReportView; unit: Basis["unit"] }) {
  return <div className="fq-report-summary">
    <p>工厂数量报告 <code>{report.reportId}</code></p>
    <FactoryPhysicalQuantities quantities={report.input.quantities} unit={unit} />
    <p>实际清点 {report.input.observedAt} · 登记 {report.recordedAt}</p>
    <p>凭证 {report.input.evidenceCode} · 依据 {report.input.reference}</p>
    <p>本人接受回执 <code>{report.input.acceptedFeedbackId}</code></p>
    <details><summary>读取本报告原文件与请求凭据</summary><dl className="fq-pairs">
      <div><dt>原请求编号</dt><dd><code>{report.input.idempotencyKey}</code></dd></div>
      <div><dt>原文件校验值</dt><dd><code>{report.input.fileChecksum}</code></dd></div>
      <div><dt>原制造清单校验值</dt><dd><code>{report.input.manufacturingChecksum}</code></dd></div>
      <div><dt>原清点依据校验值</dt><dd><code>{report.input.expectedBasisFingerprint}</code></dd></div>
    </dl></details>
  </div>;
}

function localDateTime(value = new Date()) {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 23);
}

export function FactoryQuantityForm({ basis, disabled = false, onSubmit, onClose }: {
  basis: Basis;
  disabled?: boolean;
  onSubmit(input: FactoryQuantityReportInput): void;
  onClose(): void;
}) {
  const [error, setError] = useState(""), [observedAt] = useState(() => localDateTime());
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    const data = new FormData(event.currentTarget);
    try {
      const quantities = Object.fromEntries(buckets.map(({ key }) => {
        const text = String(data.get(key) ?? "").trim();
        if (text !== "" && !/^(0|[1-9][0-9]*)$/.test(text)) throw new Error("count");
        return [key, text === "" ? null : Number(text)];
      })) as Quantities;
      const known = Object.values(quantities).filter((value): value is number => value !== null);
      const total = known.reduce((sum, value) => sum + value, 0) + basis.stoppedQuantity;
      if (total > basis.quantity || known.length === buckets.length && total !== basis.quantity) {
        setError("四类实物互不重叠 全部已知时加上此前核准停做须等于完整生产版本原数量"); return;
      }
      const parsed = FactoryQuantityReportInputSchema.safeParse({
        idempotencyKey: crypto.randomUUID(),
        fileChecksum: basis.fileChecksum, manufacturingChecksum: basis.manufacturingChecksum,
        acceptedFeedbackId: basis.acceptedFeedbackId, expectedBasisFingerprint: basis.fingerprint,
        wholeProductionConfirmed: data.get("wholeProductionConfirmed") === "on",
        observedAt: new Date(String(data.get("observedAt"))).toISOString(),
        quantities, evidenceCode: String(data.get("evidenceCode")), reference: String(data.get("reference")),
      });
      if (!parsed.success) { setError("请核对实际清点时间 整数数量 凭证编号和完整版本确认"); return; }
      setError(""); onSubmit(parsed.data);
    } catch { setError("请核对实际清点时间和整数数量 空白仅表示尚未清点"); }
  }
  return <form className="fq-form" aria-label="登记工厂实际清点" onSubmit={submit}>
    <h4>登记工厂实际清点</h4>
    <p>空白表示未知 0 表示已经实际确认没有 四类数量互斥 已完工包含已经交运的数量 不合格不自动算报废</p>
    <fieldset disabled={disabled}>
      <div className="fq-fields">{buckets.map(({ key, label }) => <label key={key}>
        {label}<span className="fq-hint">{factoryQuantityUnit(basis.unit)} · 不清楚请留空</span>
        <input name={key} type="text" inputMode="numeric" pattern="0|[1-9][0-9]*" maxLength={6} placeholder="未知" autoComplete="off" />
      </label>)}
        <label>实际清点时间<input name="observedAt" type="datetime-local" step="0.001" required defaultValue={observedAt} /></label>
        <label>清点凭证编号<input name="evidenceCode" required maxLength={160} pattern={"[A-Z0-9_:\\-]{1,160}"} placeholder="如 COUNT_20261021_01" autoComplete="off" /></label>
        <label className="fq-wide">清点依据<input name="reference" required maxLength={200} placeholder="填写本次人工清点单或核对依据" autoComplete="off" /></label>
        <label className="fq-confirm fq-wide"><input type="checkbox" name="wholeProductionConfirmed" required />
          我已核对完整生产版本 V{basis.versionNumber} 的全部 {basis.quantity} {factoryQuantityUnit(basis.unit)} 与原文件 本报告不是只报某一工序或部分交付
        </label>
      </div>
      <div className="fq-actions"><button className="fp-primary" type="submit"><ClipboardCheck size={15} aria-hidden="true" />登记实际清点报告</button>
        <button type="button" onClick={onClose}><X size={15} aria-hidden="true" />关闭填写</button></div>
    </fieldset>
    {error && <p role="alert" className="fp-alert">{error}</p>}
    <p className="fq-hint">这是工厂本人报告 运营另行核准 不会自动停做 退款 返库或新建补做</p>
  </form>;
}
