"use client";

import {
  ArrowRight, ArrowUpRight, ChevronDown, Layers3, LayoutGrid, Menu, Search, Star, X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  DIRECTORY_DESTINATION, FUNCTION_DESTINATIONS, PRIMARY_DESTINATIONS, QUICK_DESTINATION_IDS, SIDEBAR_GROUPS,
  resolveNavigationLocation, searchDestinations, type ErpSection, type NavigationDestination,
} from "./navigation-registry";
import { destinationIcons, groupIcons } from "./navigation-icons";
import { setSidebarCompact } from "./appearance-preferences";
import { useFavoritePages } from "./favorite-pages";

function SidebarNavigation({ activeId, pathname, favorites, onToggleFavorite, onNavigate, onSearch, mobile = false }: {
  activeId?: string; pathname: string; favorites: string[];
  onToggleFavorite: (item: NavigationDestination) => void;
  onNavigate: () => void; onSearch: () => void; mobile?: boolean;
}) {
  const activeGroup = SIDEBAR_GROUPS.find((group) => group.items.some((item) => item.id === activeId))?.id;
  const [expanded, setExpanded] = useState<string | null>(activeGroup === "overview" ? "catalog" : activeGroup ?? "catalog");
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const prefix = mobile ? "mobile-" : "";
  useEffect(() => {
    if (activeGroup && activeGroup !== "overview") setExpanded(activeGroup);
  }, [activeGroup, pathname]);
  useEffect(() => {
    const active = scroll.current?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!active || !scroll.current || !active.getClientRects().length) return;
    const bounds = scroll.current.getBoundingClientRect(), item = active.getBoundingClientRect();
    if (item.bottom > bounds.bottom) scroll.current.scrollTop += item.bottom - bounds.bottom + 12;
    else if (item.top < bounds.top) scroll.current.scrollTop -= bounds.top - item.top + 12;
  }, [activeId, expanded]);

  function pageRow(item: NavigationDestination, favorite = false) {
    const Icon = destinationIcons[item.id as ErpSection] ?? Layers3;
    const saved = favorites.includes(item.id);
    return <div className="erp-page-link-row" key={item.id} data-current={activeId === item.id || undefined}>
      <Link href={item.href} prefetch={false} title={item.label} onClick={onNavigate}
        aria-current={!favorite && activeId === item.id ? "page" : undefined}>
        <Icon size={17} aria-hidden="true" /><span>{item.label}</span>
      </Link>
      <button type="button" className="erp-favorite-toggle" title={saved ? "取消收藏" : "收藏到常用"}
        aria-label={`${saved ? "取消收藏" : "收藏"}${item.label}`} aria-pressed={saved} onClick={() => onToggleFavorite(item)}>
        <Star size={13} aria-hidden="true" fill={saved ? "currentColor" : "none"} />
      </button>
    </div>;
  }

  return <div className="erp-sidebar-inner">
    <header className="erp-sidebar-brand">
      <Link href="/" aria-label="YummyAI 运营总览" title="YummyAI 运营总览" onClick={onNavigate}>
        <span className="erp-brand-mark"><Layers3 size={22} aria-hidden="true" /></span>
        <span><strong>YummyAI</strong><small>定制商品运营空间</small></span>
      </Link>
      {mobile && <button type="button" aria-label="关闭导航" data-initial-focus onClick={onNavigate}><X size={19} /></button>}
    </header>
    <button className="erp-sidebar-search" type="button" aria-label="找功能" title="找功能（Ctrl K）" aria-keyshortcuts="Control+k Meta+k" onClick={onSearch}>
      <Search size={16} aria-hidden="true" /><span>搜索功能</span><kbd>⌘ / Ctrl K</kbd>
    </button>
    <div className="erp-sidebar-scroll" ref={scroll}>
      <nav className="erp-navigation-links" aria-label="主导航">
        <section className="erp-navigation-home" aria-label="工作台" id={`${prefix}rail-items-overview`}>
          {SIDEBAR_GROUPS.find((group) => group.id === "overview")!.items.map((item) => pageRow(item))}
        </section>
        <p className="erp-nav-caption">业务流程</p>
        <div className="erp-navigation-groups" role="group" aria-label="业务模块">
          {SIDEBAR_GROUPS.filter((group) => group.id !== "overview").map((group, index) => {
            const Icon = groupIcons[group.id];
            const open = expanded === group.id;
            return <section key={group.id} className={`erp-navigation-group${index === 2 ? " erp-support-group" : ""}`} data-active={activeGroup === group.id || undefined}>
              <button type="button" id={`${prefix}rail-group-${group.id}`} title={group.label}
                aria-controls={`${prefix}rail-items-${group.id}`} aria-expanded={open}
                onClick={() => {
                  const compact = !mobile && document.documentElement.dataset.sidebar === "compact";
                  setExpanded(open && !compact ? null : group.id);
                  if (!mobile) setSidebarCompact(false);
                }}>
                <Icon size={18} aria-hidden="true" /><span>{group.label}</span><ChevronDown size={14} aria-hidden="true" />
              </button>
              <div className="erp-navigation-collapse" data-open={open} inert={!open}>
                <div id={`${prefix}rail-items-${group.id}`} className="erp-navigation-children" aria-labelledby={`${prefix}rail-group-${group.id}`}>
                  {group.items.map((item) => pageRow(item))}
                </div>
              </div>
            </section>;
          })}
        </div>
      </nav>
      <section className="erp-sidebar-favorites">
        <button type="button" title="常用页面" aria-expanded={favoritesOpen} aria-controls={`${prefix}rail-favorites`}
          onClick={() => { setFavoritesOpen(!favoritesOpen); if (!mobile) setSidebarCompact(false); }}>
          <Star size={17} aria-hidden="true" /><span>常用页面</span><ChevronDown size={14} aria-hidden="true" />
        </button>
        <div className="erp-navigation-collapse" data-open={favoritesOpen} inert={!favoritesOpen}>
          <nav aria-label="常用页面" id={`${prefix}rail-favorites`}>
            {favorites.flatMap((id) => PRIMARY_DESTINATIONS.find((item) => item.id === id) ?? []).map((item) => pageRow(item, true))}
            {!favorites.length && <p className="erp-favorites-empty">点击页面旁的星标，收藏常用入口</p>}
          </nav>
        </div>
      </section>
    </div>
    <footer className="erp-sidebar-footer">
      <Link href={DIRECTORY_DESTINATION.href} title="全部功能" onClick={onNavigate} aria-current={pathname === "/navigation" ? "page" : undefined}>
        <LayoutGrid size={17} aria-hidden="true" /><span>全部功能</span><ArrowUpRight size={14} aria-hidden="true" />
      </Link>
    </footer>
  </div>;
}

