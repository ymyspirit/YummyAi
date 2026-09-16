"use client";

import {
  ArrowRight, Layers3, LayoutGrid, Menu, PanelLeftClose, Search, Star, Truck, X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  DIRECTORY_DESTINATION, FUNCTION_DESTINATIONS, PRIMARY_DESTINATIONS, QUICK_DESTINATION_IDS, SIDEBAR_GROUPS, SIDEBAR_SHORTCUTS,
  resolveNavigationLocation, searchDestinations, type ErpSection, type NavigationDestination, type NavigationGroupId,
} from "./navigation-registry";
import { destinationIcons, groupIcons } from "./navigation-icons";
import { setSidebarCompact } from "./appearance-preferences";
import { useFavoritePages } from "./favorite-pages";

type NavigationPanel = NavigationGroupId | "favorites";

function Shortcuts({ onNavigate }: { onNavigate?: () => void }) {
  return <nav aria-label="常用任务快捷入口" className="erp-sidebar-shortcuts">
    <p><Star size={12} aria-hidden="true" />常用任务</p>
    {SIDEBAR_SHORTCUTS.map((shortcut) => {
      const item = FUNCTION_DESTINATIONS.find((entry) => entry.id === shortcut.id)!;
      const Icon = destinationIcons[item.id as ErpSection] ?? Truck;
      return <Link key={item.id} href={item.href} title={shortcut.label} prefetch={false} onClick={onNavigate}>
        <Icon size={16} aria-hidden="true" /><span>{shortcut.label}</span><ArrowRight size={13} aria-hidden="true" />
      </Link>;
    })}
  </nav>;
}

