"use client";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import Link from "next/link";
import { BookOpen, ChevronLeft, ChevronRight, Database, FileCode2, ListFilter, Play, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import {
  AGENT_TOOLS_VERSION, AgentToolCallSchema, type AgentToolDefinition, type AgentToolResult,
  type AgentToolSelection, type AgentToolWorkspace,
} from "@yummyai/contracts/ai/agent-tools";
import { AgentPlanCommandKeySchema } from "@yummyai/contracts/ai/agent-plan";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { KNOWLEDGE_TOPICS, type KnowledgeSearch } from "@yummyai/contracts/knowledge";
import { useErpAccess } from "../identity/erp-access";
import { AgentToolObjectPicker, type AgentToolCreativeScope } from "./agent-tool-object-picker";
import { AgentToolReadResult } from "./agent-tool-read-result";
import { KnowledgeProductPicker } from "../knowledge/knowledge-product-picker";
import {
  AgentToolRequestError, agentToolReadDenied, agentToolSelectionKey, appendAgentToolPage,
  callAgentTool, readAgentToolDefinition, readAgentToolWorkspace,
} from "./agent-tool-client";
import "./agent-tool-browser.css";

type Draft = { query: string; topic: KnowledgeSearch["topic"]; platform: KnowledgeSearch["platform"]; market: string; spuId: string;
  creativeScope: AgentToolCreativeScope; ownerId: string; factoryId: string; from: string; days: string; pageSize: string; status: "open" | "resolved" | "all" };
const blank = (): Draft => ({ query: "", topic: "all", platform: "all", market: "ALL", spuId: "", creativeScope: "design_batch", ownerId: "", factoryId: "", from: "", days: "14", pageSize: "25", status: "open" });
const domainNames: Record<string, string> = { procurement: "采购", incoming: "来料", production: "生产", finance: "财务", advertising: "广告" };
const failureText = (failure: unknown) => failure instanceof AgentToolRequestError ? failure.message : "本次读取暂时无法核对 请重新读取原资料";
type Identity = { authority: string | null; scope: string | null };
export function AgentToolBrowser() {
  const access = useErpAccess(), identity = useRef<Identity>({ authority: access.authority, scope: access.preferenceScope });
  identity.current = { authority: access.authority, scope: access.preferenceScope };
  if (!access.authority || !access.preferenceScope) return <section className="agent-tool-browser" aria-label="原生工具与命令目录"><h2><Database size={17} />原生工具与命令目录</h2><p role="status">正在核对当前本人身份 暂不读取业务资料</p></section>;
  return <AgentToolBrowserContent key={access.preferenceScope + ":" + access.authority} identity={identity} />;
}
function AgentToolBrowserContent({ identity }: { identity: RefObject<Identity> }) {
  const access = useErpAccess(), authority = access.authority!, owner = access.preferenceScope!, canRead = access.can(Permission.WorkflowRead);
  const alive = useRef(true), blocked = useRef(false), purged = useRef(false), current = useRef({ authority, owner, canRead, query: "" });
  const workspaceSequence = useRef(0), definitionSequence = useRef(0), readSequence = useRef(0), readLock = useRef(false);
  const workspaceController = useRef<AbortController | null>(null), definitionController = useRef<AbortController | null>(null), readController = useRef<AbortController | null>(null);
  const [workspace, setWorkspace] = useState<AgentToolWorkspace | null>(null), [workspaceReading, setWorkspaceReading] = useState(false), [workspaceError, setWorkspaceError] = useState("");
  const [selection, setSelection] = useState<AgentToolSelection>({ kind: "read", tool: "knowledge.search" }), [catalogKind, setCatalogKind] = useState<"read" | "command">("read"), [search, setSearch] = useState("");
  const [definition, setDefinition] = useState<AgentToolDefinition | null>(null), [definitionReading, setDefinitionReading] = useState(false), [definitionError, setDefinitionError] = useState("");
  const [draft, setDraft] = useState<Draft>(blank), [collection, setCollection] = useState<{ query: string; pages: AgentToolResult[]; index: number } | null>(null);
  const [reading, setReading] = useState(false), [readError, setReadError] = useState(""), [denied, setDenied] = useState(false), [cleared, setCleared] = useState(false);
  const selectionKey = agentToolSelectionKey(selection), inputKey = canonicalJson({ selection, draft });
  current.current = { authority: access.authority ?? "", owner: access.preferenceScope ?? "", canRead, query: inputKey };
  const valid = useCallback(() => alive.current && !purged.current && !blocked.current && identity.current.authority === authority && identity.current.scope === owner && current.current.authority === authority && current.current.owner === owner && current.current.canRead, [authority, owner, identity]);
  const resetRead = useCallback(() => {
    readSequence.current++; readController.current?.abort(); readLock.current = false;
    setReading(false); setCollection(null); setReadError("");
  }, []);
  const clearPrivate = useCallback(() => {
    workspaceSequence.current++; definitionSequence.current++; readSequence.current++;
    workspaceController.current?.abort(); definitionController.current?.abort(); readController.current?.abort(); readLock.current = false;
    setWorkspace(null); setDefinition(null); setCollection(null); setDraft(blank()); setSearch("");
    setWorkspaceReading(false); setDefinitionReading(false); setReading(false); setWorkspaceError(""); setDefinitionError(""); setReadError("");
  }, []);
  const deny = useCallback(() => { blocked.current = true; clearPrivate(); setDenied(true); window.dispatchEvent(new Event("focus")); }, [clearPrivate]);
  useEffect(() => {
    alive.current = true;
    const clear = () => { purged.current = true; clearPrivate(); setCleared(true); };
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, clear);
    return () => { alive.current = false; workspaceSequence.current++; definitionSequence.current++; readSequence.current++; workspaceController.current?.abort(); definitionController.current?.abort(); readController.current?.abort(); window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); };
  }, [clearPrivate]);
  const reloadWorkspace = useCallback(async () => {
    if (!valid()) return;
    const token = ++workspaceSequence.current, abort = new AbortController(); workspaceController.current?.abort(); workspaceController.current = abort;
    definitionSequence.current++; definitionController.current?.abort(); setDefinition(null); setDefinitionError(""); setDefinitionReading(false); resetRead();
    setWorkspace(null); setWorkspaceReading(true); setWorkspaceError("");
    try { const value = await readAgentToolWorkspace(authority, abort.signal); if (valid() && !abort.signal.aborted && token === workspaceSequence.current) setWorkspace(value); }
    catch (failure) { if (valid() && !abort.signal.aborted && token === workspaceSequence.current) { if (agentToolReadDenied(failure)) deny(); else setWorkspaceError(failureText(failure)); } }
    finally { if (valid() && token === workspaceSequence.current) setWorkspaceReading(false); }
  }, [authority, valid, deny, resetRead]);
  useEffect(() => { void reloadWorkspace(); }, [reloadWorkspace]);
  const reloadDefinition = useCallback(async () => {
    if (!workspace || !valid()) return;
    const token = ++definitionSequence.current, abort = new AbortController(); definitionController.current?.abort(); definitionController.current = abort;
    setDefinition(null); setDefinitionReading(true); setDefinitionError(""); resetRead();
    try { const value = await readAgentToolDefinition(selection, authority, abort.signal);
      if (valid() && !abort.signal.aborted && token === definitionSequence.current) setDefinition(value);
    } catch (failure) { if (valid() && !abort.signal.aborted && token === definitionSequence.current) { if (agentToolReadDenied(failure)) deny(); else setDefinitionError(failureText(failure)); } }
    finally { if (valid() && token === definitionSequence.current) setDefinitionReading(false); }
  }, [workspace, selection, authority, valid, deny, resetRead]);
  useEffect(() => { void reloadDefinition(); return () => { definitionSequence.current++; definitionController.current?.abort(); }; }, [reloadDefinition]);
  const changeDraft = useCallback((patch: Partial<Draft>) => { resetRead(); setDraft(value => ({ ...value, ...patch })); }, [resetRead]);
  function select(value: AgentToolSelection) {
    if (agentToolSelectionKey(value) === selectionKey) return;
    definitionSequence.current++; definitionController.current?.abort(); resetRead(); setDefinition(null); setDefinitionError(""); setDraft(blank()); setSelection(value);
  }
  function switchCatalog(kind: "read" | "command") {
    setCatalogKind(kind); setSearch("");
    if (kind === selection.kind) return;
    if (kind === "read" && workspace?.tools[0]) select({ kind: "read", tool: workspace.tools[0].key });
    else if (kind === "command" && workspace?.commands[0]) {
      const value = AgentPlanCommandKeySchema.safeParse({ domain: workspace.commands[0].domain, kind: workspace.commands[0].kind });
      if (value.success) select({ kind: "command", command: value.data });
    }
  }
  const saved = collection?.query === inputKey ? collection : null, page = saved?.pages[saved.index], last = saved?.pages.at(-1);
  const selectedDefinition = definition && agentToolSelectionKey(definition.selection) === selectionKey ? definition : null;
  const capability = selection.kind === "read" ? workspace?.tools.find(tool => tool.key === selection.tool) : workspace?.commands.find(command => command.domain === selection.command.domain && command.kind === selection.command.kind);
  const locallyAllowed = selection.kind === "read" && (selection.tool === "orders.exceptions.page" || selection.tool === "factory.capacity") ? access.canTenant(Permission.OrderRead) :
    selection.kind === "read" && selection.tool === "inventory.balances.page" ? access.canTenant(Permission.InventoryRead) :
      selection.kind === "read" && selection.tool === "creative.history" ? access.can(Permission.DesignRead) : canRead;
  async function read(next = false) {
    if (!workspace || !selectedDefinition?.available || selection.kind !== "read" || !capability?.available || !locallyAllowed || !valid() || readLock.current || next && !last) return;
    const cursor = next && last && "nextCursor" in last.coverage ? last.coverage.nextCursor : null;
    if (next && !cursor) return;
    const input = selection.tool === "orders.exceptions.page" ? { pageSize: Number(draft.pageSize), status: draft.status, cursor } :
      selection.tool === "inventory.balances.page" ? { pageSize: Number(draft.pageSize), cursor } :
        selection.tool === "knowledge.search" ? { query: draft.query, topic: draft.topic, platform: draft.platform, market: draft.market, spuIds: draft.spuId ? [draft.spuId] : [] } :
          selection.tool === "creative.history" ? { scope: draft.creativeScope, ownerId: draft.ownerId, ...(cursor ? { after: cursor } : {}) } :
            { factoryId: draft.factoryId, query: { days: Number(draft.days), ...(draft.from ? { from: draft.from } : {}) } };
    const call = AgentToolCallSchema.safeParse({ version: AGENT_TOOLS_VERSION, executionContract: workspace.executionContract, definitionChecksum: selectedDefinition.definitionChecksum, tool: selection.tool, input });
    if (!call.success) { setReadError("请核对完整读取条件 并选择实际已读取的原业务对象"); return; }
    const key = inputKey, token = ++readSequence.current, abort = new AbortController(); readController.current?.abort(); readController.current = abort;
    readLock.current = true; setReading(true); setReadError(""); if (!next) setCollection(null);
    try {
      const value = await callAgentTool(call.data, authority, abort.signal);
      if (!valid() || abort.signal.aborted || token !== readSequence.current || current.current.query !== key) return;
      const pages = appendAgentToolPage(next ? saved?.pages ?? [] : [], value, call.data);
      setCollection({ query: key, pages, index: pages.length - 1 });
    } catch (failure) {
      if (valid() && !abort.signal.aborted && token === readSequence.current && current.current.query === key) {
        if (agentToolReadDenied(failure)) deny(); else { if (failure instanceof AgentToolRequestError && failure.code === "agent_collection_changed") setCollection(null); setReadError(failureText(failure)); }
      }
    } finally { if (token === readSequence.current) { readLock.current = false; if (valid()) setReading(false); } }
  }
  if (cleared || !canRead) return <section className="agent-tool-browser" aria-label="原生工具与命令目录"><h2><Database size={17} />原生工具与命令目录</h2><p role="status">{cleared ? "当前本人会话已清除 原工具资料和填写已隐藏" : "当前账号缺少工作流读取权限 原工具资料已隐藏"}</p></section>;
  if (denied) return <section className="agent-tool-browser" aria-label="原生工具与命令目录"><h2><Database size={17} />原生工具与命令目录</h2><p role="status">当前身份或读取范围已变化 原工具资料和填写已清除</p><button type="button" onClick={() => { if (purged.current || identity.current.authority !== authority || !current.current.canRead) return; blocked.current = false; setDenied(false); void reloadWorkspace(); }}><RefreshCw size={14} />重新核对工具权限</button></section>;
  const needle = search.trim().toLocaleLowerCase();
  const readChoices = workspace?.tools.filter(tool => (tool.label + " " + tool.key).toLocaleLowerCase().includes(needle)) ?? [];
  const commandChoices = workspace?.commands.filter(command => (command.label + " " + command.domain + " " + (domainNames[command.domain] ?? "") + " " + command.kind).toLocaleLowerCase().includes(needle)) ?? [];
  const selectedLabel = capability?.label ?? "所选原生工具";
  return <section className="agent-tool-browser" aria-label="原生工具与命令目录">
    <header className="atb-heading"><div><h2><Database size={17} aria-hidden="true" />原生工具与命令目录</h2><p className="atb-muted">五类原生读取尚未接入旧付费循环 MCP 尚未连接</p></div><button type="button" disabled={workspaceReading} onClick={() => void reloadWorkspace()}><RefreshCw size={14} />重新读取工具目录</button></header>
    <p className="atb-notice">选择一项再读取定义 原生读取不调用模型 命令目录仅供核对 原业务执行仍需单独人工确认 旧循环与业务计划协议保持原样</p>
    {workspaceReading && <p role="status">正在读取当前受权能力目录</p>}{workspaceError && <p role="alert" className="atb-error">{workspaceError}</p>}
    {workspace && <div className="atb-layout"><aside className="atb-catalog" aria-label="能力选择"><nav className="atb-actions" aria-label="目录类型"><button type="button" aria-pressed={catalogKind === "read"} onClick={() => switchCatalog("read")}><BookOpen size={14} />读取工具 {workspace.tools.length}</button><button type="button" aria-pressed={catalogKind === "command"} onClick={() => switchCatalog("command")}><FileCode2 size={14} />原命令定义 {workspace.commands.length}</button></nav>
      <label><span><Search size={13} aria-hidden="true" />搜索能力</span><input aria-label="搜索能力" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <ul className="atb-choice-list">{catalogKind === "read" ? readChoices.map(tool => <li key={tool.key}><button type="button" aria-pressed={selection.kind === "read" && selection.tool === tool.key} onClick={() => select({ kind: "read", tool: tool.key })}><strong>{tool.label}</strong><span>{tool.available ? "当前可读取" : "当前不可读取"}</span><code>{tool.key}</code></button></li>) : commandChoices.map(command => <li key={command.domain + "/" + command.kind}><button type="button" aria-pressed={selection.kind === "command" && selection.command.domain === command.domain && selection.command.kind === command.kind} onClick={() => {
        const parsed = AgentPlanCommandKeySchema.safeParse({ domain: command.domain, kind: command.kind }); if (parsed.success) select({ kind: "command", command: parsed.data });
      }}><strong>{command.label}</strong><span>{domainNames[command.domain]} · {command.available ? "原准备入口可用" : "当前不可准备"}</span><code>{command.kind}</code></button></li>)}</ul>
      {!(catalogKind === "read" ? readChoices.length : commandChoices.length) && <p className="atb-muted">没有符合搜索的已注册能力</p>}
      <p className="atb-muted">目录只含能力摘要 不会一次加载所有命令正文或 schema</p>
    </aside><div className="atb-selected" key={selectionKey}><header><h3><ListFilter size={16} aria-hidden="true" />{selectedLabel}</h3><button type="button" disabled={definitionReading} onClick={() => void reloadDefinition()}><RefreshCw size={14} />重新读取所选定义</button></header>
      {definitionReading && <p role="status">正在读取这一项严格定义</p>}{definitionError && <p role="alert" className="atb-error">{definitionError}</p>}
      {selectedDefinition && <><AgentToolDefinitionView definition={selectedDefinition} />
        {selection.kind === "read" && <form aria-label={selectedLabel + "读取条件"} onSubmit={event => { event.preventDefault(); void read(); }}><fieldset disabled={reading || !selectedDefinition.available || !locallyAllowed}>
          {selection.tool === "knowledge.search" ? <div className="atb-fields"><label className="atb-wide">知识检索词<input required maxLength={300} aria-label="知识检索词" value={draft.query} onChange={event => changeDraft({ query: event.target.value })} /></label>
            <label>知识主题<select aria-label="知识主题" value={draft.topic} onChange={event => changeDraft({ topic: event.target.value as Draft["topic"] })}><option value="all">全部主题</option>{Object.entries(KNOWLEDGE_TOPICS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
            <label>知识平台<select aria-label="知识平台" value={draft.platform} onChange={event => changeDraft({ platform: event.target.value as Draft["platform"] })}><option value="all">通用知识</option><option value="amazon">Amazon</option><option value="etsy">Etsy</option></select></label>
            <label>知识站点<input required pattern="ALL|[A-Z]{2}" aria-label="知识站点" value={draft.market} onChange={event => changeDraft({ market: event.target.value.toUpperCase() })} /></label>
            <KnowledgeProductPicker authority={authority} value={draft.spuId} enabled={selectedDefinition.available && locallyAllowed}
              disabled={reading} onChange={spuId => changeDraft({ spuId })} onDenied={deny} />
            <p className="atb-muted">通用知识仅匹配通用平台资料 ALL 仅匹配通用站点资料 不代表跨平台或跨站点全集</p></div> :
            selection.tool === "creative.history" ? <><label>创意执行范围<select aria-label="创意执行范围" value={draft.creativeScope} onChange={event => changeDraft({ creativeScope: event.target.value as AgentToolCreativeScope, ownerId: "" })}><option value="design_batch">批量设计</option><option value="inspection">PSD 模板检查</option><option value="mockup_batch">批量套图</option></select></label>
              <AgentToolObjectPicker key={draft.creativeScope} kind="creative" scope={draft.creativeScope} authority={authority} value={draft.ownerId} disabled={reading} enabled={selectedDefinition.available && locallyAllowed} onChange={ownerId => changeDraft({ ownerId })} onDenied={deny} /><p className="atb-muted">工作台生成任务请从原创作项目读取 此处不以项目 ID 代替生成任务 ID</p><Link href="/creative-designs/studio/image">打开原创作工作台</Link></> :
              selection.tool === "factory.capacity" ? <><AgentToolObjectPicker kind="factory" authority={authority} value={draft.factoryId} disabled={reading} enabled={selectedDefinition.available && locallyAllowed} onChange={factoryId => changeDraft({ factoryId })} onDenied={deny} /><div className="atb-fields"><label>工厂当地起始日期<input type="date" aria-label="工厂当地起始日期" value={draft.from} onChange={event => changeDraft({ from: event.target.value })} /></label><label>产能读取天数<input type="number" required min={1} max={31} step={1} aria-label="产能读取天数" value={draft.days} onChange={event => changeDraft({ days: event.target.value })} /></label></div><p className="atb-muted">日期留空由原工厂服务确定当前当地日 不按浏览器时区猜测 本次不预留产能</p></> :
                <div className="atb-fields">{selection.tool === "orders.exceptions.page" && <label>异常状态<select aria-label="异常状态" value={draft.status} onChange={event => changeDraft({ status: event.target.value as Draft["status"] })}><option value="open">待处理</option><option value="resolved">已解决</option><option value="all">全部</option></select></label>}<label>工具每页记录数<select aria-label="工具每页记录数" value={draft.pageSize} onChange={event => changeDraft({ pageSize: event.target.value })}>{[25, 50, 100].map(value => <option key={value} value={value}>{value}</option>)}</select></label><p className="atb-muted">读取当前受权原集合 不按首个已读页推算全量</p></div>}
          <button type="submit" className="atb-primary" disabled={reading || !selectedDefinition.available || !locallyAllowed || selection.tool === "creative.history" && !draft.ownerId || selection.tool === "factory.capacity" && !draft.factoryId}><Play size={14} aria-hidden="true" />读取{selectedLabel}</button>
        </fieldset></form>}
        {selection.kind === "command" && <p className="atb-notice"><ShieldCheck size={15} aria-hidden="true" />只浏览所选原命令定义 此处不准备或执行写入 请从原业务核对页交接后逐笔明确确认 <Link href="/ai-tasks">原命令确认仍在 AI 任务工作台</Link></p>}
      </>}
      {reading && <p role="status">正在读取原业务来源 未完成前不称全量</p>}{readError && <p className="atb-error" role="alert">{readError}</p>}
      {saved && page && last && <>{(last.coverage.kind === "paged_collection" || last.coverage.kind === "bounded_history") && <div className="atb-pagination" aria-label="工具已读结果分页"><span>第 {saved.index + 1} 个已读页 · 已保存 {saved.pages.length} 页</span><button type="button" disabled={reading || saved.index === 0} onClick={() => setCollection({ ...saved, index: saved.index - 1 })}><ChevronLeft size={14} />上一已读页</button><button type="button" disabled={reading || saved.index + 1 === saved.pages.length && !last.coverage.nextCursor} onClick={() => saved.index + 1 < saved.pages.length ? setCollection({ ...saved, index: saved.index + 1 }) : void read(true)}>下一页<ChevronRight size={14} /></button></div>}
        <AgentToolReadResult key={page.callId} result={page} />
        {last.coverage.kind === "paged_collection" && <p className="atb-muted">全部已读页合计 {last.coverage.readCount} / {last.coverage.total} · {last.coverage.complete ? "已完整读取这一未变化集合" : "尚未完整读取"}</p>}
      </>}
    </div></div>}
  </section>;
}
export function AgentToolDefinitionView({ definition }: { definition: AgentToolDefinition }) {
  return <section className="atb-definition" aria-label="所选严格工具定义"><header><h4><FileCode2 size={15} aria-hidden="true" />所选严格定义</h4><span className="atb-badge">{definition.effect === "read" ? "原生只读" : "原准备与人工确认分开"}</span></header>
    {!definition.available && <p className="atb-notice">当前不可使用 · {definition.blockReason ?? "需重新核对当前原业务权限"}</p>}
    {!!definition.limitations.length && <ul className="atb-diagnostics">{definition.limitations.map((text, index) => <li key={index}>{text}</li>)}</ul>}
    <details><summary>所选输入字段与完整 schema</summary><SchemaFields schema={definition.inputSchema} /><pre tabIndex={0} aria-label="所选输入完整 schema">{JSON.stringify(definition.inputSchema, null, 2)}</pre><p className="atb-muted">字段结构供核对 原值转换与业务规则仍由原 owner 严格校验 不是可执行 JSON 编辑器</p></details>
    <details><summary>所选返回字段与完整 schema</summary><SchemaFields schema={definition.outputSchema} /><pre tabIndex={0} aria-label="所选返回完整 schema">{JSON.stringify(definition.outputSchema, null, 2)}</pre></details>
    <details><summary>固定定义校验值</summary><code>{definition.definitionChecksum}</code></details>
  </section>;
}
function SchemaFields({ schema }: { schema: Record<string, unknown> }) {
  const fields = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties) ? Object.entries(schema.properties) : [];
  const required = Array.isArray(schema.required) ? schema.required : [];
  return fields.length ? <dl className="atb-schema-fields">{fields.map(([name, value]) => {
    const field = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    return <div key={name}><dt><code>{name}</code> <span>{required.includes(name) ? "必需" : "可选"}</span></dt><dd>{typeof field.type === "string" ? field.type : Array.isArray(field.type) ? field.type.join(" / ") : field.oneOf || field.anyOf ? "严格分支 见完整定义" : "见完整定义"}{typeof field.description === "string" && <p>{field.description}</p>}</dd></div>;
  })}</dl> : <p className="atb-muted">此定义由严格分支组成 请展开核对完整 schema</p>;
}
