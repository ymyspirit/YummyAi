import { CANVAS_BRIDGE, CanvasRequestSchema, canvasVersionSupported, type CanvasResponse } from "@yummyai/contracts/pod/canvas-bridge";

export async function canvasApi(path: string, input?: unknown) {
  const response = await fetch(`/api/canvas-bridge/${path}`, { method: input === undefined ? "GET" : "POST", cache: "no-store", headers: input === undefined ? undefined : { "content-type": "application/json" }, body: input === undefined ? undefined : JSON.stringify(input) });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "ERP 请求失败");
  return payload;
}

export function connectCanvas(options: {
  popup: Window; origin: string; channelId: string; briefId: string;
  onStatus: (message: string) => void; onResult: () => void;
}) {
  let ready = false, disposed = false, inFlight = 0;
  const expiresAt = Date.now() + 60 * 60 * 1000;
  const listener = async (event: MessageEvent) => {
    if (disposed || event.source !== options.popup || event.origin !== options.origin) return;
    const parsed = CanvasRequestSchema.safeParse(event.data);
    if (!parsed.success || parsed.data.channelId !== options.channelId) return;
    const request = parsed.data;
    const reply = (value: Pick<CanvasResponse, "ok" | "payload" | "error">) => {
      if (disposed) return;
      options.popup.postMessage({ channel: "yummyai-canvas", protocolVersion: 1, channelId: options.channelId, requestId: request.requestId, type: "response", ...value } satisfies CanvasResponse, options.origin);
    };
    if (Date.now() > expiresAt) { options.onStatus("连接已到期，请重新打开画布"); reply({ ok: false, error: "连接已到期，请从 ERP 重新打开画布" }); return; }
    if (inFlight >= 3) { reply({ ok: false, error: "正在处理上一个请求，请稍后重试" }); return; }
    inFlight++;
    try {
      if (request.type === "ready") {
        if (!canvasVersionSupported(request.upstreamVersion, request.pluginVersion)) throw new Error(`画布或插件版本尚未验证，请使用 ${CANVAS_BRIDGE.upstreamVersion} 和插件 ${CANVAS_BRIDGE.pluginVersion}`);
        ready = true; options.onStatus("已连接。在画布中添加「ERP 创作任务」节点并读取需求。");
        reply({ ok: true, payload: { briefId: options.briefId } }); return;
      }
      if (!ready) throw new Error("请先连接经过验证的画布插件");
      const root = `briefs/${options.briefId}`;
      if (request.type === "brief.read") reply({ ok: true, payload: await canvasApi(root) });
      if (request.type === "asset.read") reply({ ok: true, payload: await canvasApi(`${root}/assets/${request.assetId}`) });
      if (request.type === "result.submit") {
        options.onStatus("正在保存画布结果…");
        const result = await canvasApi(`${root}/results`, request.input);
        reply({ ok: true, payload: result });
        options.onStatus("结果已保存，等待在 ERP 审核。"); options.onResult();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "画布请求失败";
      options.onStatus(message); reply({ ok: false, error: message });
    } finally { inFlight--; }
  };
  window.addEventListener("message", listener);
  return () => { disposed = true; window.removeEventListener("message", listener); };
}
