"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Database, RefreshCw } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { AgentReadCallSchema, AgentReadPageViewSchema, AgentReadWorkspaceSchema, type AgentBalanceItem, type AgentExceptionItem, type AgentReadCall,
  type AgentReadPageView, type AgentReadToolKey, type AgentReadWorkspace } from "@yummyai/contracts/ai/agent-read";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { useErpAccess } from "../identity/erp-access";
import { assistJsonRequest, assistReadDenied, AssistRequestError } from "../ai-assist/assist-client";

const names = { "orders.exceptions.page": "订单异常", "inventory.balances.page": "库存余额" };
export function AgentReadTools() {
  const access = useErpAccess();
  if (!access.authority) return <section className="agent-read-tools" aria-label="Agent 只读工具"><p role="status">正在核对当前本人身份 暂不读取业务资料</p></section>;
  return <AgentReadToolsContent key={access.authority} />;
}
function AgentReadToolsContent() {
  const access = useErpAccess(), authority = access.authority!, alive = useRef(true), generation = useRef(0), controller = useRef<AbortController | null>(null), lock = useRef(false);
  const workspaceSequence = useRef(0), workspaceController = useRef<AbortController | null>(null);
  const currentAuthority = useRef(authority); currentAuthority.current = access.authority ?? "";
  const [workspace, setWorkspace] = useState<AgentReadWorkspace | null>(null), [readingWorkspace, setReadingWorkspace] = useState(false), [workspaceError, setWorkspaceError] = useState("");
  const [denied, setDenied] = useState(false), blocked = useRef(false);
  const [tool, setTool] = useState<AgentReadToolKey>(access.canTenant(Permission.OrderRead) ? "orders.exceptions.page" : "inventory.balances.page");
  const [pageSize, setPageSize] = useState(25), [status, setStatus] = useState<"open" | "resolved" | "all">("open"), [orderId, setOrderId] = useState(""), [stockId, setStockId] = useState(""), [locationId, setLocationId] = useState("");
  const [collection, setCollection] = useState<{ query: string; pages: AgentReadPageView[]; index: number } | null>(null), [reading, setReading] = useState(false), [error, setError] = useState("");
  const query = canonicalJson({ tool, pageSize, status: tool === "orders.exceptions.page" ? status : null, orderId: tool === "orders.exceptions.page" ? orderId : null, stockId: tool === "inventory.balances.page" ? stockId : null, locationId: tool === "inventory.balances.page" ? locationId : null });
  const currentQuery = useRef(query); currentQuery.current = query;
  const valid = useCallback(() => alive.current && !blocked.current && currentAuthority.current === authority, [authority]);
  const deny = useCallback(() => { blocked.current = true; generation.current++; workspaceSequence.current++; controller.current?.abort(); workspaceController.current?.abort(); setDenied(true); setWorkspace(null); setCollection(null); setOrderId(""); setStockId(""); setLocationId(""); window.dispatchEvent(new Event("focus")); }, []);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; workspaceSequence.current++; controller.current?.abort(); workspaceController.current?.abort(); }; }, []);
  const reloadWorkspace = useCallback(async () => {
    if (!valid()) return; const abort = new AbortController(), token = ++workspaceSequence.current; workspaceController.current?.abort(); workspaceController.current = abort; setReadingWorkspace(true); setWorkspaceError("");
    try { const result = await assistJsonRequest("/api/agent-reads/workspace", AgentReadWorkspaceSchema, undefined, abort.signal, authority);
      if (!abort.signal.aborted && token === workspaceSequence.current && valid()) setWorkspace(result); }
    catch (failure) { if (!abort.signal.aborted && token === workspaceSequence.current && valid()) { if (assistReadDenied(failure)) deny(); else setWorkspaceError("工具执行契约暂不可读取 请重新核对"); } }
    finally { if (token === workspaceSequence.current && valid()) setReadingWorkspace(false); }
  }, [authority, valid, deny]);
  useEffect(() => { void reloadWorkspace(); }, [reloadWorkspace]);
  const reset = (change: () => void) => { generation.current++; controller.current?.abort(); lock.current = false; setReading(false); setCollection(null); setError(""); change(); };
  const saved = collection?.query === query ? collection : null, page = saved?.pages[saved.index], last = saved?.pages.at(-1);
  const capability = workspace?.tools.find(item => item.key === tool), locallyAllowed = tool === "orders.exceptions.page" ? access.canTenant(Permission.OrderRead) : access.canTenant(Permission.InventoryRead);
  async function read(next = false) {
    if (!workspace || !valid() || lock.current || !locallyAllowed || !capability?.available || next && (!last || last.complete || !last.nextCursor)) return;
    const input = AgentReadCallSchema.safeParse({ version: workspace.version, executionContract: workspace.executionContract, tool,
      input: tool === "orders.exceptions.page" ? { pageSize, cursor: next ? last!.nextCursor : null, status, ...(orderId.trim() ? { orderId: orderId.trim() } : {}) }
        : { pageSize, cursor: next ? last!.nextCursor : null, ...(stockId.trim() ? { stockItemId: stockId.trim() } : {}), ...(locationId.trim() ? { locationId: locationId.trim() } : {}) } });
    if (!input.success) { setError("请核对完整有效的原对象 ID 和分页大小 未读取替代对象"); return; }
    const key = query, token = ++generation.current, abort = new AbortController(); controller.current?.abort(); controller.current = abort;
    lock.current = true; setReading(true); setError(""); if (!next) setCollection(null);
    try {
      const value = await assistJsonRequest("/api/agent-reads/call", AgentReadPageViewSchema, input.data, abort.signal, authority);
      if (!valid() || abort.signal.aborted || token !== generation.current || currentQuery.current !== key) return;
      validateReadPage(value, input.data, next ? saved!.pages : []);
      setCollection({ query: key, pages: next ? [...saved!.pages, value] : [value], index: next ? saved!.pages.length : 0 });
    } catch (failure) { if (valid() && !abort.signal.aborted && token === generation.current && currentQuery.current === key) {
      if (assistReadDenied(failure)) deny(); else {
        if (failure instanceof AssistRequestError && failure.code === "agent_collection_changed") setCollection(null);
        setError(failure instanceof AssistRequestError ? failure.message : "本页读取失败 已读页不代表全量 请重新读取"); }
    } } finally { if (token === generation.current) { lock.current = false; if (valid()) setReading(false); } }
  }
  if (denied) return <section className="agent-read-tools" aria-label="Agent 只读工具"><p role="status">当前工具读取权限已变化 原列表和筛选已清除 请重新核对本人权限</p></section>;
  return <section className="agent-read-tools" aria-label="Agent 只读工具"><header><h2><Database size={16} />Agent 只读工具</h2><button type="button" disabled={reading || readingWorkspace} onClick={() => void reloadWorkspace()}><RefreshCw size={14} />重新读取工具契约</button></header>
    <p className="at-muted">真实原业务读取 不调用模型 不登记订单或库存写入 MCP 尚未连接</p>
    {readingWorkspace && <p role="status">正在读取工具执行契约</p>}{workspaceError && <p className="at-error" role="alert">{workspaceError}</p>}
    <nav className="at-actions" aria-label="选择只读工具">{(["orders.exceptions.page", "inventory.balances.page"] as const).map(key => <button key={key} type="button" aria-pressed={tool === key} onClick={() => reset(() => setTool(key))}>{names[key]}</button>)}</nav>
    <form className="agent-read-filters" aria-label={names[tool] + "读取筛选"} onSubmit={event => { event.preventDefault(); void read(); }}>
      {tool === "orders.exceptions.page" ? <><label>异常状态<select value={status} onChange={event => reset(() => setStatus(event.target.value as typeof status))}><option value="open">待处理</option><option value="resolved">已解决</option><option value="all">全部</option></select></label><label>原订单 ID 可留空<input value={orderId} onChange={event => reset(() => setOrderId(event.target.value))} /></label></> :
        <><label>原库存货品 ID 可留空<input value={stockId} onChange={event => reset(() => setStockId(event.target.value))} /></label><label>原库位 ID 可留空<input value={locationId} onChange={event => reset(() => setLocationId(event.target.value))} /></label></>}
      <label>每页记录数<select value={pageSize} onChange={event => reset(() => setPageSize(Number(event.target.value)))}>{[25, 50, 100].map(size => <option key={size} value={size}>{size}</option>)}</select></label>
      <button className="at-primary" disabled={!workspace || readingWorkspace || reading || !locallyAllowed || !capability?.available}>读取{names[tool]}</button>
    </form>
    {!locallyAllowed && <p className="at-muted">该工具需要当前租户范围的{tool === "orders.exceptions.page" ? "订单" : "库存"}读取权限 当前不读取业务资料</p>}
    {locallyAllowed && workspace && !capability?.available && <p className="at-muted">服务器当前未允许该工具 请重新核对权限与执行契约</p>}
    {reading && <p role="status">正在串行读取原集合 未完成前不称全量</p>}{error && <p className="at-error" role="alert">{error}</p>}
    {saved && page && last && <section aria-label={names[tool] + "读取结果"} className="agent-read-result"><header><h3>{names[tool]}原读取结果</h3><p>已读取 {last.readCount} / {last.total} · {last.complete ? "已完整读取该集合" : "尚未完整读取"}</p></header>
      <p className="at-muted">第 {saved.index + 1} 个已读页 · 本页 {page.items.length} 条 · 核对于 {page.checkedAt} · 集合未变化口径</p>
      <div className="at-pagination"><button type="button" disabled={reading || saved.index === 0} onClick={() => setCollection({ ...saved, index: saved.index - 1 })}><ChevronLeft size={14} />上一已读页</button>
        <button type="button" disabled={reading || saved.index === saved.pages.length - 1 && last.complete} onClick={() => saved.index < saved.pages.length - 1 ? setCollection({ ...saved, index: saved.index + 1 }) : void read(true)}>下一页<ChevronRight size={14} /></button></div>
      {page.tool === "orders.exceptions.page" ? <AgentExceptionRows items={page.items} /> : <AgentBalanceRows items={page.items} />}
      {!page.items.length && <p>本次原集合没有符合筛选的记录</p>}<details><summary>集合校验依据</summary><code>{page.collectionFingerprint}</code></details>
      <Link href={page.tool === "orders.exceptions.page" ? "/orders" : "/inventory"}>进入原{page.tool === "orders.exceptions.page" ? "订单" : "库存"}工作区核对</Link>
    </section>}
    {workspace && <details><summary>当前固定工具与执行契约</summary><p>{workspace.executionContract.executorKey}</p><code>{workspace.executionContract.checksum}</code>
      <ul>{workspace.tools.map(item => <li key={item.key}>{item.descriptor.label} · <code>{item.key}</code> · {item.descriptor.version} · 只读 · {item.available ? "当前可读取" : "当前不可读取"}</li>)}</ul></details>}
  </section>;
}
function validateReadPage(value: AgentReadPageView, input: AgentReadCall, pages: AgentReadPageView[]) {
  const previous = pages.at(-1), ids = new Set(pages.flatMap(page => page.items.map(item => item.id)));
  if (value.tool !== input.tool || canonicalJson(value.query) !== canonicalJson(input.input) || value.readCount !== (previous?.readCount ?? 0) + value.items.length ||
    previous && (previous.collectionFingerprint !== value.collectionFingerprint || previous.total !== value.total) || value.items.some(item => ids.has(item.id)) ||
    value.complete !== (value.readCount === value.total) || value.complete !== (value.nextCursor === null))
    throw new AssistRequestError(409, "原集合或分页依据无法连续核对 已清除旧页 请从第一页重新读取", "agent_collection_changed");
}
export function AgentExceptionRows({ items }: { items: AgentExceptionItem[] }) {
  return <ol className="agent-read-rows">{items.map(item => <li key={item.id}><h4>{item.status === "open" ? "待处理异常" : "已解决异常"} · {item.category}</h4><dl><div><dt>原异常 ID</dt><dd><code>{item.id}</code></dd></div><div><dt>原订单 ID</dt><dd><code>{item.orderId}</code></dd></div>
    <div><dt>原事件</dt><dd>{item.eventMissing ? "原事件缺失 不补造" : item.eventId ?? "未提供"}</dd></div><div><dt>原序列</dt><dd>异常 {item.sequence} · 订单 {item.orderSequence}</dd></div><div><dt>发生时间</dt><dd>{item.openedAt}</dd></div><div><dt>解决时间</dt><dd>{item.resolvedAt ?? "尚未解决"}</dd></div></dl><details><summary>原来源校验值</summary><code>{item.sourceChecksum}</code></details></li>)}</ol>;
}
export function AgentBalanceRows({ items }: { items: AgentBalanceItem[] }) {
  const units = { each: "件", pair: "双", set: "套", meter: "米", gram: "克", kilogram: "千克" };
  return <ol className="agent-read-rows">{items.map(item => <li key={item.id}><h4>库存原余额 · {units[item.unit]}</h4><dl><div><dt>货品 ID</dt><dd><code>{item.stockItemId}</code></dd></div><div><dt>库位 ID</dt><dd><code>{item.locationId}</code></dd></div><div><dt>批次 ID</dt><dd><code>{item.lotId ?? "无批次"}</code></dd></div>
    {([['实物', item.physicalQuantity], ['已预留', item.reservedQuantity], ['可用', item.availableQuantity], ['在途', item.inTransitQuantity], ['服务商', item.providerQuantity], ['虚拟', item.virtualQuantity]] as const).map(([label, quantity]) => <div key={label}><dt>{label}</dt><dd>{String(quantity)} {units[item.unit]}</dd></div>)}
    <div><dt>投影版本</dt><dd>{item.projectionVersion}</dd></div><div><dt>原更新时间</dt><dd>{item.updatedAt}</dd></div><div><dt>原维度</dt><dd><code>{item.dimensionKey}</code></dd></div></dl></li>)}</ol>;
}
