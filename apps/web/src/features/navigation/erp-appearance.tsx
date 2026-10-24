"use client";

import { Monitor, Moon, PanelLeftClose, PanelLeftOpen, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { setSidebarCompact, sidebarChangeEvent, sidebarKey, themeKey } from "./appearance-preferences";

type Theme = "light" | "dark" | "system";

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.dataset.themeChanging = "true";
  root.dataset.theme = theme === "system" ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" : theme;
  // Apply foreground and background together, including controls with hover transitions.
  void window.getComputedStyle(document.body).color;
  requestAnimationFrame(() => { delete root.dataset.themeChanging; });
}

export function ErpAppearance() {
  const [theme, setTheme] = useState<Theme>("light");
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    function readPreferences() {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(themeKey);
        setCompact(localStorage.getItem(sidebarKey) === "compact");
      } catch { /* Display preferences remain usable when storage is unavailable. */ }
      const preference = saved === "dark" || saved === "system" ? saved : "light";
      setTheme(preference);
      applyTheme(preference);
      try { document.documentElement.dataset.sidebar = localStorage.getItem(sidebarKey) === "compact" ? "compact" : "expanded"; } catch { /* Use the current layout. */ }
    }
    readPreferences();
    function readCurrentSidebar() { setCompact(document.documentElement.dataset.sidebar === "compact"); }
    media.addEventListener("change", readPreferences);
    window.addEventListener("storage", readPreferences);
    window.addEventListener(sidebarChangeEvent, readCurrentSidebar);
    return () => {
      media.removeEventListener("change", readPreferences);
      window.removeEventListener("storage", readPreferences);
      window.removeEventListener(sidebarChangeEvent, readCurrentSidebar);
    };
  }, []);

  function changeTheme(value: Theme) {
    setTheme(value);
    applyTheme(value);
    try { localStorage.setItem(themeKey, value); } catch { /* Current-tab selection still applies. */ }
  }

  function toggleSidebar() {
    setSidebarCompact(document.documentElement.dataset.sidebar !== "compact");
  }

  return <div className="erp-appearance">
    <button type="button" className="erp-sidebar-toggle" aria-label={compact ? "展开页面栏" : "收起页面栏"} title={compact ? "展开页面栏" : "收起页面栏"} aria-pressed={compact} onClick={toggleSidebar}>
      {compact ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
    </button>
    <div className="erp-theme-options" role="group" aria-label="界面主题">
      {([{ value: "light", label: "浅色", Icon: Sun }, { value: "dark", label: "深色", Icon: Moon }, { value: "system", label: "跟随系统", Icon: Monitor }] as const).map(({ value, label, Icon }) =>
        <button key={value} type="button" aria-label={label} title={label} aria-pressed={theme === value} onClick={() => changeTheme(value)}><Icon size={16} /></button>)}
    </div>
  </div>;
}
