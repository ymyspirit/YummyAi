"use client";

import type {
  PersonalizationTemplateVersion,
  PersonalizationTemplateSourceInspection,
  PodPersonalizationOptionsView,
} from "@yummyai/contracts/pod/personalization";
import { BadgeCheck, CircleAlert, CopyPlus, FileScan, Layers3, Link2, LoaderCircle, Plus, ShieldCheck } from "lucide-react";
import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";

import {
  createBlankPersonalizationTemplate,
  clonePersonalizationTemplate,
  createTemplateSourceInspection,
  createSkuTemplateBinding,
  confirmTemplateSourceInspection,
  reviewPersonalizationTemplate,
  type PodGovernanceActionState,
} from "./pod-governance-actions";

const idle: PodGovernanceActionState = { message: "", status: "idle" };

export function PodPersonalizationPanel({
  error,
  options,
  inspections,
  templates,
}: {
  error?: string;
  options?: PodPersonalizationOptionsView;
  inspections: PersonalizationTemplateSourceInspection[];
  templates: PersonalizationTemplateVersion[];
}) {
  const activeInspectionKey = inspections.filter((item) => item.status === "queued" || item.status === "running")
    .map((item) => `${item.id}:${item.status}`).join("|");
  useEffect(() => {
    if (!activeInspectionKey) return;
    const timer = window.setTimeout(() => window.location.reload(), 2_500);
    return () => window.clearTimeout(timer);
  }, [activeInspectionKey]);
  return (
    <section className="pod-governance-panel" aria-labelledby="pod-template-console-title">
      <header>
        <div><p>TEMPLATE CONTROL</p><h3 id="pod-template-console-title">来图定制模板控制台</h3></div>
        <span>{templates.length} VERSIONS</span>
      </header>
      {error ? <p className="pod-governance-error"><CircleAlert size={14} />{error}</p> : null}
      {!error ? (
        <div className="pod-governance-layout">
          <div className="pod-template-form-stack">
            <CreateImportInspectionForm options={options} />
            <CreateTemplateForm />
          </div>
          <div className="pod-template-ledger">
            <header><strong>导入检查与槽位确认</strong><span>PNG / PSD · 异步解析 · 人工确认</span></header>
            {!inspections.length ? <p className="pod-governance-empty">尚无导入检查。选择已授权的 PNG 或 PSD 源文件开始解析。</p> : null}
            {inspections.slice(0, 8).map((inspection) => (
              <InspectionRecord
                confirmed={templates.some((template) => template.sourceInspectionId === inspection.id)}
                inspection={inspection}
                key={inspection.id}
              />
            ))}
            <header><strong>不可覆盖模板版本</strong><span>同名图片槽位自动复用顾客字段</span></header>
            {!templates.length ? <p className="pod-governance-empty">尚无模板版本。先创建空白模板，再审核并绑定 SKU。</p> : null}
            {templates.slice(0, 12).map((template) => (
              <TemplateRecord key={template.id} options={options} template={template} />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function CreateImportInspectionForm({ options }: { options?: PodPersonalizationOptionsView }) {
  const [state, action] = useActionState(createTemplateSourceInspection, idle);
  const sources = (options?.sourceAssets ?? []).filter((asset) => (
    asset.mediaType === "image/png"
    || asset.mediaType === "image/vnd.adobe.photoshop"
    || /\.(png|psd)$/i.test(asset.fileName)
  ));
  return (
    <form action={action} className="pod-template-form pod-template-import-form">
      <div className="pod-form-heading"><FileScan size={15} /><div><strong>导入 PNG / PSD 模板</strong><span>锁定源文件版本，异步解析画布、图层与四类槽位。</span></div></div>
      <label>
        <span>已授权模板源 *</span>
        <select disabled={!sources.length} name="sourceAsset" required>
          <option value="">{sources.length ? "选择 PNG 或 PSD" : "暂无可用 PNG / PSD"}</option>
          {sources.map((asset) => <option key={`${asset.id}:${asset.version}`} value={`${asset.id}:${asset.version}`}>{asset.fileName} · V{asset.version}</option>)}
        </select>
      </label>
      <p className="pod-template-boundary"><ShieldCheck size={13} />仅接受授权域且权利已批准的非顾客订单素材；解析结果仍需人工确认。</p>
      <footer><Notice state={state} /><PendingButton disabled={!sources.length} icon="scan" label="创建解析任务" /></footer>
    </form>
  );
}

function InspectionRecord({ confirmed, inspection }: { confirmed: boolean; inspection: PersonalizationTemplateSourceInspection }) {
  return (
    <article className="pod-inspection-record">
      <header>
        <FileScan size={15} />
        <div><strong>{inspection.source.toUpperCase()} 源文件检查</strong><span>{inspection.sourceAssetId} · V{inspection.sourceAssetVersion} · {inspection.parserKey}@{inspection.parserVersion}</span></div>
        <span className={`pod-record-status ${inspection.status}`}>{inspectionStatus(inspection.status)}</span>
      </header>
      {inspection.status === "queued" || inspection.status === "running" ? (
        <p className="pod-inspection-progress"><LoaderCircle className="spin" size={13} />解析器正在读取画布和图层记录，页面将自动刷新。</p>
      ) : null}
      {inspection.status === "failed" ? <p className="pod-governance-error"><CircleAlert size={13} />{inspection.errorCode}: {inspection.errorMessage}</p> : null}
      {inspection.status === "completed" && inspection.canvas ? (
        <>
          <div className="pod-inspection-summary">
            <span><b>画布</b>{inspection.canvas.width}×{inspection.canvas.height}</span>
            <span><b>DPI</b>{inspection.canvas.dpi}</span>
            <span><b>色彩</b>{inspection.canvas.colorMode.toUpperCase()}</span>
            <span><b>槽位</b>{inspection.slots.length}</span>
          </div>
          {inspection.warnings.length ? <ul className="pod-inspection-warnings">{inspection.warnings.slice(0, 8).map((warning, index) => <li key={`${warning.code}:${index}`}><CircleAlert size={11} /><span><b>{warning.code}</b>{warning.message}</span></li>)}</ul> : null}
          {confirmed ? <p className="pod-confirmed-note"><BadgeCheck size={13} />该检查已生成不可变模板版本。</p> : <ConfirmInspectionForm inspection={inspection} />}
        </>
      ) : null}
    </article>
  );
}

function ConfirmInspectionForm({ inspection }: { inspection: PersonalizationTemplateSourceInspection }) {
  const [state, action] = useActionState(confirmTemplateSourceInspection, idle);
  return (
    <form action={action} className="pod-inspection-confirm-form">
      <input name="inspectionId" type="hidden" value={inspection.id} />
      <input name="slotCount" type="hidden" value={inspection.slots.length} />
      <div className="pod-form-heading compact"><Layers3 size={14} /><div><strong>确认四类槽位</strong><span>可修正分类、填充方式、是否由顾客替换及同名复用标识。</span></div></div>
      <label><span>模板名称 *</span><input defaultValue={`导入模板 ${inspection.sourceAssetId.slice(0, 8)}`} maxLength={200} name="name" required /></label>
      <div className="pod-inspection-slot-table" role="table" aria-label="检测到的模板槽位">
        {inspection.slots.map((slot, index) => (
          <fieldset key={slot.stableKey}>
            <legend>{slot.stableKey} · {slot.confidencePermille / 10}%</legend>
            <input name={`slot.${index}.stableKey`} type="hidden" value={slot.stableKey} />
            <p title={slot.sourceLayerPath.join(" / ")}>{slot.sourceLayerPath.join(" / ")}</p>
            <div className="pod-inline-fields two">
              <label><span>槽位名称</span><input defaultValue={slot.name} maxLength={200} name={`slot.${index}.name`} required /></label>
              <label><span>分类</span><select defaultValue={slot.kind} name={`slot.${index}.kind`}><option value="image">图片</option><option value="text">文字</option><option value="decoration">装饰</option><option value="background">背景</option></select></label>
            </div>
            <div className="pod-inline-fields two">
              <label><span>填充方式</span><select defaultValue={slot.fillMode} name={`slot.${index}.fillMode`}><option value="cover">裁切填充</option><option value="contain">完整适配</option><option value="stretch">拉伸</option><option value="tile">平铺</option><option value="none">不适用</option></select></label>
              <label><span>复用标识</span><input defaultValue={slot.reuseLabel} maxLength={120} name={`slot.${index}.reuseLabel`} placeholder="可选" /></label>
            </div>
            <label className="pod-inspection-checkbox"><input defaultChecked={slot.replaceable} name={`slot.${index}.replaceable`} type="checkbox" /><span>允许顾客素材替换</span></label>
            <small>位置 {slot.geometry.x}, {slot.geometry.y} · {slot.geometry.width}×{slot.geometry.height}</small>
          </fieldset>
        ))}
      </div>
      {inspection.warnings.length ? <label className="pod-inspection-checkbox pod-warning-ack"><input name="acknowledgeWarnings" required type="checkbox" /><span>我已逐项审阅解析警告，并确认当前槽位分类可用于模板草稿。</span></label> : <input name="acknowledgeWarnings" type="hidden" value="on" />}
      <footer><Notice state={state} /><PendingButton icon="approve" label="确认并创建模板版本" /></footer>
    </form>
  );
}

function CreateTemplateForm() {
  const [state, action] = useActionState(createBlankPersonalizationTemplate, idle);
  return (
    <form action={action} className="pod-template-form">
      <div className="pod-form-heading"><Plus size={15} /><div><strong>新建空白模板</strong><span>保存画布与槽位快照；后续修改会生成新版本。</span></div></div>
      <label><span>模板名称 *</span><input maxLength={200} name="name" placeholder="双面宠物挂牌" required /></label>
      <fieldset>
        <legend>画布</legend>
        <div className="pod-inline-fields four">
          <NumberInput label="宽" name="canvasWidth" value={3000} />
          <NumberInput label="高" name="canvasHeight" value={3000} />
          <NumberInput label="DPI" name="canvasDpi" value={300} />
          <label><span>色彩</span><select name="colorMode"><option value="rgb">RGB</option><option value="cmyk">CMYK</option><option value="grayscale">灰度</option></select></label>
        </div>
        <label><span>背景标识</span><input maxLength={120} name="background" placeholder="#ffffff / transparent" /></label>
      </fieldset>
      <SlotFields label="主图片槽位" name="顾客图片" prefix="primary" stableKey="front.photo" x={0} y={0} width={1400} height={2200} />
      <SlotFields hint="与主槽位同名时复用同一份顾客图片；清空 Stable key 可跳过。" label="复用图片槽位" name="顾客图片" prefix="secondary" stableKey="back.photo" x={1600} y={0} width={1400} height={2200} />
      <SlotFields hint="清空 Stable key 可跳过文字槽位。" label="文字槽位" name="顾客姓名" prefix="caption" stableKey="caption" x={300} y={2450} width={2400} height={300} />
      <footer><Notice state={state} /><PendingButton icon="plus" label="创建模板版本" /></footer>
    </form>
  );
}

function SlotFields({
  height,
  hint,
  label,
  name,
  prefix,
  stableKey,
  width,
  x,
  y,
}: {
  height: number;
  hint?: string;
  label: string;
  name: string;
  prefix: "primary" | "secondary" | "caption";
  stableKey: string;
  width: number;
  x: number;
  y: number;
}) {
  return (
    <fieldset>
      <legend>{label}</legend>
      {hint ? <p>{hint}</p> : null}
      <div className="pod-inline-fields two">
        <label><span>Stable key *</span><input defaultValue={stableKey} maxLength={120} name={`${prefix}StableKey`} /></label>
        <label><span>槽位名称 *</span><input defaultValue={name} maxLength={200} name={`${prefix}Name`} /></label>
      </div>
      <div className="pod-inline-fields four">
        <NumberInput label="X" name={`${prefix}X`} value={x} />
        <NumberInput label="Y" name={`${prefix}Y`} value={y} />
        <NumberInput label="宽" name={`${prefix}Width`} value={width} />
        <NumberInput label="高" name={`${prefix}Height`} value={height} />
      </div>
    </fieldset>
  );
}

function TemplateRecord({ options, template }: { options?: PodPersonalizationOptionsView; template: PersonalizationTemplateVersion }) {
  const mappings = defaultMappings(template);
  return (
    <article className="pod-template-record">
      <header>
        <div><strong>{template.name}</strong><span>V{template.versionNumber} · {templateSourceLabel(template.source)} · {template.canvas.width}×{template.canvas.height} / {template.canvas.dpi} DPI{template.sourceTemplateVersionId ? ` · 来源 ${template.sourceTemplateVersionId.slice(0, 8)}` : ""}</span></div>
        <span className={`pod-record-status ${template.status}`}>{templateStatus(template.status)}</span>
      </header>
      <div className="pod-slot-list">
        {template.slots.map((slot) => (
          <span key={slot.id} title={slot.reuseLabel}><b>{slot.kind}</b>{slot.name}<code>{slot.stableKey}</code>{slot.reuseLabel ? <em>复用</em> : null}</span>
        ))}
      </div>
      {(template.status === "draft" || template.status === "pending_review") ? <TemplateReviewForms id={template.id} /> : null}
      {template.status === "approved" ? (
        <>
          <TemplateCloneForm template={template} />
          <TemplateBindingForm mappings={mappings} options={options} template={template} />
        </>
      ) : null}
    </article>
  );
}

function TemplateCloneForm({ template }: { template: PersonalizationTemplateVersion }) {
  const [state, action] = useActionState(clonePersonalizationTemplate, idle);
  return (
    <form action={action} className="pod-template-copy-form">
      <input name="id" type="hidden" value={template.id} />
      <div className="pod-form-heading compact"><CopyPlus size={14} /><div><strong>复制为组织草稿</strong><span>复制画布、槽位和授权素材引用，并固定源模板版本。</span></div></div>
      <label><span>新模板名称 *</span><input defaultValue={`${template.name} 副本`} maxLength={200} name="name" required /></label>
      <footer><Notice state={state} /><PendingButton icon="copy" label="复制模板" /></footer>
    </form>
  );
}

function TemplateReviewForms({ id }: { id: string }) {
  const [approveState, approveAction] = useActionState(reviewPersonalizationTemplate, idle);
  const [rejectState, rejectAction] = useActionState(reviewPersonalizationTemplate, idle);
  return (
    <div className="pod-review-grid">
      <form action={approveAction}><input name="id" type="hidden" value={id} /><input name="decision" type="hidden" value="approve" /><PendingButton icon="approve" label="批准模板" /><Notice state={approveState} /></form>
      <form action={rejectAction}><input name="id" type="hidden" value={id} /><input name="decision" type="hidden" value="reject" /><input maxLength={2000} name="reason" placeholder="驳回原因（必填）" required /><PendingButton icon="reject" label="驳回" /><Notice state={rejectState} /></form>
    </div>
  );
}

function TemplateBindingForm({
  mappings,
  options,
  template,
}: {
  mappings: Map<string, string>;
  options?: PodPersonalizationOptionsView;
  template: PersonalizationTemplateVersion;
}) {
  const [state, action] = useActionState(createSkuTemplateBinding, idle);
  const skus = options?.skus ?? [];
  return (
    <form action={action} className="pod-binding-form">
      <input name="templateVersionId" type="hidden" value={template.id} />
      <div className="pod-form-heading compact"><Link2 size={14} /><div><strong>绑定 SKU 与顾客字段</strong><span>同名槽位默认写入相同字段。</span></div></div>
      <div className="pod-inline-fields two">
        <label><span>SKU *</span><select disabled={!skus.length} name="skuId" required><option value="">{skus.length ? "选择 SKU" : "暂无 SKU"}</option>{skus.map((sku) => <option key={sku.id} value={sku.id}>{sku.code} · {sku.productName}</option>)}</select></label>
        <label><span>尺寸 *</span><input defaultValue="M" maxLength={120} name="sizeLabel" required /></label>
      </div>
      <div className="pod-mapping-grid">
        {template.slots.filter((slot) => slot.replaceable).map((slot) => (
          <label key={slot.id}><span>{slot.stableKey}</span><input defaultValue={mappings.get(slot.stableKey)} name={`slotField.${slot.stableKey}`} pattern="[a-z][a-z0-9_]{0,79}" required /></label>
        ))}
      </div>
      <footer><Notice state={state} /><PendingButton disabled={!skus.length} icon="link" label="创建显式绑定" /></footer>
    </form>
  );
}

function defaultMappings(template: PersonalizationTemplateVersion) {
  const result = new Map<string, string>();
  const groups = new Map<string, string>();
  let image = 0;
  let text = 0;
  for (const slot of template.slots.filter((item) => item.replaceable)) {
    const group = `${slot.kind}:${slot.reuseLabel ?? slot.stableKey}`;
    let field = groups.get(group);
    if (!field) {
      field = slot.kind === "image" ? `customer_image_${++image}` : `customer_text_${++text}`;
      groups.set(group, field);
    }
    result.set(slot.stableKey, field);
  }
  return result;
}

function NumberInput({ label, name, value }: { label: string; name: string; value: number }) {
  return <label><span>{label}</span><input defaultValue={value} name={name} required type="number" /></label>;
}

function PendingButton({ disabled = false, icon, label }: { disabled?: boolean; icon: "approve" | "copy" | "link" | "plus" | "reject" | "scan"; label: string }) {
  const { pending } = useFormStatus();
  const graphic = pending ? <LoaderCircle className="spin" size={13} /> : icon === "approve" ? <ShieldCheck size={13} /> : icon === "copy" ? <CopyPlus size={13} /> : icon === "link" ? <Link2 size={13} /> : icon === "reject" ? <CircleAlert size={13} /> : icon === "scan" ? <FileScan size={13} /> : <Plus size={13} />;
  return <button disabled={disabled || pending} type="submit">{graphic}{pending ? "正在提交" : label}</button>;
}

function templateSourceLabel(source: PersonalizationTemplateVersion["source"]) {
  return ({ blank: "空白", png: "PNG", psd: "PSD", popular_template: "组织模板副本" } as const)[source];
}

function Notice({ state }: { state: PodGovernanceActionState }) {
  if (state.status === "idle") return null;
  return <p className={`pod-governance-notice ${state.status}`} role="status">{state.status === "success" ? <BadgeCheck size={13} /> : <CircleAlert size={13} />}{state.message}</p>;
}

function templateStatus(status: PersonalizationTemplateVersion["status"]) {
  return ({ draft: "草稿", pending_review: "待审核", approved: "已批准", rejected: "已驳回", archived: "已归档" } as const)[status];
}

function inspectionStatus(status: PersonalizationTemplateSourceInspection["status"]) {
  return ({ queued: "排队中", running: "解析中", completed: "待确认", failed: "失败" } as const)[status];
}
