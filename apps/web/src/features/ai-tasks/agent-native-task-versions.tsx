"use client";
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useSearchParams } from "next/navigation";
import { Layers3 } from "lucide-react";
import { z } from "zod";
import { AGENT_NATIVE_CLEAR_EVENT } from "@yummyai/contracts/ai/agent-native";
import { useErpAccess } from "../identity/erp-access";
import { useOwnedViewTransition } from "../navigation/use-owned-view-transition";
import { AgentNativeWorkbench } from "./agent-native-workbench";
import { AgentNativeV2Workbench } from "./agent-native-v2-workbench";
import { AgentNativeV3Workbench } from "./agent-native-v3-workbench";
import { AgentNativeV4Workbench } from "./agent-native-v4-workbench";
import { nativeTaskV2Adapter, nativeTaskV3Adapter, nativeTaskV4Adapter } from "./agent-native-task-adapter";
import "./agent-native-task-frame.css";

const versions = [
  { id: "v4", label: "v4 履约建议与补项", query: nativeTaskV4Adapter.urlKey },
  { id: "v3", label: "v3 含履约读取", query: nativeTaskV3Adapter.urlKey },
  { id: "v2", label: "v2 历史任务", query: nativeTaskV2Adapter.urlKey },
  { id: "v1", label: "v1 历史任务", query: "agentNative" },
] as const;
type Version = typeof versions[number]["id"];
export function AgentNativeTaskVersions() {
  const access = useErpAccess();
  return <TaskVersions key={JSON.stringify([access.preferenceScope, access.authority])} />;
}
function TaskVersions() {
  const params = useSearchParams(), id = useId(), transition = useOwnedViewTransition();
  const linked = versions.filter(version => params.getAll(version.query).length === 1 && z.uuidv7().safeParse(params.get(version.query)).success);
  const signature = JSON.stringify(versions.map(version => params.getAll(version.query))), defaultVersion = linked[0]?.id ?? "v4";
  const [choice, setChoice] = useState<{ signature: string; version: Version } | null>(null), [cleared, setCleared] = useState(false);
  const selected = choice?.signature === signature ? choice.version : defaultVersion;
  const current = useRef(signature), alive = useRef(true), purged = useRef(false), generation = useRef(0);
  const pending = useRef<{ signature: string; version: Version } | null>(null), buttons = useRef<Array<HTMLButtonElement | null>>([]);
  current.current = signature;
  useLayoutEffect(() => {
    alive.current = true;
    const clear = () => { purged.current = true; generation.current++; pending.current = null; transition.cancel(); setCleared(true); };
    const events = [AGENT_NATIVE_CLEAR_EVENT, nativeTaskV2Adapter.clearEvent, nativeTaskV3Adapter.clearEvent, nativeTaskV4Adapter.clearEvent];
    for (const event of events) window.addEventListener(event, clear);
    return () => { alive.current = false; generation.current++; transition.cancel(); for (const event of events) window.removeEventListener(event, clear); };
  }, [transition]);
  useLayoutEffect(() => { generation.current++; pending.current = null; transition.cancel(); }, [signature, transition]);
  function select(version: Version) {
    if (!alive.current || purged.current || (pending.current?.signature === signature ? pending.current.version : selected) === version) return;
    transition.cancel(); const token = ++generation.current; pending.current = { signature, version };
    transition.change(() => {
      if (!alive.current || purged.current || token !== generation.current || current.current !== signature) return;
      pending.current = null; setChoice({ signature, version });
    });
  }
  function keyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const target = event.key === "ArrowRight" ? (index + 1) % versions.length : event.key === "ArrowLeft" ? (index + versions.length - 1) % versions.length : event.key === "Home" ? 0 : event.key === "End" ? versions.length - 1 : null;
    if (target === null || purged.current) return;
    event.preventDefault(); buttons.current[target]?.focus(); select(versions[target]!.id);
  }
  return <section className="an-task-versions" aria-label="原生模型任务版本">
    <header><h2><Layers3 size={17} />原生模型任务</h2><p>开发中的任务能力按原版本核对 不转换旧请求或执行凭据</p></header>
    <div className="an-task-version-tabs" role="tablist" aria-label="原生任务版本">{versions.map((version, index) => <button type="button" role="tab" key={version.id} ref={element => { buttons.current[index] = element; }}
      id={id + "-" + version.id} aria-controls={id + "-panel"} aria-selected={selected === version.id} tabIndex={selected === version.id ? 0 : -1} disabled={cleared}
      onClick={() => select(version.id)} onKeyDown={event => keyDown(event, index)}>{version.label}</button>)}</div>
    <p className="an-task-version-note">只加载当前版本 切换不会停止原任务或发起模型调用 填写不跨版本保留 原请求标识仍由各版本恢复</p>
    {linked.length > 1 && <p className="an-task-version-note" role="status">链接包含多个版本的任务引用 默认按 v4 v3 v2 v1 顺序显示 可明确切换核对 各原 ID 保持不变</p>}
    {cleared ? <p role="status">当前本人会话已清除 原任务界面已关闭 请重新核对身份后读取</p> : <div key={selected} className="an-task-version-panel" role="tabpanel" id={id + "-panel"} aria-labelledby={id + "-" + selected}>
      {selected === "v4" ? <AgentNativeV4Workbench /> : selected === "v3" ? <AgentNativeV3Workbench /> : selected === "v2" ? <AgentNativeV2Workbench /> : <AgentNativeWorkbench />}
    </div>}
  </section>;
}
