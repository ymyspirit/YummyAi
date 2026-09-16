"use client";
import { useEffect, useRef, useState } from "react";
import { ConfigurationRpcSchema } from "@yummyai/contracts/ai/model-configuration";
import { studioApi } from "./studio-api";

export function ModelConfigurationFrame({ runtimeUrl, onState, onSaved, onView }: { runtimeUrl: string; onState: (value: { dirty: boolean; busy: boolean }) => void; onSaved: () => void; onView: (tab: "channels" | "models" | "defaults") => void }) {
  const frame = useRef<HTMLIFrameElement>(null), stateCallback = useRef(onState), savedCallback = useRef(onSaved), viewCallback = useRef(onView);
  stateCallback.current = onState; savedCallback.current = onSaved; viewCallback.current = onView;
  const [source, setSource] = useState(""), [loaded, setLoaded] = useState(false), [error, setError] = useState(""), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true, drawerDirty = false, preferencesDirty = false, selectionDirty = false, drawerBusy = false, preferencesBusy = false, selectionBusy = false;
    const requests = new Set<string>(), blockingRequests = new Set<string>(), controller = new AbortController(), channel = crypto.randomUUID();
    const emitState = () => stateCallback.current({ dirty: drawerDirty || preferencesDirty || selectionDirty, busy: drawerBusy || preferencesBusy || selectionBusy || blockingRequests.size > 0 });
    const send = (payload: Record<string, unknown>) => frame.current?.contentWindow?.postMessage({ ...payload, channel }, runtimeUrl);
    const url = new URL(runtimeUrl); url.searchParams.set("surface", "settings"); url.searchParams.set("parentOrigin", location.origin); url.searchParams.set("channel", channel);
    setSource(url.href); setLoaded(false); setError("");
    const deadline = setTimeout(() => { if (live) setError("配置界面暂时未能连接，请重试"); }, 25_000);
    const handler = async (event: MessageEvent) => {
      if (!live || event.source !== frame.current?.contentWindow || event.origin !== runtimeUrl || event.data?.channel !== channel) return;
      const data = event.data;
      if (data.type === "studio.ready") send({ type: "studio.init", tool: "settings", scope: "unassigned", theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light" });
      if (data.type === "studio.loaded") { clearTimeout(deadline); setLoaded(true); setError(""); }
      if (data.type === "settings.draft") { drawerDirty = data.dirty === true; drawerBusy = data.busy === true; emitState(); }
      if (data.type === "settings.preferences") { preferencesDirty = data.dirty === true; preferencesBusy = data.busy === true; emitState(); }
      if (data.type === "settings.selection") { selectionDirty = data.dirty === true; selectionBusy = data.busy === true; emitState(); }
      if (data.type === "settings.saved") savedCallback.current();
      if (data.type === "settings.view" && ["channels", "models", "defaults"].includes(data.tab)) viewCallback.current(data.tab);
      if (data.type === "studio.error") setError(typeof data.error === "string" ? data.error.slice(0, 200) : "配置界面读取失败");
      if (data.type !== "studio.request" || typeof data.id !== "string" || data.id.length > 80 || requests.has(data.id)) return;
      const parsed = ConfigurationRpcSchema.safeParse(data.request);
      if (!parsed.success) { send({ type: "studio.response", id: data.id, error: "模型配置请求不受支持" }); return; }
      requests.add(data.id);
      // Reading configuration can be cancelled on navigation; saves and other operations stay guarded.
      if (parsed.data.operation !== "configuration.get") blockingRequests.add(data.id);
      emitState();
      try {
        const result = await studioApi("configuration", parsed.data, "POST", AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]));
        if (live) send({ type: "studio.response", id: data.id, result });
      } catch (cause) { if (live) send({ type: "studio.response", id: data.id, error: cause instanceof Error ? cause.message : "配置请求失败，请重试" }); }
      finally { requests.delete(data.id); blockingRequests.delete(data.id); if (live) emitState(); }
    };
    const observer = new MutationObserver(() => send({ type: "studio.theme", theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light" }));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const refresh = () => send({ type: "studio.refresh" });
    window.addEventListener("message", handler); window.addEventListener("yummyai.models.changed", refresh);
    return () => { live = false; controller.abort(); clearTimeout(deadline); observer.disconnect(); window.removeEventListener("message", handler); window.removeEventListener("yummyai.models.changed", refresh); stateCallback.current({ dirty: false, busy: false }); };
  }, [runtimeUrl, attempt]);
  return <div className="studio-configuration-frame">
    {!loaded && !error && <p role="status">正在连接模型配置…</p>}
    {error && <p role="alert" className="studio-alert">{error}<button type="button" onClick={() => setAttempt(value => value + 1)}>重新连接配置</button></p>}
    {source && <iframe ref={frame} src={source} title="无限画布模型配置" sandbox="allow-scripts allow-same-origin allow-downloads allow-modals" />}
  </div>;
}
