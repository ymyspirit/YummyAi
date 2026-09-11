"use client";

import { Monitor, Moon, PanelLeftClose, PanelLeftOpen, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { sidebarKey, themeKey } from "./appearance-preferences";

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
  const [theme, setTheme] = useState<Theme>("system");
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    function readPreferences() {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(themeKey);
        setCompact(localStorage.getItem(sidebarKey) === "compact");
      } catch { /* Display preferences remain usable when storage is unavailable. */ }
      const preference = saved === "light" || saved === "dark" ? saved : "system";
      setTheme(preference);
      applyTheme(preference);
      try { document.documentElement.dataset.sidebar = localStorage.getItem(sidebarKey) === "compact" ? "compact" : "expanded"; } catch { /* Use the current layout. */ }
    }
    readPreferences();
    media.addEventListener("change", readPreferences);
    window.addEventListener("storage", readPreferences);
    return () => {
      media.removeEventListener("change", readPreferences);
      window.removeEventListener("storage", readPreferences);
    };
  }, []);

  function changeTheme(value: Theme) {
    setTheme(value);
    applyTheme(value);
    try { localStorage.setItem(themeKey, value); } catch { /* Current-tab selection still applies. */ }
  }

  function toggleSidebar() {
    const next = !compact;
    setCompact(next);
    document.documentElement.dataset.sidebar = next ? "compact" : "expanded";
    try { localStorage.setItem(sidebarKey, next ? "compact" : "expanded"); } catch { /* Current-tab selection still applies. */ }
  }

  return <div className="erp-appearance">
    <button type="button" className="erp-sidebar-toggle" aria-label={compact ? "展开侧边栏" : "收起侧边栏"} title={compact ? "展开侧边栏" : "收起侧边栏"} aria-pressed={compact} onClick={toggleSidebar}>
      {compact ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
    </button>
    <div className="erp-theme-options" role="group" aria-label="界面主题">
      {([{ value: "light", label: "浅色", Icon: Sun }, { value: "dark", label: "深色", Icon: Moon }, { value: "system", label: "跟随系统", Icon: Monitor }] as const).map(({ value, label, Icon }) =>
        <button key={value} type="button" aria-label={label} title={label} aria-pressed={theme === value} onClick={() => changeTheme(value)}><Icon size={16} /></button>)}
    </div>
  </div>;
}
