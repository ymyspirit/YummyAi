import { connect, notify } from "./rpc";
window.addEventListener("unhandledrejection", event => { notify("studio.error", { error: event.reason instanceof Error ? event.reason.message : "创作页面处理失败，请导出备份并重试" }); });
try {
  connect();
  // Download the editor while the parent validates the project. app.tsx still
  // waits for the verified initialization before rendering or accessing data.
  if (new URLSearchParams(location.search).get("surface") === "settings") await import("./settings-app");
  else await import("./app");
} catch (cause) { document.getElementById("root")!.textContent = cause instanceof Error ? cause.message : "无法打开创作页面"; }