function SplitNavigation({ activeId, pathname, panel, onSelectPanel, favorites, onToggleFavorite, onNavigate, onSearch, mobile = false }: {
  activeId?: string; pathname: string; panel: NavigationPanel; onSelectPanel: (panel: NavigationPanel) => void;
  favorites: string[]; onToggleFavorite: (item: NavigationDestination) => void;
  onNavigate: () => void; onSearch: () => void; mobile?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const activeGroup = SIDEBAR_GROUPS.find((group) => group.items.some((item) => item.id === activeId))?.id;
  const selectedGroup = SIDEBAR_GROUPS.find((group) => group.id === panel);
  const prefix = mobile ? "mobile-" : "";
  useEffect(() => {
    const nav = container.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active || !active.getClientRects().length) return;
    const bounds = nav.getBoundingClientRect();
    const item = active.getBoundingClientRect();
    if (item.bottom > bounds.bottom) nav.scrollTop += item.bottom - bounds.bottom + 8;
    else if (item.top < bounds.top) nav.scrollTop -= bounds.top - item.top + 8;
  }, [activeId, panel]);

  function selectPanel(value: NavigationPanel) {
    onSelectPanel(value);
    // A mobile selection must not overwrite the desktop's saved collapse choice.
    if (!mobile) setSidebarCompact(false);
  }
  function pageRow(item: NavigationDestination, visible: boolean) {
    const Icon = destinationIcons[item.id as ErpSection] ?? Layers3;
    const saved = favorites.includes(item.id);
    return <div className="erp-page-link-row" key={item.id} data-current={activeId === item.id || undefined}>
      <Link href={item.href} prefetch={false} title={`${item.label} · ${item.description}`} onClick={onNavigate}
        aria-current={visible && activeId === item.id ? "page" : undefined}>
        <Icon size={16} aria-hidden="true" /><span>{item.label}</span>
      </Link>
      <button type="button" title={saved ? "取消收藏" : "收藏到常用"} aria-label={`${saved ? "取消收藏" : "收藏"}${item.label}`} aria-pressed={saved} onClick={() => onToggleFavorite(item)}>
        <Star size={14} aria-hidden="true" fill={saved ? "currentColor" : "none"} />
      </button>
    </div>;
  }

  return <div className="erp-split-navigation">
    <div className="erp-module-rail">
      <Link href="/" className="erp-module-brand" aria-label="YummyAI 运营总览" title="YummyAI 运营总览" onClick={onNavigate}>
        <Layers3 size={23} aria-hidden="true" /><strong>YummyAI</strong>
      </Link>
      <div className="erp-module-nav" role="group" aria-label="业务模块">
        <button type="button" aria-pressed={panel === "favorites"} aria-controls={`${prefix}rail-favorites`} onClick={() => selectPanel("favorites")}>
          <Star size={20} aria-hidden="true" /><span>常用</span>
        </button>
        {SIDEBAR_GROUPS.map((group) => {
          const Icon = groupIcons[group.id];
          return <button type="button" key={group.id} id={`${prefix}rail-group-${group.id}`} aria-controls={`${prefix}rail-items-${group.id}`}
            aria-pressed={panel === group.id} data-active={activeGroup === group.id || undefined}
            title={activeGroup === group.id ? `${group.label} · 当前页面所属模块` : group.label} onClick={() => selectPanel(group.id)}>
            <Icon size={20} aria-hidden="true" /><span>{group.label}</span>
          </button>;
        })}
      </div>
      <div className="erp-module-tools">
        <button type="button" aria-label="找功能" title="找功能（Ctrl K）" aria-keyshortcuts="Control+k Meta+k" onClick={onSearch}><Search size={18} aria-hidden="true" /><span>找功能</span></button>
        <Link href={DIRECTORY_DESTINATION.href} title="全部功能" onClick={onNavigate} aria-current={pathname === "/navigation" ? "page" : undefined}>
          <LayoutGrid size={18} aria-hidden="true" /><span>全部功能</span>
        </Link>
      </div>
    </div>
    <div className="erp-page-panel">
      <header><h2>{panel === "favorites" ? "常用页面" : selectedGroup?.label}</h2>
        {mobile ? <button type="button" aria-label="关闭导航" data-initial-focus onClick={onNavigate}><X size={20} /></button>
          : <button type="button" aria-label="收起页面栏" title="收起页面栏" onClick={(event) => {
            event.currentTarget.closest(".erp-split-navigation")?.querySelector<HTMLButtonElement>('.erp-module-nav button[aria-pressed="true"]')?.focus();
            setSidebarCompact(true);
          }}><PanelLeftClose size={18} /></button>}
      </header>
      <p className="erp-page-panel-description">{panel === "favorites" ? "收藏常用入口，跨模块直接进入。" : selectedGroup?.description}</p>
      <div className="erp-page-panel-scroll" ref={container}>
        <nav className="erp-navigation-links" aria-label="主导航" hidden={panel === "favorites"}>
          {SIDEBAR_GROUPS.map((group) => <section key={group.id} id={`${prefix}rail-items-${group.id}`} aria-labelledby={`${prefix}rail-group-${group.id}`} hidden={panel !== group.id}>
            {group.items.map((item) => pageRow(item, panel === group.id))}
          </section>)}
        </nav>
        <nav aria-label="常用页面" id={`${prefix}rail-favorites`} hidden={panel !== "favorites"}>
          {panel === "favorites" && favorites.flatMap((id) => PRIMARY_DESTINATIONS.find((item) => item.id === id) ?? []).map((item) => pageRow(item, true))}
          {!favorites.length && <div className="erp-favorites-empty"><Star size={22} aria-hidden="true" /><strong>还没有常用页面</strong><p>选择业务模块，点击页面旁的星标即可收藏。</p></div>}
        </nav>
      </div>
      <Shortcuts onNavigate={onNavigate} />
    </div>
  </div>;
}

