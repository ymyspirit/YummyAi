"use client";
import { useState } from "react";
import Link from "next/link";
import { Plus, Search, ArrowUpRight, Pencil, SlidersHorizontal, ChevronRight, Info } from "lucide-react";
import { RULE_CATEGORY_LABELS, RULE_EXECUTION_LABELS, canEditRuleText, type RuleRow, type RuleVersion, type RuleWorkspace } from "@yummyai/contracts/rules";
import { workflowHref } from "../navigation/workflow-href";
import { PRODUCT_NAMES, CATEGORY_TITLES, newRuleForView, ruleInView, viewLabel, scopeLabel, statusLabel, configurationFor, configHref, type RuleSelection } from "./rule-center-model";

export function ExecutionBadge({ version }: { version: RuleVersion }) {
  return <span className={"rc-badge rc-" + version.execution}>{RULE_EXECUTION_LABELS[version.execution]}</span>;
}
export function FactoryValues({ data }: { data: RuleWorkspace }) {
  const factory = data.factoryStandard;
  return <dl className="rc-factory-values">
    <div><dt>交付文件</dt><dd>JPG · 白底 · {factory.dpi} DPI</dd></div>
    <div><dt>安全白边 / 裁剪线</dt><dd>{factory.whiteBorderPx} px / {factory.cutLinePx} px</dd></div>
    <div><dt>正反片间距 / 画布留边</dt><dd>{factory.panelGapPx} px / {factory.sheetMarginPx} px</dd></div>
    <div><dt>底部条码框</dt><dd>{factory.barcodeWidthPx} × {factory.barcodeHeightPx} px</dd></div>
    <div><dt>最小细颈</dt><dd>{factory.minimumNeckMm} mm · 人工复核</dd></div>
  </dl>;
}
export function RuleBrowser({ data, loading, initialView, onOpen }: { data: RuleWorkspace; loading: boolean; initialView: string; onOpen: (selection: RuleSelection) => void }) {
  const [view, setView] = useState(initialView), [productSearch, setProductSearch] = useState("");
  const [category, setCategory] = useState("all"), [search, setSearch] = useState(""), [execution, setExecution] = useState("all"), [status, setStatus] = useState("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  function changeView(next: string) {
    setView(next); setSearch(""); setCategory("all"); setExecution("all"); setStatus("all"); setFiltersOpen(false);
    const url = new URL(location.href); url.searchParams.set("scope", next); url.searchParams.delete("rule"); url.searchParams.delete("version");
    window.history.replaceState(null, "", url.pathname + url.search);
  }
  const inView = data.rules.filter(row => ruleInView(row, view, data));
  const matches = inView.filter(row => {
    const rule = row.active ?? row.latest;
    return (category === "all" || rule.category === category) && (execution === "all" || rule.execution === execution)
      && (status === "all" || (status === "enabled" ? !!row.activeVersion : !row.activeVersion))
      && [row.latest, row.active].some(item => item && (item.name + " " + item.instructions + " " + item.source).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  });
  const products = data.spus.filter(spu => (spu.code + " " + spu.name).toLocaleLowerCase().includes(productSearch.trim().toLocaleLowerCase()));
  const currentSpu = data.spus.find(spu => "spu:" + spu.id === view);
  const directory = [["general", "通用制作要求"], ["operations", "日常操作规范"], ["all", "全部规则"]] as const;
  const isProductView = view in PRODUCT_NAMES || view.startsWith("spu:");
  const navButton = (key: string, label: string, code?: string) => <button key={key} aria-current={view === key ? "page" : undefined} onClick={() => changeView(key)}>
    <span>{label}{code && <small>{code}</small>}</span><span className="rc-nav-count">{data.rules.filter(row => ruleInView(row, key, data)).length}</span>
  </button>;
  return <div className="rc-layout">
    <aside className="rc-directory"><nav aria-label="规则目录">
      <h2>全局规范</h2>{directory.map(([key, label]) => navButton(key, label))}
      <h2>商品类型</h2>{Object.entries(PRODUCT_NAMES).map(([key, name]) => navButton(key, name))}
      <h2>指定商品 <span>SPU</span></h2>
      <label className="rc-search"><Search size={14} /><input aria-label="搜索商品目录" placeholder="搜索商品名称或 SPU" value={productSearch} onChange={event => setProductSearch(event.target.value)} /></label>
      <div className="rc-product-directory">{products.map(spu => navButton("spu:" + spu.id, spu.name, spu.code))}</div>
      {!products.length && <p className="oc-hint">{productSearch ? "没有匹配的商品" : "暂无商品，先建立 SPU。"}</p>}
      <Link className="rc-directory-link" href={workflowHref("/product-specifications", "/settings/rules")}>管理商品 SPU <ArrowUpRight size={13} /></Link>
    </nav></aside>
    <section className="rc-content" aria-label="当前规则">
      <label className="rc-mobile-directory">查看范围<select value={view} onChange={event => changeView(event.target.value)}>
        <optgroup label="全局规范">{directory.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</optgroup>
        <optgroup label="商品类型">{Object.entries(PRODUCT_NAMES).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</optgroup>
        <optgroup label="指定商品 SPU">{data.spus.map(spu => <option key={spu.id} value={"spu:" + spu.id}>{spu.name} · {spu.code}</option>)}</optgroup>
      </select></label>
      <header className="rc-content-heading"><div><h2>{viewLabel(view, data)}</h2><p>{currentSpu ? currentSpu.code + " · 通用要求、当前规格对应的类型规则和本商品补充要求"
        : view === "general" ? "所有商品共用。修改后，对新派发任务生效。"
          : view === "operations" ? "测试清理等日常规范，单独管理。"
            : view === "all" ? "查看全部范围的规则，或在左侧选择具体商品。"
              : "此类型商品的制作要求，包含通用制作规范。"}</p></div>
        {data.canManage && <button className="oc-button primary" disabled={loading} onClick={() => onOpen({ id: "new", fields: newRuleForView(view) })}><Plus size={15} />{isProductView ? "新增专属要求" : "新增要求"}</button>}
      </header>
      <div className="rc-howto"><Info size={15} /><span><strong>文字要求</strong>点“编辑要求”，保存草稿后启用；<strong>工艺参数与模型</strong>从对应配置入口修改。</span></div>
      {currentSpu && !currentSpu.productTypes.length && <p className="oc-hint">该商品尚未关联可识别的工艺类型，可先建立专属要求。
        <Link href={workflowHref("/product-specifications?spu=" + currentSpu.id, "/settings/rules?scope=" + view)}>配置商品规格与工艺</Link></p>}
      <div className="rc-toolbar"><label className="rc-search"><Search size={15} /><input aria-label="搜索规则" placeholder="在当前范围搜索要求" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <button className="oc-button" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(value => !value)}><SlidersHorizontal size={14} />筛选</button><span>{matches.length} 条要求</span></div>
      {filtersOpen && <div className="rc-filters">
        <label>规则分类<select value={category} onChange={event => setCategory(event.target.value)}><option value="all">全部分类</option>{Object.entries(RULE_CATEGORY_LABELS).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
        <label>执行方式<select value={execution} onChange={event => setExecution(event.target.value)}><option value="all">全部方式</option>{Object.entries(RULE_EXECUTION_LABELS).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
        <label>启用状态<select value={status} onChange={event => setStatus(event.target.value)}><option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">未启用</option></select></label>
      </div>}
      {loading && <p role="status" className="oc-hint">正在读取规则…</p>}
      {Object.entries(CATEGORY_TITLES).map(([key, label]) => {
        const rows = matches.filter(row => (row.active ?? row.latest).category === key).sort((a, b) => {
          if (a.latest.binding === "pillow_factory") return -1;
          if (b.latest.binding === "pillow_factory") return 1;
          return a.code.localeCompare(b.code);
        });
        if (!rows.length) return null;
        return <section className="rc-rule-group" key={key} aria-label={label}><h3>{label}<span>{rows.length}</span></h3>
          {rows.map(row => <RuleItem key={row.id} row={row} data={data} inherited={isProductView && (row.active ?? row.latest).scopeKind === "all"}
            onOpen={edit => onOpen({ id: row.id, edit })} />)}</section>;
      })}
      {!loading && !matches.length && <div className="rc-empty"><h3>没有符合条件的要求</h3><p>调整搜索或筛选，也可以为当前范围新增要求。</p></div>}
      <p className="rc-version-note">修改只影响之后派发的任务；已派发订单继续使用当时的版本。保存文字要求不会自动增加制图能力。</p>
    </section>
  </div>;
}
function RuleItem({ row, data, inherited, onOpen }: { row: RuleRow; data: RuleWorkspace; inherited: boolean; onOpen: (edit?: boolean) => void }) {
  const rule = row.active ?? row.latest, config = configurationFor(row);
  return <article className="rc-rule" aria-label={rule.name}>
    <div className="rc-rule-heading"><h4>{rule.name}</h4><span className="rc-version">{statusLabel(row)}</span></div>
    <div className="rc-rule-meta"><ExecutionBadge version={rule} /><span>{inherited ? "沿用通用规则" : scopeLabel(rule, data)}</span>{!row.active && <span>启用后才会用于新任务</span>}</div>
    {rule.binding === "pillow_factory" ? <FactoryValues data={data} /> : <p className="rc-rule-copy">{rule.instructions}</p>}
    <div className="rc-rule-actions">
      {data.canManage && canEditRuleText(row) && <button className="oc-button" onClick={() => onOpen(true)}><Pencil size={14} />编辑要求</button>}
      {config && <Link className="oc-button" href={configHref(row, config.href)}>{config.label}<ArrowUpRight size={13} /></Link>}
      <button className="rc-text-button" onClick={() => onOpen()}>查看详情<ChevronRight size={14} /></button>
      {row.activeVersion !== row.latestVersion && <button className="rc-text-button" onClick={() => onOpen()}>查看待启用草稿</button>}
    </div>
  </article>;
}
