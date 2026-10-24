"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Plus, Search, Trash2 } from "lucide-react";
import { ManufacturingMaterialOptionsSchema, type ManufacturingMaterialOptions } from "@yummyai/contracts/catalog/manufacturing";
import { manufacturingRequest, ManufacturingContextChanged, ManufacturingRequestError } from "./manufacturing-api";
import { blankMaterial, blankOperation, responsibilityLabels, unitLabels, type ManufacturingDraft, type MaterialDraft, type OperationDraft } from "./manufacturing-model";

export function ManufacturingField({ id, label, help, children }: { id: string; label: string; help?: string; children: ReactNode }) {
  return <div className="mf-field"><label htmlFor={id}>{label}</label>{children}{help && <small>{help}</small>}</div>;
}
type Option = ManufacturingMaterialOptions["items"][number];
function MaterialPicker({ id, spuId, value, fallback, authority, localDevelopment, disabled, readable, onChoose, onAccessChanged }: {
  id: string; spuId: string; value: string; fallback: string; authority: string; localDevelopment: boolean; disabled: boolean;
  readable: boolean; onChoose: (option: Option | null) => void; onAccessChanged: () => void;
}) {
  const [search, setSearch] = useState(""), [query, setQuery] = useState({ search: "", after: null as string | null });
  const [data, setData] = useState<{ search: string; items: Option[]; selected: Option[]; next: string | null; missing: boolean } | null>(null);
  const [reading, setReading] = useState(false), [error, setError] = useState(""), [reload, setReload] = useState(0);
  const requestKey = JSON.stringify({ spuId, authority, value, query, reload }), latest = useRef(requestKey); latest.current = requestKey;
  useEffect(() => {
    if (!readable) return;
    const abort = new AbortController(), key = requestKey;
    setReading(true); setError("");
    const params = new URLSearchParams({ spuId, search: query.search, limit: "50", selected: value }); if (query.after) params.set("after", query.after);
    void manufacturingRequest(`/material-options?${params}`, ManufacturingMaterialOptionsSchema, authority, localDevelopment, { signal: abort.signal }).then(result => {
      if (abort.signal.aborted || latest.current !== key) return;
      setData(previous => ({ search: query.search, items: [...new Map([...(query.after && previous?.search === query.search ? previous.items : []), ...result.items].map(row => [row.id, row])).values()],
        selected: result.selected, next: result.nextCursor, missing: result.missingSelected.includes(value) }));
    }).catch(cause => {
      if (abort.signal.aborted || latest.current !== key) return;
      if (cause instanceof ManufacturingContextChanged || cause instanceof ManufacturingRequestError && [401, 403].includes(cause.status ?? 0)) { onAccessChanged(); return; }
      setError(cause instanceof Error ? cause.message : "物料暂时无法读取 请重试");
    }).finally(() => { if (!abort.signal.aborted && latest.current === key) setReading(false); });
    return () => abort.abort();
  }, [requestKey, authority, readable, localDevelopment, onAccessChanged, query, spuId, value]);
  const options = [...new Map([...(data?.items ?? []), ...(data?.selected ?? [])].map(row => [row.id, row])).values()];
  return <div className="mf-picker">
    <div className="mf-picker-search"><input aria-label="搜索物料" placeholder="按物料名称或编码搜索" value={search} disabled={disabled} onChange={event => setSearch(event.target.value)}
      onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); setQuery({ search, after: null }); } }} />
      <button type="button" className="oc-button" disabled={disabled || reading} aria-label="执行物料搜索" onClick={() => setQuery({ search, after: null })}><Search size={14} /></button></div>
    <select id={id} value={value} disabled={disabled || reading || !!error} onChange={event => onChoose(options.find(row => row.id === event.target.value) ?? null)}>
      <option value="">尚未关联物料</option>
      {value && !options.some(row => row.id === value) && <option value={value}>原关联物料 {fallback} 待核对</option>}
      {options.map(row => <option key={row.id} value={row.id} disabled={row.status !== "active"}>{row.code} · {row.name} · {unitLabels[row.baseUnit]}{row.status === "inactive" ? " · 已停用" : ""}</option>)}
    </select>
    {reading && <small role="status">正在读取物料</small>}
    {error && <p className="mf-error" role="alert">{error} <button type="button" className="oc-button" onClick={() => setReload(n => n + 1)}>重试物料读取</button></p>}
    {data?.missing && <small className="mf-error">原关联物料当前不可读取 请重新选择 旧填写已保留</small>}
    {data?.next && !error && <button type="button" className="oc-button" disabled={disabled || reading} onClick={() => setQuery(current => ({ ...current, after: data.next }))}>更多物料</button>}
  </div>;
}
export function ManufacturingLines({ draft, update, structural, disabled, spuId, authority, localDevelopment, canReadMaterials, onAccessChanged, onError }: {
  draft: ManufacturingDraft; update: (fn: (current: ManufacturingDraft) => ManufacturingDraft) => void;
  structural: (fn: () => void) => void; disabled: boolean; spuId: string; authority: string; localDevelopment: boolean;
  canReadMaterials: boolean; onAccessChanged: () => void; onError: (message: string) => void;
}) {
  const material = (key: string, patch: Partial<MaterialDraft>) => update(current => ({ ...current, materials: current.materials.map(row => row.key === key ? { ...row, ...patch } : row) }));
  const operation = (key: string, patch: Partial<OperationDraft>) => update(current => ({ ...current, operations: current.operations.map(row => row.key === key ? { ...row, ...patch } : row) }));
  return <>
    <section className="mf-section" aria-label="制造工序"><header><div><h2>工序顺序</h2><p>按实际加工顺序记录 谁执行仍需明确确认</p></div>
      <button type="button" className="oc-button" disabled={disabled || draft.operations.length >= 200} onClick={() => structural(() => update(current => ({ ...current, operations: [...current.operations, blankOperation()] })))}><Plus size={14} />增加工序</button></header>
      {!draft.operations.length && <p className="mf-empty">尚未填写工序 可以先保存草稿</p>}
      {draft.operations.map((row, index) => <fieldset className="mf-row" key={row.key} disabled={disabled} style={{ viewTransitionName: "mf-op-" + row.key }}>
        <legend>工序 {index + 1}</legend><div className="mf-row-actions">
          {[{ delta: -1, label: "上移", Icon: ArrowUp }, { delta: 1, label: "下移", Icon: ArrowDown }].map(({ delta, label, Icon }) => <button type="button" className="oc-button" key={delta}
            aria-label={`${label}工序${index + 1}`} disabled={disabled || index + delta < 0 || index + delta >= draft.operations.length}
            onClick={() => structural(() => update(current => { const rows = [...current.operations], at = rows.findIndex(op => op.key === row.key);
              if (at < 0 || at + delta < 0 || at + delta >= rows.length) return current;
              [rows[at], rows[at + delta]] = [rows[at + delta]!, rows[at]!]; return { ...current, operations: rows }; }))}><Icon size={14} /></button>)}
          <button type="button" className="oc-button" aria-label={`删除工序${index + 1}`} onClick={() => {
            if (draft.materials.some(line => line.operationKey === row.key)) { onError("仍有材料关联此工序 请先修改材料的关联工序再删除"); return; }
            structural(() => update(current => ({ ...current, operations: current.operations.filter(op => op.key !== row.key) })));
          }}><Trash2 size={14} /></button>
        </div><div className="mf-grid">
          <ManufacturingField id={row.key + "code"} label="工序编号"><input id={row.key + "code"} maxLength={64} value={row.code} onChange={e => operation(row.key, { code: e.target.value })} /></ManufacturingField>
          <ManufacturingField id={row.key + "name"} label="工序名称"><input id={row.key + "name"} maxLength={200} value={row.name} onChange={e => operation(row.key, { name: e.target.value })} /></ManufacturingField>
          <ManufacturingField id={row.key + "process"} label="加工代码"><input id={row.key + "process"} maxLength={64} value={row.processCode} placeholder="例如 print 或 cut" onChange={e => operation(row.key, { processCode: e.target.value })} /></ManufacturingField>
          <ManufacturingField id={row.key + "who"} label="由谁执行"><select id={row.key + "who"} value={row.responsibility} onChange={e => operation(row.key, { responsibility: e.target.value as OperationDraft["responsibility"] })}>
            {Object.entries(responsibilityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></ManufacturingField>
          <ManufacturingField id={row.key + "seconds"} label="预计每产出单位耗时 秒" help="未知时留空 不表示实际工厂工时"><input id={row.key + "seconds"} inputMode="numeric" value={row.seconds} onChange={e => operation(row.key, { seconds: e.target.value })} /></ManufacturingField>
          <ManufacturingField id={row.key + "notes"} label="工序说明"><textarea id={row.key + "notes"} rows={2} maxLength={2000} value={row.notes} onChange={e => operation(row.key, { notes: e.target.value })} /></ManufacturingField>
        </div>
      </fieldset>)}
    </section>
    <section className="mf-section" aria-label="BOM材料"><header><div><h2>材料清单</h2><p>同一材料的不同裁切用途分行保留 用量对应上方产出数量</p></div>
      <button type="button" className="oc-button" disabled={disabled || draft.materials.length >= 200} onClick={() => structural(() => update(current => ({ ...current, materials: [...current.materials, blankMaterial()] })))}><Plus size={14} />增加材料</button></header>
      {!draft.materials.length && <p className="mf-empty">尚未填写材料 未知内容可以留空保存 审核前需补齐</p>}
      {draft.materials.map((row, index) => <fieldset className="mf-row" key={row.key} disabled={disabled} style={{ viewTransitionName: "mf-mat-" + row.key }}>
        <legend>材料 {index + 1}</legend><div className="mf-row-actions"><button type="button" className="oc-button" aria-label={`删除材料${index + 1}`} onClick={() => structural(() => update(current => ({ ...current, materials: current.materials.filter(line => line.key !== row.key) })))}><Trash2 size={14} /></button></div>
        <div className="mf-grid">
          <ManufacturingField id={row.key + "code"} label="材料行编号"><input id={row.key + "code"} maxLength={64} value={row.code} onChange={e => material(row.key, { code: e.target.value })} /></ManufacturingField>
          <ManufacturingField id={row.key + "name"} label="材料说明"><input id={row.key + "name"} maxLength={200} value={row.name} onChange={e => material(row.key, { name: e.target.value })} /></ManufacturingField>
          <ManufacturingField id={row.key + "stock"} label="库存物料"><MaterialPicker id={row.key + "stock"} spuId={spuId} value={row.stockItemId} fallback={row.name} authority={authority} localDevelopment={localDevelopment} disabled={disabled} readable={canReadMaterials}
            onAccessChanged={onAccessChanged} onChoose={choice => material(row.key, { stockItemId: choice?.id ?? "", unit: choice?.baseUnit ?? "",
              quantityUnit: row.quantity.trim() ? row.quantityUnit : choice?.baseUnit ?? "", name: row.name || choice?.name || "" })} /></ManufacturingField>
          <ManufacturingField id={row.key + "quantity"} label="净用量" help={`单位 ${row.unit ? unitLabels[row.unit] : "待关联物料"} 可填0.25或1/4`}><input id={row.key + "quantity"} inputMode="decimal" value={row.quantity}
            onChange={e => material(row.key, { quantity: e.target.value, quantityUnit: row.unit })} />
            {row.quantity.trim() && row.quantityUnit !== row.unit && <small className="mf-error">物料单位已变化 原数值保留 请重新填写净用量</small>}</ManufacturingField>
          <ManufacturingField id={row.key + "loss"} label="损耗比例 %"><input id={row.key + "loss"} inputMode="decimal" value={row.lossPercent} placeholder="未知时留空" onChange={e => material(row.key, { lossPercent: e.target.value })} /></ManufacturingField>
          <ManufacturingField id={row.key + "basis"} label="损耗计算口径"><select id={row.key + "basis"} value={row.lossBasis} onChange={e => material(row.key, { lossBasis: e.target.value as MaterialDraft["lossBasis"] })}>
            <option value="">待确认</option><option value="add_to_net">在净耗量上额外增加</option><option value="fraction_of_input">损耗占总投入量</option></select></ManufacturingField>
          <ManufacturingField id={row.key + "who"} label="谁提供材料"><select id={row.key + "who"} value={row.responsibility} onChange={e => material(row.key, { responsibility: e.target.value as MaterialDraft["responsibility"] })}>
            {Object.entries(responsibilityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></ManufacturingField>
          <ManufacturingField id={row.key + "operation"} label="关联工序"><select id={row.key + "operation"} value={row.operationKey} onChange={e => material(row.key, { operationKey: e.target.value })}>
            <option value="">未指定工序</option>{draft.operations.map((op, n) => <option key={op.key} value={op.key}>{n + 1} {op.code || "未填写编号"} {op.name}</option>)}</select></ManufacturingField>
          <ManufacturingField id={row.key + "notes"} label="材料说明补充"><textarea id={row.key + "notes"} rows={2} maxLength={2000} value={row.notes} onChange={e => material(row.key, { notes: e.target.value })} /></ManufacturingField>
        </div>
      </fieldset>)}
    </section>
  </>;
}
