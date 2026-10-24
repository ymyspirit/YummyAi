"use client";
import { useEffect, useRef, useState } from "react";
import { ConfigurationRpcSchema } from "@yummyai/contracts/ai/model-configuration";
import { Permission } from "@yummyai/authz/permissions";
import { studioApi, studioScopeUnavailable, useStudioAccessFence, type StudioRequestContext } from "./studio-api";

export function ModelConfigurationFrame({ runtimeUrl, onState, onSaved, onView }: { runtimeUrl: string; onState: (value: { dirty: boolean; busy: boolean }) => void; onSaved: () => void; onView: (tab: "channels" | "models" | "defaults") => void }) {
  const access = useStudioAccessFence("configuration"), { capture } = access;
  const canConfigure = access.can(Permission.ModelConfigure);
  const frame = useRef<HTMLIFrameElement>(null), stateCallback = useRef(onState), savedCallback = useRef(onSaved), viewCallback = useRef(onView);
  stateCallback.current = onState; savedCallback.current = onSaved; viewCallback.current = onView;
  const [source, setSource] = useState(""), [loaded, setLoaded] = useState(false), [error, setError] = useState(""), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!access.available || !canConfigure) return;
    let live = true, drawerDirty = false, preferencesDirty = false, selectionDirty = false, drawerBusy = false, preferencesBusy = false, selectionBusy = false;
    const requests = new Set<string>(), blockingRequests = new Set<string>(), controller = new AbortController(), channel = crypto.randomUUID();
    let context: StudioRequestContext;
    try { context = capture(controller.signal); } catch { controller.abort(); return; }
    const current = () => live && !context.signal.aborted && context.isCurrent();
    const emitState = () => stateCallback.current({ dirty: drawerDirty || preferencesDirty || selectionDirty, busy: drawerBusy || preferencesBusy || selectionBusy || blockingRequests.size > 0 });
    const send = (payload: Record<string, unknown>) => { if (current()) frame.current?.contentWindow?.postMessage({ ...payload, channel }, runtimeUrl); };
    const url = new URL(runtimeUrl); url.searchParams.set("surface", "settings"); url.searchParams.set("parentOrigin", location.origin); url.searchParams.set("channel", channel);
    setSource(url.href); setLoaded(false); setError("");
    const deadline = setTimeout(() => { if (current()) setError("配置界面暂时未能连接，请重试"); }, 25_000);
    const handler = async (event: MessageEvent) => {
      if (!current() || event.source !== frame.current?.contentWindow || event.origin !== runtimeUrl || event.data?.channel !== channel) return;
      const data = event.data;
      if (data.type === "studio.ready") send({ type: "studio.init", tool: "settings", scope: "unassigned", theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light" });
      if (data.type === "studio.loaded") { clearTimeout(deadline); setLoaded(true); setError(""); }
      if (data.type === "settings.draft") { drawerDirty = data.dirty === true; drawerBusy = data.busy === true; emitState(); }
      if (data.type === "settings.preferences") { preferencesDirty = data.dirty === true; preferencesBusy = data.busy === true; emitState(); }
      if (data.type === "settings.selection") { selectionDirty = data.dirty === true; selectionBusy = data.busy === true; emitState(); }
      if (data.type === "settings.saved") savedCallback.current();
      if (data.type === "settings.view" && ["channels", "models", "defaults"].includes(data.tab)) viewCallback.current(data.tab);
      if (data.type === "studio.error") setError("配置界面读取未完成 已填写的内容保留 请重新核对原配置");
      if (data.type !== "studio.request" || typeof data.id !== "string" || data.id.length > 80 || requests.has(data.id)) return;
      const parsed = ConfigurationRpcSchema.safeParse(data.request);
      if (!parsed.success) { send({ type: "studio.response", id: data.id, error: "模型配置请求不受支持" }); return; }
      requests.add(data.id);
      // Reading configuration can be cancelled on navigation; saves and other operations stay guarded.
      if (parsed.data.operation !== "configuration.get") blockingRequests.add(data.id);
      emitState();
      try {
        const result = await studioApi("configuration", parsed.data, "POST", AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]), context);
        if (current()) send({ type: "studio.response", id: data.id, result });
      } catch (cause) {
        if (current()) {
          if (studioScopeUnavailable(cause)) { live = false; controller.abort(); setSource(""); setLoaded(false); setError("当前模型配置权限已变化 已清除配置界面与填写 请重新核对本人权限"); stateCallback.current({ dirty: false, busy: false }); }
          else send({ type: "studio.response", id: data.id, error: parsed.data.operation === "configuration.get"
            ? "模型配置读取失败 请重新读取原配置"
            : "配置结果尚未核对 请读取原配置确认 未自动重试" });
        }
      }
      finally { requests.delete(data.id); blockingRequests.delete(data.id); if (current()) emitState(); }
    };
    const observer = new MutationObserver(() => send({ type: "studio.theme", theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light" }));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const refresh = () => send({ type: "studio.refresh" });
    window.addEventListener("message", handler); window.addEventListener("yummyai.models.changed", refresh);
    return () => { live = false; controller.abort(); clearTimeout(deadline); observer.disconnect(); window.removeEventListener("message", handler); window.removeEventListener("yummyai.models.changed", refresh); stateCallback.current({ dirty: false, busy: false }); };
  }, [runtimeUrl, attempt, capture, access.available, canConfigure]);
  if (!access.available || !canConfigure) return <p role="status" className="studio-alert">当前本人身份或模型配置权限尚未核对 配置界面与填写已隐藏</p>;
  return <div className="studio-configuration-frame">
    {!loaded && !error && <p role="status">正在连接模型配置…</p>}
    {error && <p role="alert" className="studio-alert">{error}<button type="button" onClick={() => setAttempt(value => value + 1)}>重新连接配置</button></p>}
    {source && <iframe ref={frame} src={source} title="无限画布模型配置" sandbox="allow-scripts allow-same-origin allow-downloads allow-modals" />}
  </div>;
}
