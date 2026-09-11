"use client";

import {
  ArrowRight, ChevronDown, Layers3, LayoutGrid, Menu, Search, Star, Truck, X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  DIRECTORY_DESTINATION, FUNCTION_DESTINATIONS, QUICK_DESTINATION_IDS, SIDEBAR_GROUPS, SIDEBAR_SHORTCUTS,
  resolveNavigationLocation, searchDestinations, type ErpSection, type NavigationGroupId,
} from "./navigation-registry";
import { destinationIcons, groupIcons } from "./navigation-icons";

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

function NavigationLinks({ activeId, onNavigate, mobile = false }: {
  activeId?: string; onNavigate?: () => void; mobile?: boolean;
}) {
  const container = useRef<HTMLElement>(null);
  const activeGroup = SIDEBAR_GROUPS.find((group) => group.items.some((item) => item.id === activeId))?.id;
  const [openGroup, setOpenGroup] = useState<NavigationGroupId | null>(activeGroup ?? "commerce");
  const previousActive = useRef(activeId);
  useEffect(() => {
    // Do not overwrite a user's early click when hydration runs the mount effect.
    if (previousActive.current !== activeId) {
      previousActive.current = activeId;
      setOpenGroup(activeGroup ?? "commerce");
    }
  }, [activeGroup, activeId]);
  useEffect(() => {
    const nav = container.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active || !active.getClientRects().length) return;
    const bounds = nav.getBoundingClientRect();
    const item = active.getBoundingClientRect();
    if (item.bottom > bounds.bottom) nav.scrollTop += item.bottom - bounds.bottom + 8;
    else if (item.top < bounds.top) nav.scrollTop -= bounds.top - item.top + 8;
  }, [activeId, openGroup]);
  return <nav ref={container} className="erp-navigation-links" aria-label="主导航">
    <p className="erp-navigation-caption">业务模块</p>
    {SIDEBAR_GROUPS.map((group) => {
      const prefix = mobile ? "mobile-" : "";
      const expanded = openGroup === group.id;
      const GroupIcon = groupIcons[group.id];
      const links = group.items.map((item) => {
        const Icon = destinationIcons[item.id];
        return <Link key={item.id} href={item.href} onClick={onNavigate} prefetch={false}
          title={`${item.label} · ${item.description}`} aria-current={activeId === item.id ? "page" : undefined}>
          <Icon aria-hidden="true" size={17} /><span>{item.label}</span>
        </Link>;
      });
      if (group.id === "overview") return <div className="erp-navigation-home" key={group.id}>{links}</div>;
      return <section aria-labelledby={`${prefix}rail-group-${group.id}`} className="erp-navigation-group" key={group.id}>
        <button type="button" id={`${prefix}rail-group-${group.id}`}
          title={group.label} aria-expanded={expanded} aria-controls={`${prefix}rail-items-${group.id}`}
          data-active={activeGroup === group.id || undefined}
          onClick={() => setOpenGroup((open) => open === group.id ? null : group.id)}>
          <GroupIcon size={18} aria-hidden="true" /><span>{group.label}</span>
          <ChevronDown size={15} aria-hidden="true" />
        </button>
        <div className="erp-navigation-children" id={`${prefix}rail-items-${group.id}`} hidden={!expanded}>{links}</div>
      </section>;
    })}
  </nav>;
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
  const directoryLink = <Link className="erp-directory-link" href={DIRECTORY_DESTINATION.href} title="全部功能"
    onClick={() => setMenuOpen(false)} aria-current={pathname === "/navigation" ? "page" : undefined}>
    <LayoutGrid size={17} aria-hidden="true" /><span>全部功能</span><ArrowRight size={14} aria-hidden="true" />
  </Link>;
  return <>
    <aside aria-label="ERP 主导航" className="erp-sidebar">
      <Link href="/" className="erp-brand" aria-label="YummyAI 运营总览" title="YummyAI 运营总览"><Layers3 size={22} aria-hidden="true" /><span><strong>YummyAI</strong><small>电商与生产工作台</small></span></Link>
      <button className="erp-find-trigger" type="button" title="找功能（Ctrl K）" onClick={() => setSearchOpen(true)} aria-keyshortcuts="Control+k Meta+k"><Search size={17} aria-hidden="true" /><span>找功能</span><kbd>Ctrl K</kbd></button>
      <Shortcuts />
      <NavigationLinks activeId={location.primaryId} />
      <div className="erp-rail-footer">{directoryLink}</div>
    </aside>
    <div className="erp-mobile-bar">
      <Link href="/" aria-label="YummyAI 运营总览"><Layers3 size={22} /><strong>YummyAI</strong></Link>
      <span>{location.current.label}</span>
      <button type="button" aria-label="找功能" onClick={() => setSearchOpen(true)}><Search size={19} /></button>
      <button type="button" aria-label="打开全部导航" aria-expanded={menuOpen} aria-haspopup="dialog" onClick={() => setMenuOpen(true)}><Menu size={19} />菜单</button>
    </div>
    {menuOpen && <NavigationDialog label="全部导航" onClose={() => setMenuOpen(false)} className="erp-mobile-menu">
      <header><h2>全部导航</h2><button type="button" aria-label="关闭导航" onClick={() => setMenuOpen(false)}><X size={20} /></button></header>
      <Shortcuts onNavigate={() => setMenuOpen(false)} />
      <NavigationLinks activeId={location.primaryId} mobile onNavigate={() => setMenuOpen(false)} />
      <div className="erp-rail-footer">{directoryLink}</div>
    </NavigationDialog>}
    {searchOpen && <FunctionSearch onClose={() => setSearchOpen(false)} />}
  </>;
}
