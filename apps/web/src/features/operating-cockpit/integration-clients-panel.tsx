"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Copy, KeyRound, Plus, RefreshCw, ShieldAlert, ShieldCheck, Webhook } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { CreatedIntegrationApiClientViewSchema, CreateIntegrationApiClientInputSchema, RevokedIntegrationApiClientViewSchema,
  RevokeIntegrationApiClientInputSchema, IntegrationWorkspaceViewSchema, type CreateIntegrationApiClientInput,
  type RevokeIntegrationApiClientInput, type IntegrationApiClientView, type IntegrationApiScope,
  type IntegrationAgentCatalog, type IntegrationClientAdmission, type IntegrationWorkspaceView } from "@yummyai/contracts/integration";
import type { TenantContext } from "@yummyai/contracts/tenant/tenant-context";
import { useErpAccess } from "../identity/erp-access";
import { TaskDrawer, TaskDrawerActions } from "../navigation/task-drawer";
import { IntegrationClientError, integrationClientRequest, integrationDenied } from "./integration-clients-client";
import "./integration-clients-panel.css";

const scopeNames: Record<IntegrationApiScope, string> = { "forecast:read": "预测", "operations:read": "运营指标", "inventory:read": "库存", "finance:read": "财务", "customer_intelligence:read": "客户与广告洞察", "supplier_performance:read": "供应商绩效", "order:read": "订单", "product:read": "商品", "listing:read": "刊登资料" };
type DataScope = TenantContext["dataScope"];
const ranks = { self: 0, team: 1, tenant: 2 }, scopeNamesByLevel = { self: "仅本人", team: "固定团队", tenant: "租户范围" };
const credentialNames = { pinned: "委派范围已固定", revoked: "已撤销", expired: "已到期", requires_reissue: "需重新签发" };
type Pending = { kind: "create"; input: CreateIntegrationApiClientInput } | { kind: "revoke"; id: string; input: RevokeIntegrationApiClientInput };
type Receipt = { client: IntegrationApiClientView; bearerToken: string | null; operation: Pending["kind"] };

