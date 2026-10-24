"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Database, FileCode2, Play, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { AGENT_RESOURCES_VERSION, AgentResourceCallSchema, type AgentResourceKey, type AgentResourceWorkspace, type AgentResourceDefinition, type AgentResourceResult } from "@yummyai/contracts/ai/agent-resources";
import { useErpAccess } from "../identity/erp-access";
import { AgentResourceInputs } from "./agent-resource-inputs";
import { AgentResourceReadResult } from "./agent-resource-result";
import { AgentResourceRequestError, agentResourceReadDenied, agentResourceLabels, readAgentResourceWorkspace, readAgentResourceDefinition, callAgentResource } from "./agent-resource-client";
import "./agent-resource.css";

type Identity = { authority: string | null; owner: string | null };
const errorText = (error: unknown) => error instanceof AgentResourceRequestError ? error.message : "本次读取暂不可核对 请重新读取原资料";
export function AgentResourceBrowser() {
  const access = useErpAccess(), identity = useRef<Identity>({ authority: access.authority, owner: access.preferenceScope }); identity.current = { authority: access.authority, owner: access.preferenceScope };
  if (!access.authority || !access.preferenceScope) return <section className="agent-resource-browser" aria-label="业务资源读取"><h2><Database size={17} />业务资源读取</h2><p role="status">正在核对本人身份 暂不加载原业务资料</p></section>;
  return <ResourceBrowserContent key={access.authority + ":" + access.preferenceScope} identity={identity} />;
}
function ResourceBrowserContent({ identity }: { identity: RefObject<Identity> }) {
  const access = useErpAccess(), authority = access.authority!, owner = access.preferenceScope!;
  const alive = useRef(true), blocked = useRef(false), purged = useRef(false), workspaceSequence = useRef(0), definitionSequence = useRef(0), readSequence = useRef(0), lock = useRef(false);
  const workspaceController = useRef<AbortController | null>(null), definitionController = useRef<AbortController | null>(null), readController = useRef<AbortController | null>(null);
  const [workspace, setWorkspace] = useState<AgentResourceWorkspace | null>(null), [workspaceReading, setWorkspaceReading] = useState(false), [workspaceError, setWorkspaceError] = useState("");
  const [tool, setTool] = useState<AgentResourceKey>("research.evidence"), [search, setSearch] = useState(""), [definition, setDefinition] = useState<AgentResourceDefinition | null>(null), [definitionReading, setDefinitionReading] = useState(false), [definitionError, setDefinitionError] = useState("");
  const [input, setInput] = useState<unknown | null>(null), [result, setResult] = useState<{ key: string; value: AgentResourceResult } | null>(null), [reading, setReading] = useState(false), [readError, setReadError] = useState(""), [denied, setDenied] = useState(false), [cleared, setCleared] = useState(false);
  const key = canonicalJson({ tool, definition: definition?.definitionChecksum ?? null, input }), current = useRef({ authority, owner, key }); current.current = { authority: access.authority ?? "", owner: access.preferenceScope ?? "", key };
  const valid = useCallback(() => alive.current && !blocked.current && !purged.current && identity.current.authority === authority && identity.current.owner === owner && current.current.authority === authority && current.current.owner === owner, [authority, owner, identity]);
  const clearRead = useCallback(() => { readSequence.current++; readController.current?.abort(); lock.current = false; setReading(false); setResult(null); setReadError(""); }, []);
  const clearPrivate = useCallback(() => {
    workspaceSequence.current++; definitionSequence.current++; workspaceController.current?.abort(); definitionController.current?.abort(); clearRead();
    setWorkspace(null); setDefinition(null); setInput(null); setSearch(""); setWorkspaceReading(false); setDefinitionReading(false); setWorkspaceError(""); setDefinitionError("");
  }, [clearRead]);
  const deny = useCallback(() => { blocked.current = true; clearPrivate(); setDenied(true); window.dispatchEvent(new Event("focus")); }, [clearPrivate]);
  useLayoutEffect(() => {
    alive.current = true;
    const clear = () => { purged.current = true; clearPrivate(); setCleared(true); };
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, clear);
    return () => { alive.current = false; workspaceSequence.current++; definitionSequence.current++; readSequence.current++; workspaceController.current?.abort(); definitionController.current?.abort(); readController.current?.abort(); window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); };
  }, [clearPrivate]);
  const reloadWorkspace = useCallback(async () => {
    if (!valid()) return; clearPrivate(); const sequence = ++workspaceSequence.current, abort = new AbortController(); workspaceController.current = abort; setWorkspaceReading(true);
    try { const value = await readAgentResourceWorkspace(authority, abort.signal); if (valid() && sequence === workspaceSequence.current && !abort.signal.aborted) setWorkspace(value); }
    catch (error) { if (valid() && sequence === workspaceSequence.current && !abort.signal.aborted) { if (agentResourceReadDenied(error)) deny(); else setWorkspaceError(errorText(error)); } }
    finally { if (valid() && sequence === workspaceSequence.current) setWorkspaceReading(false); }
  }, [authority, valid, clearPrivate, deny]);
  useEffect(() => { void reloadWorkspace(); }, [reloadWorkspace]);
  const capability = workspace?.tools.find(value => value.key === tool);
  const reloadDefinition = useCallback(async () => {
    if (!workspace || !workspace.tools.find(value => value.key === tool)?.available || !valid()) return;
    definitionSequence.current++; definitionController.current?.abort(); clearRead(); setInput(null); setDefinition(null); setDefinitionReading(true); setDefinitionError("");
    const sequence = definitionSequence.current, abort = new AbortController(); definitionController.current = abort;
    try { const value = await readAgentResourceDefinition(tool, authority, abort.signal); if (valid() && sequence === definitionSequence.current && !abort.signal.aborted) setDefinition(value); }
    catch (error) { if (valid() && sequence === definitionSequence.current && !abort.signal.aborted) { if (agentResourceReadDenied(error)) deny(); else setDefinitionError(errorText(error)); } }
    finally { if (valid() && sequence === definitionSequence.current) setDefinitionReading(false); }
  }, [workspace, tool, authority, valid, clearRead, deny]);
  useEffect(() => { void reloadDefinition(); return () => { definitionSequence.current++; definitionController.current?.abort(); }; }, [reloadDefinition]);
  const changeInput = useCallback((value: unknown | null) => { clearRead(); setInput(value); }, [clearRead]);
  function select(value: AgentResourceKey) {
    if (value === tool) return; definitionSequence.current++; definitionController.current?.abort(); clearRead(); setInput(null); setDefinition(null); setDefinitionReading(false); setDefinitionError(""); setTool(value);
  }
  async function read() {
    if (lock.current || !valid() || !workspace || !definition?.available || !capability?.available || input === null) return;
    const parsed = AgentResourceCallSchema.safeParse({ version: AGENT_RESOURCES_VERSION, executionContract: workspace.executionContract, definitionChecksum: definition.definitionChecksum, tool, input });
    if (!parsed.success) { setReadError("所选原对象的严格输入不完整 请重新选择真实候选"); return; }
    const readKey = key, sequence = ++readSequence.current, abort = new AbortController(); readController.current?.abort(); readController.current = abort; lock.current = true; setReading(true); setReadError(""); setResult(null);
    try { const value = await callAgentResource(parsed.data, authority, abort.signal); if (valid() && sequence === readSequence.current && current.current.key === readKey && !abort.signal.aborted) setResult({ key: readKey, value }); }
    catch (error) { if (valid() && sequence === readSequence.current && current.current.key === readKey && !abort.signal.aborted) { if (agentResourceReadDenied(error)) deny(); else setReadError(errorText(error)); } }
    finally { if (sequence === readSequence.current) { lock.current = false; if (valid()) setReading(false); } }
  }
  const shown = valid() && result?.key === key ? result.value : null, selectedDefinition = definition?.tool === tool ? definition : null;
  const choices = workspace?.tools.filter(value => (value.label + " " + value.key + " " + value.owner).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) ?? [];
  if (cleared) return <section className="agent-resource-browser" aria-label="业务资源读取"><h2>业务资源读取</h2><p role="status">当前本人会话已清除 原候选与读取结果已隐藏</p></section>;
  return <section className="agent-resource-browser" aria-label="业务资源读取"><header className="ar-heading"><div><h2><Database size={17} />业务资源读取</h2><p className="ar-muted">独立版本 通过原业务拥有者只读事实 不改旧五工具 原生任务及知识 画布或无人设计入口</p></div><button type="button" disabled={workspaceReading} onClick={() => { blocked.current = false; setDenied(false); void reloadWorkspace(); }}><RefreshCw size={14} />重新核对资源读取权限</button></header>
    <p className="ar-notice"><ShieldCheck size={14} />本面板只读取所选对象 不派发模型 不准备或执行业务 新资源不自动加入旧任务历史或原模型固定范围</p>
    {workspaceReading && <p role="status">正在读取当前可用业务资源</p>}{workspaceError && <p className="ar-error" role="alert">{workspaceError}</p>}{denied && <p className="ar-error" role="status">当前对象访问权限或身份已变化 私有候选 版本输入与结果已清除 请重新核对</p>}
    {workspace && valid() && <div className="ar-layout"><aside className="ar-catalog" aria-label="业务资源目录"><label><span><Search size={13} />搜索资源能力</span><input aria-label="搜索资源能力" value={search} onChange={event => setSearch(event.target.value)} /></label><ul>{choices.map(value => <li key={value.key}><button type="button" aria-pressed={value.key === tool} onClick={() => select(value.key)}><strong>{value.label}</strong><span>{value.owner} · {value.available ? "当前可读取" : "当前不可读取"}</span><code>{value.key}</code></button></li>)}</ul>{!choices.length && <p>没有匹配的能力名称 不代表原业务没有数据</p>}</aside><div className="ar-selected"><header><h3>{capability?.label ?? agentResourceLabels[tool]}</h3><button type="button" disabled={definitionReading || !capability?.available} onClick={() => void reloadDefinition()}><RefreshCw size={14} />重新读取所选资源定义</button></header>
      {!capability?.available && <p className="ar-notice">当前不能使用此读取 · {capability?.blockReason ?? "请核对原业务权限"}</p>}{definitionReading && <p role="status">正在按需读取所选严格定义</p>}{definitionError && <p className="ar-error" role="alert">{definitionError}</p>}
      {selectedDefinition && <><AgentResourceDefinitionView definition={selectedDefinition} />{selectedDefinition.available && capability?.available && <><AgentResourceInputs key={tool + ":" + selectedDefinition.definitionChecksum} tool={tool} authority={authority} enabled={true} result={shown} onChange={changeInput} onDenied={deny} /><button type="button" className="ar-primary" disabled={reading || input === null} onClick={() => void read()}><Play size={14} />读取所选原资料</button></>}</>}
      {reading && <p role="status">正在读取固定对象与版本 不派发模型或写入业务</p>}{readError && <p className="ar-error" role="alert">{readError}</p>}{shown && <AgentResourceReadResult key={shown.callId} result={shown} />}
    </div></div>}
  </section>;
}
export function AgentResourceDefinitionView({ definition }: { definition: AgentResourceDefinition }) {
  return <section className="ar-definition" aria-label="所选业务资源定义"><h4><FileCode2 size={15} />所选严格定义 · 原生只读</h4><p className="ar-muted">原拥有者 {definition.owner} · {definition.execution}</p><ul>{definition.limitations.map((value, index) => <li key={index}>{value}</li>)}</ul>
    {!definition.available && <p className="ar-notice">当前不可用 · {definition.blockReason ?? "请核对原权限"}</p>}
    <details><summary>原输入完整 schema</summary><pre tabIndex={0}>{JSON.stringify(definition.inputSchema, null, 2)}</pre></details><details><summary>原返回完整 schema</summary><pre tabIndex={0}>{JSON.stringify(definition.outputSchema, null, 2)}</pre></details><details><summary>固定定义校验值</summary><code>{definition.definitionChecksum}</code></details>
  </section>;
}