function NavigationDialog({ label, onClose, children, className = "" }: {
  label: string; onClose: () => void; children: ReactNode; className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
    document.body.style.overflow = "hidden";
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  return <dialog ref={ref} aria-label={label} className={`erp-navigation-dialog ${className}`}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onKeyDown={(event) => {
      if (event.key !== "Tab") return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]'))
        .filter((element) => element.tabIndex >= 0 && !element.hasAttribute("disabled") && element.getClientRects().length > 0);
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    {children}
  </dialog>;
}

function FunctionSearch({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const results = query.trim() ? searchDestinations(query) : QUICK_DESTINATION_IDS.map((id) => FUNCTION_DESTINATIONS.find((item) => item.id === id)!);
  return <NavigationDialog label="找功能" onClose={onClose} className="erp-function-search">
    <header><h2>找功能</h2><button type="button" aria-label="关闭功能搜索" onClick={onClose}><X size={19} /></button></header>
    <div className="erp-search-field">
      <Search size={19} aria-hidden="true" />
      <input ref={input} data-initial-focus aria-label="搜索页面或功能" placeholder="试试：订单报告、抱枕、备胎罩、生产图…"
        value={query} onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown") { event.preventDefault(); list.current?.querySelector<HTMLAnchorElement>("a")?.focus(); }
          if (event.key === "Enter") { event.preventDefault(); list.current?.querySelector<HTMLAnchorElement>("a")?.click(); }
        }} />
      {query && <button type="button" aria-label="清空搜索" onClick={() => { setQuery(""); input.current?.focus(); }}><X size={15} /></button>}
    </div>
    <p className="erp-search-status" role="status">{query.trim() ? `找到 ${results.length} 个入口` : "常用任务"}</p>
    <div className="erp-search-results" ref={list}>
      {results.length ? results.map((item) => <Link key={item.id} href={item.href} prefetch={false} onClick={onClose}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          const links = Array.from(list.current?.querySelectorAll<HTMLAnchorElement>("a") ?? []);
          const index = links.indexOf(event.currentTarget);
          const next = index + (event.key === "ArrowDown" ? 1 : -1);
          if (next < 0) input.current?.focus(); else links[Math.min(next, links.length - 1)]?.focus();
        }}>
        <div><strong>{item.label}</strong><p>{item.description}</p></div>
        <span>{item.groupLabel}<ArrowRight size={16} aria-hidden="true" /></span>
      </Link>) : <div className="erp-search-empty"><strong>没有找到对应功能</strong><p>换个叫法，或打开全部功能按业务分组查看。</p></div>}
    </div>
    <footer><span>↑ ↓ 选择 · Enter 打开 · Esc 关闭</span><Link href="/navigation" onClick={onClose}>浏览全部功能<ArrowRight size={14} /></Link></footer>
  </NavigationDialog>;
}

export function ErpSidebar() {
  const pathname = usePathname() ?? "/";
  const location = resolveNavigationLocation(pathname);
  const activeGroup = SIDEBAR_GROUPS.find((group) => group.items.some((item) => item.id === location.primaryId))?.id;
  const [panel, setPanel] = useState<NavigationPanel>(activeGroup ?? "commerce");
  const previousPath = useRef(pathname);
  const { favorites, toggleFavorite } = useFavoritePages();
  const [feedback, setFeedback] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setMenuOpen(false);
        setSearchOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);
  useEffect(() => { setMenuOpen(false); setSearchOpen(false); }, [pathname]);
  useEffect(() => {
    if (previousPath.current === pathname) return;
    previousPath.current = pathname;
    setPanel((current) => current === "favorites" && favorites.includes(location.primaryId ?? "") ? current : activeGroup ?? "commerce");
  }, [activeGroup, favorites, location.primaryId, pathname]);
  function togglePageFavorite(item: NavigationDestination) {
    setFeedback(`${item.label}${favorites.includes(item.id) ? "已从常用移除" : "已收藏到常用"}`);
    toggleFavorite(item.id);
  }
  function openSearch() { setMenuOpen(false); setSearchOpen(true); }
  const navigationProps = {
    activeId: location.primaryId, pathname, panel, onSelectPanel: setPanel,
    favorites, onToggleFavorite: togglePageFavorite,
    onNavigate: () => setMenuOpen(false), onSearch: openSearch,
  };
  return <>
    <aside aria-label="ERP 主导航" className="erp-sidebar">
      <SplitNavigation {...navigationProps} />
    </aside>
    <div className="erp-mobile-bar">
      <Link href="/" aria-label="YummyAI 运营总览"><Layers3 size={22} /><strong>YummyAI</strong></Link>
      <span>{location.current.label}</span>
      <button type="button" aria-label="找功能" onClick={() => setSearchOpen(true)}><Search size={19} /></button>
      <button type="button" aria-label="打开全部导航" aria-expanded={menuOpen} aria-haspopup="dialog" onClick={() => setMenuOpen(true)}><Menu size={19} />菜单</button>
    </div>
    {menuOpen && <NavigationDialog label="全部导航" onClose={() => setMenuOpen(false)} className="erp-mobile-menu">
      <SplitNavigation {...navigationProps} mobile />
    </NavigationDialog>}
    {searchOpen && <FunctionSearch onClose={() => setSearchOpen(false)} />}
    <span className="erp-nav-announcement" aria-live="polite" aria-atomic="true">{feedback}</span>
  </>;
}
