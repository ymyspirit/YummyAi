"use client";
import { SpecificationFactsSchema, specificationFactProblems } from "@yummyai/contracts/catalog/development";
import { SpecificationFactFields, emptySpecificationFactDraft, specificationFactsFromDraft, type SpecificationFactDraft } from "./specification-fact-fields";

import { Fragment, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import Link from "next/link";
import { Plus, X } from "lucide-react";
import type { DevelopmentOptions } from "@yummyai/contracts/catalog/development";
import { useTaskDraft as useMemoryTaskDraft, clearTaskDrafts } from "../navigation/task-draft";
import { catalogSpecificationDraftKey } from "./editor-access";
import { useWorkflowReturn } from "../navigation/use-workflow-return";
import { workflowHref } from "../navigation/workflow-href";
import {
  boundSpecificationAxes,
  expandSpecificationOptions,
  nextSpecificationCode,
  optionSelectionKey,
  specificationAttributesKey,
  splitSpecificationValues,
  type SpecificationAxis,
} from "./specification-options";

function useTaskDraft<T>(prefix: string, field: string, initial: T | (() => T)) {
  const strings = z.record(z.string(), z.string());
  const schema = field === "axes" ? z.array(z.object({ id: z.string(), name: z.string(), values: z.array(z.string()) })) :
    field === "rows" ? z.array(z.object({ key: z.string(), attributes: strings, code: z.string(), name: z.string(), dimensions: z.string(), selected: z.boolean(), existing: z.boolean(), details: z.boolean(), overrides: strings })) :
      field === "confirmed" ? z.boolean() : field === "preview" ? z.string() : strings;
  return useMemoryTaskDraft(prefix, field, initial, { session: true, validate: (value): value is T => schema.safeParse(value).success });
}

type Defaults = SpecificationFactDraft & {
  processProfileVersionId: string;
  canvasPrintSpecVersionId: string;
  stockItemId: string;
};
type Draft = {
  key: string;
  attributes: Record<string, string>;
  code: string;
  name: string;
  dimensions: string;
  selected: boolean;
  existing: boolean;
  details: boolean;
  overrides: Partial<Defaults>;
};

export function SpecificationBatchForm({
  options,
  spuId,
  busy,
  onSave,
}: {
  options: DevelopmentOptions;
  spuId: string;
  busy: boolean;
  onSave: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const workflow = useWorkflowReturn();
  const draftKey = catalogSpecificationDraftKey(options, spuId);
  const existing = options.specifications.filter((spec) => spec.spuId === spuId);
  const [axes, setAxes, axesRecovery] = useTaskDraft<SpecificationAxis[]>(draftKey, "axes", () => {
    const bound = boundSpecificationAxes(existing);
    return bound.length && bound.length <= 4 ? bound : [{ id: "axis-0", name: "尺寸", values: [] }];
  });
  const nextAxis = useRef(
    Math.max(
      axes.length,
      ...axes.map((axis) => Number(axis.id.replace("axis-", "")) + 1).filter(Number.isFinite),
    ),
  );
  const [pending, setPending, pendingRecovery] = useTaskDraft<Record<string, string>>(draftKey, "pending", {});
  const [rows, setRows, rowsRecovery] = useTaskDraft<Draft[]>(draftKey, "rows", []);
  const [previewKey, setPreviewKey, previewRecovery] = useTaskDraft(draftKey, "preview", "");
  const [error, setError] = useState("");
  const [storedConfirmed, setConfirmed, confirmedRecovery] = useTaskDraft(draftKey, "confirmed", false);
  const [defaults, setDefaults, defaultsRecovery] = useTaskDraft<Defaults>(draftKey, "defaults", {
    ...emptySpecificationFactDraft,
    processProfileVersionId: "", canvasPrintSpecVersionId: "", stockItemId: "",
  });
  const recoveryError = axesRecovery || pendingRecovery || rowsRecovery || previewRecovery || confirmedRecovery || defaultsRecovery;
  const confirmed = storedConfirmed && !recoveryError;
  const stale =
    previewKey !== optionSelectionKey(axes) || Object.values(pending).some((v) => v.trim());
  const selected = rows.filter((row) => row.selected && !row.existing);
  const knownCount = rows.filter((row) => row.existing).length;
  const spu = options.spus.find((item) => item.id === spuId);

  function updateAxis(id: string, patch: Partial<SpecificationAxis>) {
    setAxes((current) => current.map((axis) => (axis.id === id ? { ...axis, ...patch } : axis)));
  }
  function addValues(axis: SpecificationAxis) {
    updateAxis(axis.id, {
      values: [...new Set([...axis.values, ...splitSpecificationValues(pending[axis.id] ?? "")])],
    });
    setPending((current) => ({ ...current, [axis.id]: "" }));
  }
  function addAxis(name: string) {
    const id = `axis-${nextAxis.current++}`;
    setAxes((current) => [...current, { id, name, values: [] }]);
  }
  function updateDefaults(patch: Partial<Defaults>) {
    setDefaults((current) => ({ ...current, ...patch }));
    setConfirmed(false);
  }
  function updateRow(key: string, patch: Partial<Draft>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
    if (patch.dimensions !== undefined || patch.selected !== undefined || patch.overrides)
      setConfirmed(false);
  }
  function override(key: string, patch: Partial<Defaults>) {
    setConfirmed(false);
    setRows((current) =>
      current.map((row) =>
        row.key === key ? { ...row, overrides: { ...row.overrides, ...patch } } : row,
      ),
    );
  }
  function preview() {
    try {
      const complete = axes.map((axis) => ({
        ...axis,
        values: [...new Set([...axis.values, ...splitSpecificationValues(pending[axis.id] ?? "")])],
      }));
      const combinations = expandSpecificationOptions(complete);
      const previous = new Map(rows.map((row) => [row.key, row]));
      const known = new Map(
        existing.map((spec) => [specificationAttributesKey(spec.attributes), spec]),
      );
      const used = new Set(
        [...existing.map((spec) => spec.code), ...rows.map((row) => row.code)].map((code) =>
          code.toLowerCase(),
        ),
      );
      setRows(
        combinations.map((attributes) => {
          const key = specificationAttributesKey(attributes),
            saved = known.get(key);
          if (previous.has(key) && !saved) return previous.get(key)!;
          return {
            key,
            attributes,
            code: saved?.code ?? nextSpecificationCode(used),
            name: saved?.name ?? Object.values(attributes).join(" · "),
            dimensions: saved?.facts.dimensions ?? "",
            selected: !saved,
            existing: !!saved,
            details: false,
            overrides: {},
          };
        }),
      );
      setAxes(complete);
      setPending({});
      setPreviewKey(optionSelectionKey(complete));
      setError("");
      setConfirmed(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法生成规格组合");
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (stale || !selected.length) {
      setError("请更新组合预览，并选择需要新增的规格");
      return;
    }
    const codes = new Set(existing.map((spec) => spec.code.toLowerCase()));
    for (const row of selected) {
      const code = row.code.trim().toLowerCase();
      if (codes.has(code)) {
        setError(`规格编号 ${row.code} 已存在或重复，请调整后保存`);
        return;
      }
      codes.add(code);
    }
    const items = selected.map((row) => {
      const values = { ...defaults, ...row.overrides };
      return {
        code: row.code.trim(),
        name: row.name.trim(),
        attributes: row.attributes,
        facts: specificationFactsFromDraft({ ...values, dimensions: row.dimensions }, confirmed),
        processProfileVersionId: values.processProfileVersionId || null,
        canvasPrintSpecVersionId: values.canvasPrintSpecVersionId || null,
        stockItemId: values.stockItemId || null,
      };
    });
    for (const item of items) {
      if (!item.name || item.name.length > 160) { setError("请填写规格名称 名称最多160个字符"); return; }
      const parsed = SpecificationFactsSchema.safeParse(item.facts);
      if (!parsed.success) { setError("规格 " + item.code + " 的数值或格式无效"); return; }
      item.facts = parsed.data;
      const problems = confirmed ? specificationFactProblems(item.facts) : [];
      if (confirmed && !item.processProfileVersionId) problems.push("工艺未配置 请取消事实确认保存草稿");
      if (problems.length) { setError("规格 " + item.code + "：" + problems.join("；")); return; }
    }
    setError("");
    if (await onSave({ spuId, items })) clearTaskDrafts(draftKey);
  }
  return (
    <form onSubmit={submit} className="pd-spec-batch">
      {recoveryError && <p role="alert" className="oc-error">{recoveryError}</p>}
      <fieldset disabled={busy} className="pd-form">
        <label>
          商品 SPU
          <select aria-label="商品 SPU" value={spuId} onChange={() => undefined}>
            <option value={spuId}>
              {spu?.code} · {spu?.name}
            </option>
          </select>
        </label>
        <p className="pd-form-hint">
          尺寸、形状、颜色都可以添加多个选项。保存后的规格统一归属于这个 SPU。
        </p>
        <section className="pd-span pd-option-section" aria-label="规格选项">
          <h3>1. 设置规格选项</h3>
          <p>用逗号分隔或按回车添加多个值，再预览需要的组合。</p>
          {axes.map((axis) => (
            <div className="pd-option-axis" key={axis.id}>
              <label>
                规格维度
                <input
                  aria-label={`规格维度 ${axis.id}`}
                  value={axis.name}
                  maxLength={80}
                  onChange={(event) => updateAxis(axis.id, { name: event.target.value })}
                  placeholder="如尺寸、形状、颜色"
                />
              </label>
              <div className="pd-option-values">
                <label>
                  {axis.name || "选项"}选项
                  <div className="pd-option-entry">
                    <input
                      aria-label={`${axis.name || "未命名"}选项`}
                      value={pending[axis.id] ?? ""}
                      placeholder={
                        axis.name === "尺寸"
                          ? "如 50×60 英寸，60×80 英寸"
                          : axis.name === "形状"
                            ? "如圆形，方形，心形"
                            : "输入一个或多个选项"
                      }
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setPending((current) => ({ ...current, [axis.id]: value }));
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                          event.preventDefault();
                          addValues(axis);
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="oc-button"
                      onClick={() => addValues(axis)}
                      aria-label={`添加${axis.name}选项`}
                    >
                      添加
                    </button>
                  </div>
                </label>
                <div className="pd-option-tags" aria-label={`${axis.name}已选选项`}>
                  {axis.values.map((value) => (
                    <span className="pd-option-tag" key={value}>
                      {value}
                      <button
                        type="button"
                        aria-label={`移除${axis.name} ${value}`}
                        onClick={() =>
                          updateAxis(axis.id, { values: axis.values.filter((v) => v !== value) })
                        }
                      >
                        <X size={13} />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
              <button
                className="oc-button pd-axis-remove"
                type="button"
                aria-label={`删除${axis.name}维度`}
                onClick={() => {
                  setAxes((current) => current.filter((item) => item.id !== axis.id));
                  setPending((current) => {
                    const next = { ...current };
                    delete next[axis.id];
                    return next;
                  });
                }}
              >
                <X size={15} />
              </button>
            </div>
          ))}
          <div className="oc-actions">
            {["尺寸", "形状", "颜色"]
              .filter((name) => !axes.some((axis) => axis.name.trim() === name))
              .map((name) => (
                <button
                  type="button"
                  className="oc-button"
                  disabled={axes.length >= 4}
                  key={name}
                  onClick={() => addAxis(name)}
                >
                  <Plus size={14} />
                  添加{name}
                </button>
              ))}
            <button
              type="button"
              className="oc-button"
              disabled={axes.length >= 4}
              onClick={() => addAxis("")}
            >
              <Plus size={14} />
              自定义维度
            </button>
            <button type="button" className="oc-button primary" onClick={preview}>
              {rows.length ? "更新组合预览" : "预览规格组合"}
            </button>
          </div>
        </section>
        {!!rows.length && (
          <>
            <section className="pd-span pd-option-section" aria-label="共用规格信息">
              <h3>2. 填写共用信息</h3>
              <p>用于下方新增规格；尺寸和工艺可逐行修改，其余差异在“更多设置”中调整。</p>
              <div className="pd-form">
                <SpecificationFactFields values={defaults} prefix="共用" namePrefix="common." onChange={updateDefaults} />
                <label>默认制作工艺<ProcessOptions options={options} label="默认制作工艺" value={defaults.processProfileVersionId} onChange={value => updateDefaults({ processProfileVersionId: value })} /></label>
                <label>默认套图印刷规格<CanvasOptions options={options} label="默认套图印刷规格" value={defaults.canvasPrintSpecVersionId} onChange={value => updateDefaults({ canvasPrintSpecVersionId: value })} /></label>
                <label>默认空白品库存物料<StockOptions options={options} label="默认空白品库存物料" value={defaults.stockItemId} onChange={value => updateDefaults({ stockItemId: value })} /></label>
              </div>
            </section>
            <section className="pd-span pd-option-section" aria-label="规格组合预览">
              <h3>3. 确认需要绑定的规格</h3>
              <p role="status">
                共 {rows.length} 个组合，已选 {selected.length} 个新增规格
                {knownCount ? `，${knownCount} 个已存在` : ""}。
              </p>
              <p>
                不同尺寸、形状请核对实际尺寸与对应工艺底稿。当前可视制作支持异形抱枕、备胎罩和矩形平面打印。
              </p>
              {stale && (
                <p className="oc-notice" role="status">
                  选项已变化，请点击“更新组合预览”后再保存。
                </p>
              )}
              <div className="pd-table pd-spec-preview">
                <table>
                  <thead>
                    <tr>
                      <th className="pd-spec-selection">
                        <input
                          type="checkbox"
                          aria-label="全选新增规格"
                          checked={
                            !!selected.length && selected.length === rows.length - knownCount
                          }
                          onChange={(event) => {
                            setConfirmed(false);
                            setRows((current) =>
                              current.map((row) => ({
                                ...row,
                                selected: !row.existing && event.target.checked,
                              })),
                            );
                          }}
                        />
                      </th>
                      <th>规格组合</th>
                      <th>规格编号</th>
                      <th>实际尺寸</th>
                      <th>制作工艺</th>
                      <th className="pd-spec-more">设置</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => {
                      const values = { ...defaults, ...row.overrides };
                      const label = Object.values(row.attributes).join(" · ");
                      return (
                        <Fragment key={row.key}>
                          <tr className={row.existing ? "pd-existing-spec" : undefined}>
                            <td data-label="选择">
                              <input
                                type="checkbox"
                                aria-label={`选择规格 ${label}`}
                                disabled={row.existing}
                                checked={row.selected}
                                onChange={(event) =>
                                  updateRow(row.key, { selected: event.target.checked })
                                }
                              />
                            </td>
                            <td data-label="规格组合">
                              <strong>{label}</strong>
                              {row.existing && <small>已存在 · 无需重复添加</small>}
                            </td>
                            <td data-label="规格编号">
                              <input
                                aria-label={`规格编号 ${index + 1}`}
                                required={row.selected}
                                disabled={row.existing || !row.selected}
                                pattern="[A-Za-z0-9][A-Za-z0-9_.-]*"
                                maxLength={100}
                                value={row.code}
                                onChange={(event) =>
                                  updateRow(row.key, { code: event.target.value })
                                }
                              />
                            </td>
                            <td data-label="实际尺寸"><span>{values.sizeBasis ? specificationFactsFromDraft(values, false).dimensions || "测量值待填写" : row.dimensions ? "原记录待核对：" + row.dimensions : "口径与测量值待填写"}</span></td>
                            <td data-label="制作工艺">
                              {row.existing ? (
                                <span>保留已有工艺</span>
                              ) : (
                                <ProcessOptions
                                  options={options}
                                  value={values.processProfileVersionId}
                                  required={row.selected && confirmed}
                                  disabled={!row.selected}
                                  label={`制作工艺 ${index + 1}`}
                                  onChange={(value) =>
                                    override(row.key, { processProfileVersionId: value })
                                  }
                                />
                              )}
                            </td>
                            <td>
                              <button
                                type="button"
                                className="oc-button"
                                disabled={row.existing || !row.selected}
                                aria-expanded={row.details}
                                onClick={() => updateRow(row.key, { details: !row.details })}
                              >
                                {row.details ? "收起设置" : "更多设置"}
                              </button>
                            </td>
                          </tr>
                          {row.details && !row.existing && (
                            <tr className="pd-spec-details">
                              <td colSpan={6}>
                                <fieldset
                                  disabled={!row.selected}
                                  className="pd-form"
                                  aria-label={`规格 ${index + 1} 详细设置`}
                                >
                                  <label>规格名称<input required={row.selected} maxLength={160} value={row.name} onChange={event => updateRow(row.key, { name: event.target.value })} /></label>
                                  <SpecificationFactFields values={values} namePrefix={"row" + index + "."} onChange={patch => override(row.key, patch)} />
                                  <label>套图印刷规格<CanvasOptions options={options} value={values.canvasPrintSpecVersionId} onChange={value => override(row.key, { canvasPrintSpecVersionId: value })} /></label>
                                  <label>空白品库存物料<StockOptions options={options} value={values.stockItemId} onChange={value => override(row.key, { stockItemId: value })} /></label>
                                  <button
                                    type="button"
                                    className="oc-button"
                                    onClick={() => updateRow(row.key, { overrides: {} })}
                                  >
                                    恢复共用信息
                                  </button>
                                </fieldset>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <label className="oc-check pd-confirm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                已逐项核实所选规格的产品事实 核验依据与工艺
              </label>
            </section>
          </>
        )}
        {error && (
          <p role="alert" className="oc-error pd-span">
            {error}
          </p>
        )}
        {!!rows.length && (
          <div className="oc-actions pd-span">
            <button className="oc-button primary" disabled={stale || !selected.length}>
              {busy ? "保存中…" : `保存 ${selected.length} 个规格`}
            </button>
            <small>未确认的规格保存为草稿，补齐工艺与产品事实后才能用于订单制作。</small>
          </div>
        )}
        {!options.processes.length && (
          <p className="pd-span oc-notice">
            可以先保存规格草稿；制作前请在{" "}
            <Link data-task-draft-link href={workflowHref("/process-library", workflow.current)}>
              工艺底稿库
            </Link>{" "}
            登记并审核底稿，再更新规格。
          </p>
        )}
      </fieldset>
    </form>
  );
}

type SelectProps = {
  options: DevelopmentOptions;
  value: string;
  onChange: (value: string) => void;
  label?: string;
  required?: boolean;
  disabled?: boolean;
};
function ProcessOptions({ options, value, onChange, label, required, disabled }: SelectProps) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-label={label}
      required={required}
      disabled={disabled}
    >
      <option value="">待配置（保存为规格草稿）</option>
      {options.processes.map((process) => (
        <option key={process.versionId} value={process.versionId}>
          {process.code} · {process.name}
        </option>
      ))}
    </select>
  );
}
function CanvasOptions({ options, value, onChange, label }: SelectProps) {
  return (
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">暂不设置（套图前需补齐）</option>
      {options.canvasPrintSpecs.map((spec) => (
        <option key={spec.id} value={spec.id}>
          {spec.name}
        </option>
      ))}
    </select>
  );
}
function StockOptions({ options, value, onChange, label }: SelectProps) {
  return (
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">暂不关联</option>
      {options.stockItems.map((stock) => (
        <option key={stock.id} value={stock.id}>
          {stock.code} · {stock.name}
        </option>
      ))}
    </select>
  );
}
