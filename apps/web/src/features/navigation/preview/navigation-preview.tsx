"use client";

import {
  ArrowLeft, ArrowRight, ChevronRight, ExternalLink, Layers3, Menu,
  PanelLeftClose, PanelLeftOpen, Search, Star, X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { destinationIcons, groupIcons } from "../navigation-icons";
import {
  FUNCTION_DESTINATIONS, SIDEBAR_GROUPS, searchDestinations,
  type ErpSection, type NavigationGroupId, type SearchDestination,
} from "../navigation-registry";

const PREFERENCE_KEY = "yummyai:navigation-preview:v1";
const DEFAULT_FAVORITES = ["orders", "production-editor", "products", "suppliers"];
const previewHref = (id: string) => `/navigation-preview?page=${encodeURIComponent(id)}`;
type PanelId = NavigationGroupId | "favorites";

function PreviewDialog({ label, children, onClose, className = "" }: {
  label: string; children: ReactNode; onClose: () => void; className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
    document.body.style.overflow = "hidden";
    return () => {
      dialog?.close();
      document.body.style.overflow = overflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  return <dialog ref={ref} className={`nav-preview-dialog ${className}`} aria-label={label}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={(event) => {
      if (event.key !== "Tab") return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("a[href],button,input,[tabindex]"))
        .filter((element) => element.tabIndex >= 0 && !element.hasAttribute("disabled") && element.getClientRects().length > 0);
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    {children}
  </dialog>;
}

function PreviewSurface({ activeId }: { activeId: string }) {
  const canvas = ["production-editor", "studio-canvas", "creative-canvas", "studio-image", "studio-video"].includes(activeId);
  const columns = activeId === "suppliers" ? ["供应商", "类型", "地区", "供货产品"]
    : activeId === "products" ? ["产品", "规格 / SKU", "供应商", "状态"]
      : activeId === "orders" || activeId.startsWith("order") ? ["订单", "定制要求", "生产进度", "发货安排"]
        : ["名称", "所属项目", "更新时间", "状态"];
  return <section className="nav-preview-surface" aria-label="页面内容布局示意">
    <header><span>{canvas ? "工作画布" : "工作列表"}</span><small>内容布局示意</small></header>
    {canvas ? <div className="nav-preview-canvas">
      <div className="nav-preview-artboard"><Layers3 size={30} strokeWidth={1.5} aria-hidden="true" /><strong>创作内容区域</strong><span>收起页面栏，查看可用空间的变化</span></div>
    </div> : <div className="nav-preview-wire-table" aria-hidden="true">
      <div className="nav-preview-wire-head">{columns.map((column) => <span key={column}>{column}</span>)}</div>
      {[0, 1, 2, 3, 4].map((row) => <div className="nav-preview-wire-row" key={row}>{columns.map((column, index) => <span key={column}><i style={{ width: `${[70, 46, 60, 38][(row + index) % 4]}%` }} /></span>)}</div>)}
    </div>}
    <footer>此预览演示导航交互，业务内容请通过右上方“打开实际页面”查看。</footer>
  </section>;
}

export function NavigationPreview({ activeId }: { activeId: string }) {
  const active = FUNCTION_DESTINATIONS.find((item) => item.id === activeId)!;
  const [panelId, setPanelId] = useState<PanelId>(active.groupId as NavigationGroupId);
  const [favorites, setFavorites] = useState<string[]>(DEFAULT_FAVORITES);
  const [collapsed, setCollapsed] = useState(false);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [feedback, setFeedback] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const searchResults = useRef<HTMLDivElement>(null);
  const previousActive = useRef(activeId);

  useEffect(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(PREFERENCE_KEY) ?? "null");
      if (stored && typeof stored === "object") {
        if ("favorites" in stored && Array.isArray(stored.favorites)) {
          setFavorites([...new Set(stored.favorites.filter((id): id is string => typeof id === "string" && FUNCTION_DESTINATIONS.some((item) => item.id === id)))]);
        }
        if ("collapsed" in stored && typeof stored.collapsed === "boolean") setCollapsed(stored.collapsed);
      }
    } catch { /* The prototype remains usable when storage is unavailable. */ }
    setPreferencesLoaded(true);
  }, []);
  useEffect(() => {
    if (!preferencesLoaded) return;
    try { localStorage.setItem(PREFERENCE_KEY, JSON.stringify({ favorites, collapsed })); } catch { /* Keep in-memory preferences. */ }
  }, [collapsed, favorites, preferencesLoaded]);
  useEffect(() => {
    // Browsing a module does not navigate or change the open work page.
    if (previousActive.current !== activeId) {
      previousActive.current = activeId;
      setPanelId((previous) => previous === "favorites" ? previous : active.groupId as NavigationGroupId);
    }
  }, [activeId, active.groupId]);
  useEffect(() => {
    function handleSearch(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", handleSearch);
    return () => window.removeEventListener("keydown", handleSearch);
  }, []);

  const group = SIDEBAR_GROUPS.find((item) => item.id === panelId);
  const panelItems = panelId === "favorites"
    ? favorites.flatMap((id) => FUNCTION_DESTINATIONS.find((item) => item.id === id) ?? [])
    : FUNCTION_DESTINATIONS.filter((item) => group?.items.some((entry) => entry.id === item.id));
  const results = query.trim() ? searchDestinations(query) : favorites.flatMap((id) => FUNCTION_DESTINATIONS.find((item) => item.id === id) ?? []);

  function selectPanel(id: PanelId) { setPanelId(id); setCollapsed(false); }
  function closeNavigation() { setMobileOpen(false); setSearchOpen(false); }
  function toggleFavorite(item: SearchDestination) {
    const exists = favorites.includes(item.id);
    setFavorites((current) => exists ? current.filter((id) => id !== item.id) : [...current, item.id]);
    setFeedback(`${item.label}${exists ? "已从常用移除" : "已收藏到常用"}`);
  }
  function moduleRail(instance: "desktop" | "mobile") {
    return <div className="nav-preview-rail">
      <Link href={previewHref("dashboard")} className="nav-preview-brand" aria-label="YummyAI 运营总览预览" onClick={closeNavigation}>
        <Layers3 size={23} aria-hidden="true" /><strong>YummyAI</strong>
      </Link>
      <nav className="nav-preview-modules" aria-label="业务模块">
        <button type="button" aria-pressed={panelId === "favorites"} aria-controls={`${instance}-preview-pages`} onClick={() => selectPanel("favorites")}>
          <Star size={20} aria-hidden="true" /><span>常用</span>
        </button>
        {SIDEBAR_GROUPS.map((item) => {
          const Icon = groupIcons[item.id];
          return <button type="button" key={item.id} aria-pressed={panelId === item.id}
            aria-controls={`${instance}-preview-pages`} data-current={active.groupId === item.id || undefined}
            title={active.groupId === item.id ? `${item.label} · 当前页面所属模块` : item.label}
            onClick={() => selectPanel(item.id)}>
            <Icon size={20} aria-hidden="true" /><span>{item.label === "总览" ? "运营总览" : item.label}</span>
          </button>;
        })}
      </nav>
      <button type="button" className="nav-preview-rail-search" aria-label="找功能" aria-keyshortcuts="Control+k Meta+k" onClick={() => setSearchOpen(true)}>
        <Search size={19} aria-hidden="true" /><span>找功能</span>
      </button>
    </div>;
  }
  function pagePanel(instance: "desktop" | "mobile") {
    return <aside className="nav-preview-pages" id={`${instance}-preview-pages`} aria-label="模块页面">
      <header><h2>{panelId === "favorites" ? "常用页面" : group?.label}</h2>
        {instance === "desktop" ? <button type="button" aria-label="收起页面栏" title="收起页面栏" onClick={() => setCollapsed(true)}><PanelLeftClose size={18} /></button>
          : <button type="button" aria-label="关闭导航" data-initial-focus onClick={() => setMobileOpen(false)}><X size={20} /></button>}
      </header>
      <p className="nav-preview-panel-description">{panelId === "favorites" ? "收藏常用入口，跨模块直接进入。" : group?.description}</p>
      <nav className="nav-preview-page-list" aria-label={panelId === "favorites" ? "常用页面" : `${group?.label}页面`}>
        {panelItems.map((item) => {
          const Icon = destinationIcons[item.id as ErpSection] ?? Layers3;
          const saved = favorites.includes(item.id);
          return <div className="nav-preview-page-row" key={item.id} data-current={activeId === item.id || undefined}>
            <Link href={previewHref(item.id)} prefetch={false} aria-current={activeId === item.id ? "page" : undefined} onClick={closeNavigation}>
              <Icon size={16} aria-hidden="true" /><span>{item.label}</span>
            </Link>
            <button type="button" aria-label={`${saved ? "取消收藏" : "收藏"}${item.label}`} aria-pressed={saved} title={saved ? "取消收藏" : "收藏到常用"} onClick={() => toggleFavorite(item)}>
              <Star size={14} aria-hidden="true" fill={saved ? "currentColor" : "none"} />
            </button>
          </div>;
        })}
        {!panelItems.length && <div className="nav-preview-favorites-empty"><Star size={22} aria-hidden="true" /><strong>还没有常用页面</strong><p>选择业务模块，点击页面旁的星标即可收藏。</p></div>}
      </nav>
      <footer><Search size={14} aria-hidden="true" /><span>找功能</span><kbd>Ctrl / ⌘ K</kbd></footer>
    </aside>;
  }

  return <div className="nav-preview" data-collapsed={collapsed}>
    <a className="nav-preview-skip" href="#navigation-preview-content">跳到页面内容</a>
    <div className="nav-preview-desktop-rail">{moduleRail("desktop")}</div>
    <div className="nav-preview-desktop-pages">{pagePanel("desktop")}</div>
    <div className="nav-preview-workspace">
      <header className="nav-preview-topbar">
        <button type="button" className="nav-preview-mobile-trigger" aria-label="打开导航" aria-haspopup="dialog" aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)}><Menu size={20} /></button>
        {collapsed && <button type="button" className="nav-preview-expand" aria-label="展开页面栏" onClick={() => setCollapsed(false)}><PanelLeftOpen size={19} /></button>}
        <nav aria-label="当前位置"><span>{active.groupLabel}</span><ChevronRight size={14} aria-hidden="true" /><strong>{active.label}</strong></nav>
        <span className="nav-preview-badge">导航预览</span>
        <Link className="nav-preview-exit" href={active.href}>返回 ERP<ArrowRight size={14} aria-hidden="true" /></Link>
      </header>
      <main id="navigation-preview-content" tabIndex={-1}>
        <div className="nav-preview-page-heading"><div><h1>{active.label}</h1><p>{active.description}</p></div>
          <Link className="nav-preview-open-real" href={active.href} target="_blank" rel="noopener noreferrer">打开实际页面<ExternalLink size={15} aria-hidden="true" /></Link>
        </div>
        <div className="nav-preview-guide"><span>试用双栏导航</span><p>左栏切换模块，旁边的页面列表常驻显示。点击星标，可把跨模块入口放到“常用”。</p></div>
        <PreviewSurface activeId={activeId} />
        <div className="nav-preview-workflow"><span>试走日常操作</span>
          <nav aria-label="日常操作体验">{["orders", "production-editor", "suppliers"].map((id, index) => {
            const item = FUNCTION_DESTINATIONS.find((entry) => entry.id === id)!;
            return <span key={id}>{index > 0 && <ChevronRight size={14} aria-hidden="true" />}<Link href={previewHref(id)} prefetch={false} aria-current={activeId === id ? "step" : undefined}>{item.label}</Link></span>;
          })}</nav>
        </div>
        <p className="nav-preview-footnote"><ArrowLeft size={14} aria-hidden="true" />切换模块时，当前工作页会保留；选中具体页面后才跳转。</p>
      </main>
    </div>
    <span className="nav-preview-sr-only" role="status">{feedback}</span>
    {mobileOpen && <PreviewDialog label="全部导航" onClose={() => setMobileOpen(false)} className="nav-preview-mobile-dialog">
      <div className="nav-preview-mobile-navigation">{moduleRail("mobile")}{pagePanel("mobile")}</div>
    </PreviewDialog>}
    {searchOpen && <PreviewDialog label="找功能" onClose={() => setSearchOpen(false)} className="nav-preview-search-dialog">
      <header><h2>找功能</h2><button type="button" aria-label="关闭功能搜索" onClick={() => setSearchOpen(false)}><X size={20} /></button></header>
      <div className="nav-preview-search-input"><Search size={19} aria-hidden="true" /><input ref={searchInput} data-initial-focus aria-label="搜索页面或功能" value={query} placeholder="搜索订单、生产图、供应商…" onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown") { event.preventDefault(); searchResults.current?.querySelector<HTMLAnchorElement>("a")?.focus(); }
          if (event.key === "Enter") { event.preventDefault(); searchResults.current?.querySelector<HTMLAnchorElement>("a")?.click(); }
        }} /></div>
      <p role="status">{query.trim() ? `找到 ${results.length} 个入口` : "常用页面"}</p>
      <div className="nav-preview-search-results" ref={searchResults}>
        {results.map((item) => <Link key={item.id} href={previewHref(item.id)} prefetch={false} onClick={closeNavigation}
          onKeyDown={(event) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            const links = Array.from(searchResults.current?.querySelectorAll<HTMLAnchorElement>("a") ?? []);
            const next = links.indexOf(event.currentTarget) + (event.key === "ArrowDown" ? 1 : -1);
            if (next < 0) searchInput.current?.focus(); else links[Math.min(next, links.length - 1)]?.focus();
          }}><div><strong>{item.label}</strong><span>{item.description}</span></div><small>{item.groupLabel}</small></Link>)}
        {!results.length && <p className="nav-preview-search-empty">没有找到对应页面，换个关键词试试。</p>}
      </div>
      <footer>↑ ↓ 选择 · Enter 打开 · Esc 关闭</footer>
    </PreviewDialog>}
  </div>;
}