export function IntegrationClientRow({ client }: { client: IntegrationApiClientView }) {
  return <><div className="ic-client-heading"><strong>{client.label}</strong><span className={"ic-status ic-status-" + client.credentialState}>{credentialNames[client.credentialState]}</span></div>
    <p><code>{client.keyPrefix}</code> · 创建于 {client.createdAt}</p><p>到期 {client.expiresAt ?? "未设到期时间"}</p>
    {client.delegation ? <details className="ic-details"><summary>原固定范围与团队 · {client.scopes.length} 项</summary>
      <p>委派版本 {client.delegation.version}<br />固定于 {client.delegation.capturedAt}</p><ul>{client.scopes.map(scope => <li key={scope}>{scopeNames[scope]} <code>{scope}</code> · {client.delegation?.permissionScopes[scope] ? scopeNamesByLevel[client.delegation.permissionScopes[scope]!] : "原范围未保留"}</li>)}</ul>
      <p>原固定团队 {client.delegation.teamIds.length ? "" : "无"}</p><ul>{client.delegation.teamIds.map(id => <li key={id}><code>{id}</code></li>)}</ul><p>原请求校验值 <code>{client.delegation.requestChecksum}</code></p>
    </details> : <p className="ic-warning">历史记录没有委派快照 需重新签发 不作为有效调用凭据</p>}
    {client.credentialState === "pinned" && <p className="ic-note">已固定范围不代表当前调用一定可用 每次调用仍核对当前成员与原范围 不代表 MCP 已连接 本人及团队业务适配待验证 当前仅可读取能力目录</p>}</>;
}
export function IntegrationAgentCatalogView({ catalog }: { catalog: IntegrationAgentCatalog }) {
  const domains = { research: "研究", catalog: "商品", creative: "创作", orders: "订单", manufacturing: "制造", procurement: "采购", inventory: "库存", logistics: "物流", finance: "财务", advertising: "广告", knowledge: "知识" };
  const effects = { read: "读取", analyze: "分析", prepare: "准备原提交", execute: "执行", result: "读取原结果" };
  return <details className="ic-details ic-catalog"><summary>全 ERP 能力接入目录 · {catalog.capabilities.length} 项</summary>
    <p className="ic-warning">MCP 尚未连接 目录只说明原业务能力与接入缺口 当前没有可通过统一 Agent 调用的动作</p><p>目录版本 <code>{catalog.version}</code></p>
    {!catalog.capabilities.length && <p>当前没有可展示的能力条目 不据此推断原业务不存在</p>}
    <ul>{catalog.capabilities.map(item => <li key={item.key}><strong>{item.title}</strong><p>{domains[item.domain]} · {effects[item.effect]} · {item.ownerState === "existing" ? "原业务拥有者已存在" : "原业务能力待建设"}</p>
      <p>{item.agentState === "unauthorized" ? "当前权限不足" : "统一 Agent 适配待接入"} · 最低范围 {scopeNamesByLevel[item.minimumScope]}</p><code>{item.key}</code>
      <details className="ic-details"><summary>所需权限</summary><ul>{item.requiredPermissions.map(bit => <li key={bit}><code>{bit}</code></li>)}</ul></details></li>)}</ul>
  </details>;
}
export function IntegrationClientsPanel({ initialWorkspace, onDenied }: { initialWorkspace: IntegrationWorkspaceView; onDenied(): void }) {
  const access = useErpAccess(), authority = access.authority, identity = useRef(authority), mounted = useRef(true), blocked = useRef(false);
  identity.current = authority;
  const [data, setData] = useState(initialWorkspace), [denied, setDenied] = useState(false), [reading, setReading] = useState(false), [error, setError] = useState("");
  const [pending, setPending] = useState<Pending | null>(null), [receipt, setReceipt] = useState<Receipt | null>(null), [open, setOpen] = useState<"create" | "revoke" | null>(null);
  const [target, setTarget] = useState<IntegrationApiClientView | null>(null), [busy, setBusy] = useState(false), [closing, setClosing] = useState(false), [copied, setCopied] = useState("");
  const generation = useRef(0), readController = useRef<AbortController | null>(null), exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null), receiptRef = useRef(receipt); receiptRef.current = receipt;
  const allowed = Boolean(authority && access.can(Permission.IntegrationRead) && data.contextAuthority === authority && data.agentCatalog.contextAuthority === authority && !denied);
  const readable = useRef(allowed); readable.current = allowed;
  const current = useCallback((stamp: string) => mounted.current && !blocked.current && readable.current && identity.current === stamp, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; readController.current?.abort(); if (exitTimer.current) clearTimeout(exitTimer.current); }; }, []);
  const deny = useCallback(() => { blocked.current = true; generation.current++; readController.current?.abort(); if (exitTimer.current) clearTimeout(exitTimer.current);
    setReceipt(null); setPending(null); setOpen(null); setTarget(null); setCopied(""); setDenied(true); onDenied(); window.dispatchEvent(new Event("focus")); }, [onDenied]);
  useLayoutEffect(() => { if (!allowed) { generation.current++; readController.current?.abort(); setReceipt(null); setPending(null); setOpen(null); setTarget(null); setCopied(""); } }, [allowed]);
  useEffect(() => { if (initialWorkspace.contextAuthority === authority && !blocked.current) setData(initialWorkspace); }, [initialWorkspace, authority]);
  async function reload() {
    if (!authority || !current(authority) || reading) return; const stamp = authority, token = ++generation.current;
    readController.current?.abort(); const controller = new AbortController(); readController.current = controller; setReading(true); setError("");
    try { const result = await integrationClientRequest("workspace", stamp, IntegrationWorkspaceViewSchema, undefined, controller.signal);
      if (!controller.signal.aborted && token === generation.current && current(stamp)) setData(result); }
    catch (failure) { if (!controller.signal.aborted && token === generation.current && current(stamp)) { if (integrationDenied(failure)) deny(); else setError("当前列表暂时无法刷新 已登记结果仍保留 请重新读取"); } }
    finally { if (token === generation.current && current(stamp)) setReading(false); }
  }
  async function execute(original: Pending) {
    if (!authority || !current(authority) || busy || !access.can(Permission.IntegrationManage) || !data.clientAdmission.canManage) return;
    const stamp = authority, token = ++generation.current; readController.current?.abort(); setReading(false); setPending(original); setBusy(true); setError(""); setCopied("");
    try {
      const value = original.kind === "create" ? await integrationClientRequest("clients", stamp, CreatedIntegrationApiClientViewSchema, original.input)
        : await integrationClientRequest("clients/" + original.id + "/revoke", stamp, RevokedIntegrationApiClientViewSchema, original.input);
      if (token !== generation.current || !current(stamp)) return;
      setReceipt({ client: value.client, operation: original.kind, bearerToken: "bearerToken" in value && typeof value.bearerToken === "string" ? value.bearerToken : null }); setPending(null);
      setData(previous => ({ ...previous, apiClients: [value.client, ...previous.apiClients.filter(row => row.id !== value.client.id)] }));
    } catch (failure) { if (token === generation.current && current(stamp)) { if (integrationDenied(failure)) deny(); else setError(failure instanceof IntegrationClientError ? failure.message : "原请求结果未知 请保留原编号核对"); } }
    finally { if (token === generation.current && current(stamp)) setBusy(false); }
  }
  function close() {
    if (busy || !authority || !current(authority)) return;
    // Clear the one-time credential synchronously, before any exit animation.
    setReceipt(null); receiptRef.current = null; setCopied(""); setClosing(true);
    const finish = () => { if (current(authority)) { setOpen(null); setTarget(null); setClosing(false); } };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) finish(); else exitTimer.current = setTimeout(finish, 150);
  }
  async function copy() {
    const value = receiptRef.current?.bearerToken, stamp = authority; if (!value || !stamp || !current(stamp)) return;
    try { await navigator.clipboard.writeText(value); if (current(stamp) && receiptRef.current?.bearerToken === value) setCopied("已复制 请保存到自己的凭据管理器"); }
    catch { if (current(stamp)) setCopied("复制未完成 请在当前窗口手动保存 凭据关闭后不再显示"); }
  }
  if (!allowed) return <section className="ic-panel" aria-label="API 客户端与 Agent 接入"><p role="status">当前开放集成读取权限尚未核对 原列表 填写与一次性凭据已隐藏</p></section>;
  const canManage = access.can(Permission.IntegrationManage) && data.clientAdmission.canManage;
  return <section className="ic-panel operating-cockpit-panel" aria-labelledby="operating-integrations-title"><header className="ic-panel-header"><div><p>只读委派与能力接入</p><h2 id="operating-integrations-title">开放集成</h2></div><div className="ic-actions">
    <button className="oc-button" disabled={reading || busy} onClick={() => void reload()}><RefreshCw size={14} />重新读取客户端</button>
    {canManage && <button className="oc-button primary" disabled={busy || Boolean(pending)} onClick={() => { setReceipt(null); setError(""); setOpen("create"); }}><Plus size={14} />创建只读客户端</button>}</div></header>
    <p className="ic-note">当前服务显示近期客户端 最多 100 条 不是完整历史 固定委派不等于全 ERP 或 MCP 已接通</p>
    {!canManage && <p>当前可读取集成记录 没有客户端创建或撤销权限</p>}
    {reading && <p role="status">正在核对当前客户端列表</p>}{error && <p role="alert" className="ic-warning">{error}</p>}
    {pending && !open && <section className="ic-pending" aria-label="本页原客户端请求"><strong>原请求结果尚待核对</strong><code>{pending.input.idempotencyKey}</code><p>原正文和编号仅在本页保留 刷新后先核对客户端列表 凭据不会再次显示 不自动创建新客户端</p><button className="oc-button" onClick={() => { setOpen(pending.kind); setReceipt(null); }}>恢复原客户端请求</button></section>}
    <div className="operating-cockpit-registry ic-registry"><div><h3><KeyRound size={14} /> API 客户端</h3>{!data.apiClients.length && <p>还没有 API 客户端或 Webhook 端点时 可先创建最小只读委派</p>}
      <ol>{data.apiClients.map(client => <li key={client.id}><IntegrationClientRow client={client} />{canManage && client.status === "active" && <button className="oc-button" disabled={busy || Boolean(pending)} onClick={() => { setReceipt(null); setError(""); setTarget(client); setOpen("revoke"); }}>撤销客户端 {client.label}</button>}</li>)}</ol></div>
      <div><h3><Webhook size={14} /> Webhook 端点</h3>{!data.webhookEndpoints.length && <p>尚无 Webhook 端点</p>}<ol>{data.webhookEndpoints.map(endpoint => <li key={endpoint.id}><strong>{endpoint.label}</strong><code>{endpoint.url}</code><p>{endpoint.status === "active" ? "启用" : "停用"} · V{endpoint.version} · 最多 {endpoint.maxAttempts} 次</p></li>)}</ol></div></div>
    <IntegrationAgentCatalogView catalog={data.agentCatalog} />
    {open && <TaskDrawer title={open === "create" ? "创建只读客户端" : "撤销客户端"} state={{ dirty: !receipt && !pending, busy, loading: false }} onClose={close} recordKey={pending?.input.idempotencyKey ?? open}
      footer={<TaskDrawerActions><button className="oc-button" disabled={busy || closing} onClick={() => { if (receipt || pending || window.confirm("关闭将清除尚未发送的填写 是否继续")) close(); }}>关闭客户端填写</button></TaskDrawerActions>}>
      <div className="ic-dialog" data-closing={closing} inert={closing}>
      {receipt ? <section aria-label="客户端操作回执"><h3><ShieldCheck size={16} />{receipt.operation === "create" ? "客户端已登记" : "客户端已撤销"}</h3><p>实际客户端 <code>{receipt.client.id}</code></p><IntegrationClientRow client={receipt.client} />
        {receipt.bearerToken ? <><p className="ic-warning">凭据只显示这一次 关闭窗口或权限变化后即清除 不会保存到浏览器存储</p><label>本次一次性凭据<input data-private-secret readOnly autoComplete="off" spellCheck={false} value={receipt.bearerToken} /></label><button className="oc-button" onClick={() => void copy()}><Copy size={14} />复制本次一次性凭据</button>{copied && <p role="status">{copied}</p>}</>
          : receipt.operation === "create" && <p className="ic-warning">原请求已登记 凭据不再复显 若未保存请撤销该客户端后重新创建 不重新播放凭据</p>}</section>
        : pending ? <section aria-label="原客户端请求核对"><h3>只重试原客户端请求</h3><code>{pending.input.idempotencyKey}</code>
          {pending.kind === "create" ? <><p>原客户端名称 {pending.input.label}</p><ul>{pending.input.scopes.map(scope => <li key={scope}>{scopeNames[scope]} · {pending.input.scopeLimits?.[scope] ? scopeNamesByLevel[pending.input.scopeLimits[scope]!] : "原请求未显式限定"}</li>)}</ul><p>原到期时间 {pending.input.expiresAt ?? "未设到期时间"}</p><p>原团队 {pending.input.teamIds === undefined ? "提交时由服务器固定" : pending.input.teamIds.length ? pending.input.teamIds.join(" · ") : "无"}</p></> : <><p>原客户端 <code>{pending.id}</code></p><p>原撤销原因 {pending.input.reasonCode}</p></>}
          <p>正文与编号已固定 不替换权限 团队或到期时间 同键回放不会再次返回凭据</p><button className="oc-button primary" disabled={busy || closing || !canManage} onClick={() => void execute(pending)}>按原正文和编号核对结果</button></section>
          : open === "create" ? <CreateClientForm admission={data.clientAdmission} disabled={busy || closing || !canManage} onCreate={input => void execute({ kind: "create", input })} />
            : target && <RevokeClientForm client={target} disabled={busy || closing || !canManage} onRevoke={input => void execute({ kind: "revoke", id: target.id, input })} />}
      {busy && <p role="status">正在登记原请求 请等待回执 关闭连接不代表事务未提交</p>}{error && <p role="alert" className="ic-warning">{error}</p>}
      </div></TaskDrawer>}
  </section>;
}
function CreateClientForm({ admission, disabled, onCreate }: { admission: IntegrationClientAdmission; disabled: boolean; onCreate(input: CreateIntegrationApiClientInput): void }) {
  const [label, setLabel] = useState(""), [expires, setExpires] = useState(""), [selected, setSelected] = useState<Partial<Record<IntegrationApiScope, DataScope>>>({}), [error, setError] = useState("");
  return <form className="ic-form" aria-label="创建只读客户端委派" onSubmit={event => { event.preventDefault();
    try { const scopes = admission.scopes.map(row => row.scope).filter(scope => selected[scope] !== undefined), input = CreateIntegrationApiClientInputSchema.safeParse({ label, scopes, scopeLimits: Object.fromEntries(scopes.map(scope => [scope, selected[scope]])), expiresAt: expires ? new Date(expires).toISOString() : null, idempotencyKey: crypto.randomUUID() });
      if (!input.success || !scopes.length) setError("请填写名称并选择至少一项当前允许的只读权限"); else { setError(""); onCreate(input.data); }
    } catch { setError("请核对完整有效的到期时间"); } }}>
    <p>只显示当前服务器允许委派的权限 每项默认仅本人 不能超过当前范围</p><p className="ic-warning">self/team 业务适配待验证 当前仅可读取能力目录 租户范围也只开放已有受控只读接口 不是全 ERP 或 MCP 已接通</p><fieldset disabled={disabled}><label>客户端名称<input required maxLength={120} value={label} onChange={event => setLabel(event.target.value)} /></label>
      <div role="group" aria-label="客户端只读权限">{admission.scopes.map(row => <div className="ic-scope" key={row.scope}><label className="ic-check"><input type="checkbox" checked={selected[row.scope] !== undefined} onChange={event => setSelected(previous => { const next = { ...previous }; if (event.target.checked) next[row.scope] = "self"; else delete next[row.scope]; return next; })} />{scopeNames[row.scope]} <code>{row.scope}</code></label>
        <label>授权范围 {scopeNames[row.scope]}<select aria-label={"授权范围 " + scopeNames[row.scope]} disabled={selected[row.scope] === undefined} value={selected[row.scope] ?? "self"} onChange={event => setSelected(previous => ({ ...previous, [row.scope]: event.target.value as DataScope }))}>{(["self", "team", "tenant"] as const).filter(level => ranks[level] <= ranks[row.maximumScope]).map(level => <option key={level} value={level}>{scopeNamesByLevel[level]}</option>)}</select></label><small>当前最大范围 {scopeNamesByLevel[row.maximumScope]}</small></div>)}</div>
      {!admission.scopes.length && <p className="ic-warning">没有可委派的只读权限 无法创建</p>}
      <details className="ic-details"><summary>本次固定团队 · {admission.teamIds.length} 项</summary><p>默认冻结服务器提供的当前团队 不接受任意团队编号</p>{admission.teamIds.length ? <ul>{admission.teamIds.map(id => <li key={id}><code>{id}</code></li>)}</ul> : <p>当前无团队</p>}</details>
      <label>到期时间 本机当地时间 可留空<input type="datetime-local" step="0.001" value={expires} onChange={event => setExpires(event.target.value)} /></label>
      <p className="ic-note">创建不是连接 MCP 凭据只返回一次 请在自己的凭据管理器保存</p>{error && <p role="alert" className="ic-warning">{error}</p>}
      <button className="oc-button primary" disabled={!admission.scopes.length}>创建委派并显示一次凭据</button></fieldset>
  </form>;
}
function RevokeClientForm({ client, disabled, onRevoke }: { client: IntegrationApiClientView; disabled: boolean; onRevoke(input: RevokeIntegrationApiClientInput): void }) {
  const [reason, setReason] = useState(""), [confirmed, setConfirmed] = useState(false), [error, setError] = useState("");
  return <form className="ic-form" aria-label="撤销只读客户端" onSubmit={event => { event.preventDefault(); const input = RevokeIntegrationApiClientInputSchema.safeParse({ expectedStatus: "active", reasonCode: reason, idempotencyKey: crypto.randomUUID() });
    if (!input.success || !confirmed) setError("请填写大写原因代码并明确核对原客户端"); else onRevoke(input.data); }}><h3><ShieldAlert size={16} />撤销 {client.label}</h3><p>原客户端 <code>{client.id}</code></p>
    <fieldset disabled={disabled}><label>撤销原因代码<input required maxLength={100} pattern={"[A-Z0-9][A-Z0-9._\\-]*"} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <label className="ic-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我已核对原客户端 撤销后原凭据不能继续调用</label>{error && <p role="alert" className="ic-warning">{error}</p>}<button className="oc-button primary" disabled={!confirmed}>撤销这笔客户端凭据</button></fieldset></form>;
}
