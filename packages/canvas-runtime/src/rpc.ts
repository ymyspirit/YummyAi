export type StudioInit = { theme: "light" | "dark"; tool: string; scope: string };
const params = new URLSearchParams(location.search);
const parentOrigin = params.get("parentOrigin") ?? "";
export const channel = params.get("channel") ?? "";
const waiting = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
let resolveInit: (value: StudioInit) => void;
export const initialized = new Promise<StudioInit>(resolve => { resolveInit = resolve; });
export function notify(type: string, payload: Record<string, unknown> = {}) { parent.postMessage({ type, channel, ...payload }, parentOrigin); }
export function openSettings() { notify("studio.navigate", { tool: "settings" }); }
function requestDeadline(id: string) {
  return setTimeout(() => {
    const pending = waiting.get(id); if (!pending) return;
    waiting.delete(id); pending.reject(new Error("数据读取或保存超时，请保留当前页面并重试"));
  }, 110_000);
}
export function rpc<T = unknown>(request: Record<string, unknown>): Promise<T> {
  const id = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timeout = requestDeadline(id);
    waiting.set(id, { resolve: value => resolve(value as T), reject, timeout });
    notify("studio.request", { id, request });
  });
}
export function connect() {
  if (parent === window || !channel || !parentOrigin || new URL(parentOrigin).origin !== parentOrigin) throw new Error("请从 YummyAI ERP 打开创作页面");
  // The parent may still be mounting or restoring the project when we start.
  // A one-shot ready message can leave a healthy editor waiting forever.
  const handshake = setInterval(() => notify("studio.ready"), 2000);
  window.addEventListener("message", event => {
    if (event.source !== parent || event.origin !== parentOrigin || event.data?.channel !== channel) return;
    const data = event.data;
    if (data.type === "studio.init") { clearInterval(handshake); resolveInit(data as StudioInit); }
    if (data.type === "studio.request-pending" && typeof data.id === "string") {
      const pending = waiting.get(data.id);
      if (pending) { clearTimeout(pending.timeout); pending.timeout = requestDeadline(data.id); }
    }
    if (data.type === "studio.response" && typeof data.id === "string") {
      const pending = waiting.get(data.id); if (!pending) return;
      waiting.delete(data.id); clearTimeout(pending.timeout);
      if (data.error) pending.reject(new Error(String(data.error))); else pending.resolve(data.result);
    }
    if (["studio.theme", "studio.backup", "studio.retry", "studio.tool", "studio.refresh"].includes(data.type)) window.dispatchEvent(new CustomEvent(data.type, { detail: data }));
  });
  notify("studio.ready");
}
