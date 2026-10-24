import { CANVAS_BRIDGE, CanvasResponseSchema, canvasVersionSupported, type CanvasRequest } from "@yummyai/contracts/pod/canvas-bridge";

export function bridgeLocation(search: string) {
  const params = new URLSearchParams(search.replace(/^[?#]/, ""));
  const origin = params.get("yummyaiOrigin"), channelId = params.get("yummyaiChannel");
  if (!origin || !channelId || !/^[0-9a-f-]{36}$/i.test(channelId)) return null;
  try {
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) return null;
    return { origin, channelId };
  } catch { return null; }
}

type RequestFields = { type: "ready"; upstreamVersion: string; pluginVersion: string } | { type: "brief.read" } | { type: "asset.read"; assetId: string } | { type: "result.submit"; input: Extract<CanvasRequest, { type: "result.submit" }>["input"] };
export function createConnection(upstreamVersion: string) {
  const location = bridgeLocation(window.location.search) ?? bridgeLocation(window.location.hash);
  const opener = window.opener;
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let connected = false;
  const listener = (event: MessageEvent) => {
    if (!location || event.source !== opener || event.origin !== location.origin) return;
    const parsed = CanvasResponseSchema.safeParse(event.data);
    if (!parsed.success || parsed.data.channelId !== location.channelId) return;
    const waiter = pending.get(parsed.data.requestId); if (!waiter) return;
    pending.delete(parsed.data.requestId); clearTimeout(waiter.timer);
    if (parsed.data.ok) waiter.resolve(parsed.data.payload); else waiter.reject(new Error(parsed.data.error ?? "ERP 请求失败"));
  };
  window.addEventListener("message", listener);
  const request = (fields: RequestFields): Promise<unknown> => {
    if (!location || !opener || opener.closed) return Promise.reject(new Error("请保留 ERP 页面，并从 ERP 的当前需求重新打开画布"));
    if (!canvasVersionSupported(upstreamVersion, CANVAS_BRIDGE.pluginVersion)) return Promise.reject(new Error(`当前画布版本 ${upstreamVersion} 尚未验证，请使用 ${CANVAS_BRIDGE.upstreamVersion}`));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); connected = false; reject(new Error("ERP 连接超时，请从 ERP 重新打开画布；图片仍保留在画布中")); }, fields.type === "result.submit" ? 110_000 : 25_000);
      pending.set(requestId, { resolve, reject, timer });
      opener.postMessage({ channel: "yummyai-canvas", protocolVersion: 1, channelId: location.channelId, requestId, ...fields }, location.origin);
    });
  };
  return {
    request,
    async connect() { if (!connected) { await request({ type: "ready", upstreamVersion, pluginVersion: CANVAS_BRIDGE.pluginVersion }); connected = true; } },
    dispose() { window.removeEventListener("message", listener); for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("插件连接已关闭")); } pending.clear(); connected = false; },
  };
}
