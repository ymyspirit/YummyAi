export const themeKey = "yummyai.ui.theme";
export const sidebarKey = "yummyai.ui.sidebar";
export const sidebarChangeEvent = "yummyai:sidebar-change";

export function setSidebarCompact(compact: boolean) {
  document.documentElement.dataset.sidebar = compact ? "compact" : "expanded";
  try { localStorage.setItem(sidebarKey, compact ? "compact" : "expanded"); } catch { /* Keep the current-tab preference. */ }
  window.dispatchEvent(new Event(sidebarChangeEvent));
}

// Runs before paint, with no business data or external script dependency.
export const ERP_APPEARANCE_BOOTSTRAP = `(function(){try{var t=localStorage.getItem('${themeKey}');document.documentElement.dataset.theme=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light';if(localStorage.getItem('${sidebarKey}')==='compact')document.documentElement.dataset.sidebar='compact';}catch(e){document.documentElement.dataset.theme='light';}})();`;
