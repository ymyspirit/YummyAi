export const themeKey = "yummyai.ui.theme";
export const sidebarKey = "yummyai.ui.sidebar";

// Runs before paint, with no business data or external script dependency.
export const ERP_APPEARANCE_BOOTSTRAP = `(function(){try{var t=localStorage.getItem('${themeKey}');document.documentElement.dataset.theme=(t==='light'||t==='dark')?t:(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');if(localStorage.getItem('${sidebarKey}')==='compact')document.documentElement.dataset.sidebar='compact';}catch(e){document.documentElement.dataset.theme='light';}})();`;