function useDialogPresence(open: boolean) {
  const [present, setPresent] = useState(open);
  useEffect(() => {
    if (open) { setPresent(true); return; }
    const timer = setTimeout(() => setPresent(false), window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 140);
    return () => clearTimeout(timer);
  }, [open]);
  return open || present;
}

function NavigationDialog({ label, onClose, children, closing = false, className = "" }: {
  label: string; onClose: () => void; children: ReactNode; closing?: boolean; className?: string;
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
  return <dialog ref={ref} aria-label={label} data-closing={closing || undefined} className={`erp-navigation-dialog ${className}`}
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

function FunctionSearch({ onClose, closing }: { onClose: () => void; closing: boolean }) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const results = query.trim() ? searchDestinations(query) : QUICK_DESTINATION_IDS.map((id) => FUNCTION_DESTINATIONS.find((item) => item.id === id)!);
  return <NavigationDialog label="找功能" onClose={onClose} closing={closing} className="erp-function-search">
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
  const { favorites, toggleFavorite } = useFavoritePages();
  const [feedback, setFeedback] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const searchPresent = useDialogPresence(searchOpen);
  const menuPresent = useDialogPresence(menuOpen);
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
  function togglePageFavorite(item: NavigationDestination) {
    setFeedback(`${item.label}${favorites.includes(item.id) ? "已从常用移除" : "已收藏到常用"}`);
    toggleFavorite(item.id);
  }
  function openSearch() { setMenuOpen(false); setSearchOpen(true); }
  const navigationProps = {
    activeId: location.primaryId, pathname,
    favorites, onToggleFavorite: togglePageFavorite,
    onNavigate: () => setMenuOpen(false), onSearch: openSearch,
  };
  return <>
    <aside aria-label="ERP 主导航" className="erp-sidebar">
      <SidebarNavigation {...navigationProps} />
    </aside>
    <div className="erp-mobile-bar">
      <Link href="/" aria-label="YummyAI 运营总览"><Layers3 size={22} /><strong>YummyAI</strong></Link>
      <span>{location.current.label}</span>
      <button type="button" aria-label="找功能" onClick={() => setSearchOpen(true)}><Search size={19} /></button>
      <button type="button" aria-label="打开全部导航" aria-expanded={menuOpen} aria-haspopup="dialog" onClick={() => setMenuOpen(true)}><Menu size={19} />菜单</button>
    </div>
    {menuPresent && !searchPresent && <NavigationDialog label="全部导航" closing={!menuOpen} onClose={() => setMenuOpen(false)} className="erp-mobile-menu">
      <SidebarNavigation {...navigationProps} mobile />
    </NavigationDialog>}
    {searchPresent && <FunctionSearch closing={!searchOpen} onClose={() => setSearchOpen(false)} />}
    <span className="erp-nav-announcement" aria-live="polite" aria-atomic="true">{feedback}</span>
  </>;
}
