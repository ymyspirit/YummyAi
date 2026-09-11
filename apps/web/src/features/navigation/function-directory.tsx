"use client";

import { ArrowRight, FileUp, LayoutGrid, Search, Workflow, Truck, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { SpotlightCard } from "../../components/react-bits/spotlight-card";
import { groupIcons } from "./navigation-icons";
import { FUNCTION_DESTINATIONS, QUICK_DESTINATION_IDS, SIDEBAR_GROUPS, searchDestinations, type NavigationGroupId } from "./navigation-registry";

const quickTasks: Record<string, { icon: typeof FileUp; hint: string }> = {
  "order-import": { icon: FileUp, hint: "每日订单" },
  "creative-canvas": { icon: Workflow, hint: "新品创作" },
  "orders-shipment": { icon: Truck, hint: "发货安排" },
};

export function FunctionDirectory() {
  const [query, setQuery] = useState("");
  const [selectedGroup, setSelectedGroup] = useState<NavigationGroupId | "all">("commerce");
  const filtered = query.trim().length > 0;
  // Search spans every category, regardless of the current category selection.
  const matches = searchDestinations(query).filter((item) => filtered || selectedGroup === "all" || item.groupId === selectedGroup);
  const reset = () => { setQuery(""); setSelectedGroup("all"); };
  return <>
    <header className="erp-directory-header">
      <div><p className="erp-eyebrow">工作台 / 功能导航</p><h1>全部功能</h1><p>从日常任务开始，或按业务分类找到你需要的页面。</p></div>
      <span className="erp-directory-keyboard"><kbd>Ctrl</kbd><kbd>K</kbd> 随时找功能</span>
    </header>
    <section className="erp-quick-tasks" aria-labelledby="erp-quick-title">
      <div className="erp-section-heading"><h2 id="erp-quick-title">常用任务</h2><span>订单 → 作图 → 发货</span></div>
      <div className="erp-quick-grid">{QUICK_DESTINATION_IDS.map((id) => {
        const item = FUNCTION_DESTINATIONS.find((entry) => entry.id === id)!;
        const Icon = quickTasks[id]!.icon;
        return <SpotlightCard key={id} className="erp-task-card">
          <Link href={item.href} prefetch={false}>
            <span className="erp-task-top"><span className="erp-task-icon"><Icon size={20} aria-hidden="true" /></span><small>{quickTasks[id]!.hint}</small></span>
            <strong>{item.label}</strong><span className="erp-task-description">{item.description}</span>
            <span className="erp-task-open">打开页面<ArrowRight size={15} aria-hidden="true" /></span>
          </Link>
        </SpotlightCard>;
      })}</div>
    </section>
    <section className="erp-function-browser" aria-labelledby="erp-browse-title">
      <div className="erp-section-heading"><h2 id="erp-browse-title">按业务找功能</h2><span>选择一个分类，逐步找到具体页面</span></div>
      <div className="erp-directory-filter">
        <label htmlFor="erp-directory-query">搜索全部功能</label>
        <div className="erp-search-field"><Search size={18} aria-hidden="true" />
          <input id="erp-directory-query" aria-label="筛选全部功能" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="如：订单报告、猫咪、备胎罩、库存" />
          {query && <button type="button" aria-label="清空筛选" onClick={() => setQuery("")}><X size={16} /></button>}
        </div>
      </div>
      <div className="erp-directory-categories" role="group" aria-label="业务分类">
        {SIDEBAR_GROUPS.filter((group) => group.id !== "overview").map((group) => {
          const Icon = groupIcons[group.id];
          return <button key={group.id} type="button" aria-pressed={!filtered && selectedGroup === group.id}
            onClick={() => { setQuery(""); setSelectedGroup(group.id); }}><Icon size={16} aria-hidden="true" />{group.label}</button>;
        })}
        <button type="button" aria-pressed={!filtered && selectedGroup === "all"} onClick={reset}><LayoutGrid size={16} aria-hidden="true" />全部</button>
      </div>
      <p className="erp-directory-result-count" role="status">{filtered ? `搜索全部分类 · 找到 ${matches.length} 个入口` : `${selectedGroup === "all" ? "全部分类" : SIDEBAR_GROUPS.find((group) => group.id === selectedGroup)?.label} · ${matches.length} 个入口`}</p>
      <div className="erp-directory-groups">
        {SIDEBAR_GROUPS.map((group) => {
          const items = matches.filter((item) => item.groupId === group.id);
          if (!items.length) return null;
          const Icon = groupIcons[group.id];
          return <section key={group.id} aria-labelledby={`directory-${group.id}`}>
            <header><Icon size={18} aria-hidden="true" /><div><h3 id={`directory-${group.id}`}>{group.label}</h3><p>{group.description}</p></div><span>{items.length} 项</span></header>
            <div className="erp-directory-entries">{items.map((item) => <Link key={item.id} href={item.href} prefetch={false}>
              <div><strong>{item.label}</strong><p>{item.description}</p></div><ArrowRight size={16} aria-hidden="true" />
            </Link>)}</div>
          </section>;
        })}
      </div>
      {!matches.length && <div className="erp-directory-empty"><Search size={24} aria-hidden="true" /><h3>没有找到对应功能</h3><p>可以换个关键词，或清空筛选查看全部入口。</p><button type="button" onClick={reset}>查看全部功能</button></div>}
    </section>
  </>;
}
