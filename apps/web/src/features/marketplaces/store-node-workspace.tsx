"use client";

import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, CheckCheck, Copy, Download, FileKey2, KeyRound, Link2, LoaderCircle, RefreshCw, Server, ShieldCheck, Unplug, X } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { CreateStoreNodeEnrollmentInputSchema, type CreateStoreNodeEnrollmentInput, type StoreNodeEnrollmentBundle,
  type StoreNodeGenerationFence, type StoreNodeWorkspace as Workspace } from "@yummyai/contracts/marketplace/store-node";
import { ErpIdentityContext, useErpAccess } from "../identity/erp-access";
import { marketplaceAuthorityDigest } from "./marketplace-lifecycle";
import { bindStoreNode, createStoreNodeEnrollment, readStoreNodes, reissueStoreNodeEnrollment, revokeStoreNode,
  type StoreNodeRequestContext } from "./store-node-actions";
import { newStoreNodeRequestKey, normalizeStoreNodePublicKey, StoreNodeRequestError, storeNodeDenied, storeNodeErrorMessage, storeNodeOperationAllowed, storeNodeReachability } from "./store-node-lifecycle";
import "./store-node.css";

type Props = { accountId: string; contextAuthority: string; onDenied?: () => void };
export function StoreNodeWorkspace(props: Props) {
  const access = useErpAccess(), identity = useContext(ErpIdentityContext), session = identity?.session;
  if (!session || !access.authority || !access.can(Permission.StoreRead)) return <section className="store-node" aria-label="本店独立节点"><p role="status">当前无本店节点读取权限 节点资料已隐藏</p></section>;
  const scope = `${access.authority}:${props.accountId.toLowerCase()}:${props.contextAuthority}`;
  return <StoreNodePanel key={scope} {...props} actorId={session.userId} tenantId={session.tenantId} rawAuthority={access.authority} scope={scope} />;
}

type Review = { kind: "bind" | "reissue" | "revoke"; nodeId: string; fence: StoreNodeGenerationFence };
function StoreNodePanel({ accountId, contextAuthority, actorId, tenantId, rawAuthority, scope, onDenied }: Props & { actorId: string; tenantId: string; rawAuthority: string; scope: string }) {
  const access = useErpAccess(), currentScope = useRef(scope); currentScope.current = scope;
  const alive = useRef(true), epoch = useRef(0), readId = useRef(0), operationId = useRef(0), secretEpoch = useRef(0), fileEpoch = useRef(0);
  const readController = useRef<AbortController | null>(null), writeController = useRef<AbortController | null>(null), pending = useRef<string | null>(null);
  const dataRef = useRef<Workspace | null>(null), receivedAt = useRef(0), attemptRef = useRef<CreateStoreNodeEnrollmentInput | null>(null), deniedRef = useRef(false);
  const deniedCallback = useRef(onDenied); deniedCallback.current = onDenied;
  const [data, setData] = useState<Workspace | null>(null), [reading, setReading] = useState(false), [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState(""), [unverified, setUnverified] = useState(true), [clock, setClock] = useState(0);
  const [bundle, setBundle] = useState<StoreNodeEnrollmentBundle | null>(null), [copyMessage, setCopyMessage] = useState("");
  const [formOpen, setFormOpen] = useState(false), [label, setLabel] = useState(""), [publicKey, setPublicKey] = useState(""), [publicConfirmed, setPublicConfirmed] = useState(false);
  const [attempt, setAttempt] = useState<CreateStoreNodeEnrollmentInput | null>(null), [attemptState, setAttemptState] = useState<"pending" | "unknown" | "found" | null>(null);
  const [review, setReview] = useState<Review | null>(null), [confirmed, setConfirmed] = useState(false), [selectedNode, setSelectedNode] = useState("");
  const valid = useCallback((version = epoch.current) => alive.current && currentScope.current === scope && version === epoch.current, [scope]);
  const clearBundle = useCallback(() => { secretEpoch.current++; setBundle(null); setCopyMessage(""); }, []);
  const clearPrivate = useCallback(() => {
    epoch.current++; readId.current++; operationId.current++; fileEpoch.current++; secretEpoch.current++; deniedRef.current = true;
    readController.current?.abort(); writeController.current?.abort(); pending.current = null; dataRef.current = null; attemptRef.current = null;
    setData(null); setBundle(null); setAttempt(null); setAttemptState(null); setPublicKey(""); setLabel(""); setPublicConfirmed(false);
    setReview(null); setConfirmed(false); setSelectedNode(""); setFormOpen(false); setReading(false); setBusy(null); setUnverified(true); setCopyMessage("");
  }, []);
  const deny = useCallback((text: string) => { clearPrivate(); setMessage(text); deniedCallback.current?.(); window.dispatchEvent(new Event("focus")); }, [clearPrivate]);
  useLayoutEffect(() => {
    alive.current = true;
    const clear = () => { clearPrivate(); alive.current = false; setMessage("当前本人会话已清除 节点资料与登记包已隐藏"); };
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, clear);
    return () => { window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); alive.current = false; epoch.current++; readId.current++; operationId.current++;
      secretEpoch.current++; fileEpoch.current++; readController.current?.abort(); writeController.current?.abort(); dataRef.current = null; attemptRef.current = null; };
  }, [clearPrivate]);
  const context = useCallback(async (signal: AbortSignal, version: number): Promise<StoreNodeRequestContext> => {
    const digest = await marketplaceAuthorityDigest(rawAuthority);
    if (!valid(version) || signal.aborted) throw new StoreNodeRequestError(0);
    if (digest !== contextAuthority) throw new StoreNodeRequestError(409, "authority_changed");
    return { accountId, actorId, tenantId, authority: digest, signal };
  }, [accountId, actorId, contextAuthority, rawAuthority, tenantId, valid]);
  const accept = useCallback((value: Workspace) => { dataRef.current = value; receivedAt.current = performance.now(); setClock(Date.parse(value.observedAt)); setData(value); setUnverified(false); }, []);
  const load = useCallback(async (manual = false) => {
    if (!valid() || deniedRef.current && !manual) return;
    const version = epoch.current, sequence = ++readId.current, abort = new AbortController(); readController.current?.abort(); readController.current = abort;
    clearBundle(); setReview(null); setConfirmed(false); setReading(true); setMessage("");
    try {
      const value = await readStoreNodes(await context(abort.signal, version));
      if (!valid(version) || readId.current !== sequence || abort.signal.aborted) return;
      deniedRef.current = false; accept(value);
      const original = attemptRef.current;
      if (original) { const found = value.nodes.find(node => node.creationRequestKey === original.idempotencyKey);
        setAttemptState(found ? "found" : "unknown"); setMessage(found ? "已找到原登记节点 票据不会重新显示 如需登记请明确重新签发" : "本次读取未找到原登记 不代表未提交 本页仍保留同一原请求"); }
    } catch (error) {
      if (!valid(version) || readId.current !== sequence || abort.signal.aborted) return;
      const failure = error instanceof StoreNodeRequestError ? error : new StoreNodeRequestError(502);
      if (storeNodeDenied(failure)) { deny(storeNodeErrorMessage(failure)); return; }
      setUnverified(true); setMessage(storeNodeErrorMessage(failure));
    } finally { if (valid(version) && readId.current === sequence) setReading(false); }
  }, [accept, clearBundle, context, deny, valid]);
  useEffect(() => { void load(); const focus = () => { if (document.visibilityState !== "hidden") void load(); };
    window.addEventListener("focus", focus); window.addEventListener("pageshow", focus);
    return () => { readController.current?.abort(); window.removeEventListener("focus", focus); window.removeEventListener("pageshow", focus); }; }, [load]);
  useEffect(() => { if (!data) return; const timer = window.setInterval(() => setClock(Date.parse(data.observedAt) + performance.now() - receivedAt.current), 1000);
    return () => window.clearInterval(timer); }, [data]);
  useEffect(() => { if (bundle && Date.parse(bundle.expiresAt) <= clock) clearBundle(); }, [bundle, clearBundle, clock]);

  const canChange = !!data && data.access.manage && data.access.authorize && access.can(Permission.StoreManage) && access.can(Permission.StoreAuthorize);
  const readyFor = (operation: "create" | Review["kind"]) => canChange && !unverified && !reading && storeNodeOperationAllowed(data!, operation);
  const ready = readyFor("create");
  function openReview(kind: Review["kind"], nodeId: string) {
    const current = dataRef.current, node = current?.nodes.find(row => row.id === nodeId); if (!current || !node || !readyFor(kind) || pending.current) return;
    clearBundle(); setConfirmed(false); setReview({ kind, nodeId, fence: { expectedAuthorizationGeneration: current.authorizationGeneration,
      expectedBindingRevision: current.binding.revision, expectedCertificateGeneration: node.certificateGeneration } });
  }
  async function mutate(kind: "create" | Review["kind"], original?: CreateStoreNodeEnrollmentInput) {
    const before = dataRef.current;
    if (!before || !readyFor(kind) || !valid() || pending.current || kind !== "create" && (!review || !confirmed)) return;
    const version = epoch.current, sequence = ++operationId.current, selected = review;
    writeController.current?.abort(); const abort = new AbortController(); writeController.current = abort; pending.current = kind; setBusy(kind);
    readId.current++; fileEpoch.current++; readController.current?.abort(); setReading(false); clearBundle(); const ticketVersion = secretEpoch.current; setMessage("");
    let createInput = original;
    try {
      if (kind === "create") {
        if (!createInput) { if (attemptRef.current || !publicConfirmed) throw new StoreNodeRequestError(400);
          createInput = CreateStoreNodeEnrollmentInputSchema.parse({ label, publicKeyPem: normalizeStoreNodePublicKey(publicKey), idempotencyKey: newStoreNodeRequestKey(),
            expectedAuthorizationGeneration: before.authorizationGeneration, expectedBindingRevision: before.binding.revision }); }
        attemptRef.current = createInput; setAttempt(createInput); setAttemptState("pending");
      }
      const requestContext = await context(abort.signal, version);
      if (!valid(version) || operationId.current !== sequence || abort.signal.aborted) return;
      const result = kind === "create" ? await createStoreNodeEnrollment(requestContext, createInput!) : kind === "reissue" ?
        await reissueStoreNodeEnrollment(requestContext, selected!.nodeId, selected!.fence) : kind === "revoke" ?
          await revokeStoreNode(requestContext, selected!.nodeId, selected!.fence) : await bindStoreNode(requestContext, { ...selected!.fence, nodeId: selected!.nodeId });
      if (!valid(version) || operationId.current !== sequence || abort.signal.aborted) return;
      const next = "workspace" in result ? result.workspace : result, current = dataRef.current;
      const issued = "enrollment" in result ? result.enrollment : null;
      if (current && (current.authorizationGeneration !== next.authorizationGeneration || current.binding.revision > next.binding.revision ||
        issued && current.nodes.some(node => node.id === issued.nodeId && (node.certificateGeneration > issued.certificateGeneration || node.status === "revoked"))))
        throw new StoreNodeRequestError(409, "store_node_binding_changed", true);
      readId.current++; readController.current?.abort(); setReading(false); accept(next); setReview(null); setConfirmed(false);
      if (kind === "create") { setAttemptState("found"); setFormOpen(false); setPublicKey(""); setLabel(""); setPublicConfirmed(false); }
      if (issued && ticketVersion === secretEpoch.current) { setBundle(issued); setMessage("登记票据已创建 仅本次显示 关闭或重新读取后只能明确重新签发"); }
      else setMessage(issued ? "登记已完成 本次登记包已清除 请读取原节点并明确重新签发" : next.binding.state === "draining" ?
        "旧节点租约正在排空 到期后重新读取并再次明确绑定" : kind === "revoke" ? "节点证书已撤销 原租约排空期限仍保留" : "节点绑定已记录 不代表平台执行已接入");
    } catch (error) {
      if (!valid(version) || operationId.current !== sequence) return;
      const failure = error instanceof StoreNodeRequestError ? error : new StoreNodeRequestError(400);
      if (storeNodeDenied(failure)) { deny(storeNodeErrorMessage(failure)); return; }
      if (kind === "create" && attemptRef.current) setAttemptState("unknown");
      setUnverified(true); setMessage(storeNodeErrorMessage(failure));
    } finally { if (valid(version) && operationId.current === sequence) { pending.current = null; setBusy(null); } }
  }
  async function importKey(file: File | undefined) {
    const version = epoch.current, inputVersion = ++fileEpoch.current; if (!file) return;
    try { if (file.size > 8192) throw new Error(); const value = normalizeStoreNodePublicKey(new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()));
      if (valid(version) && inputVersion === fileEpoch.current) { clearBundle(); setPublicKey(value); setPublicConfirmed(false); } }
    catch { if (valid(version) && inputVersion === fileEpoch.current) setMessage("公钥文件格式需核对 仅接受公开 SPKI PEM 不接受私钥"); }
  }
  async function copyBundle() {
    if (!bundle || !valid() || Date.parse(bundle.expiresAt) <= clock) return; const version = epoch.current, ticketVersion = secretEpoch.current;
    try { await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2)); if (valid(version) && ticketVersion === secretEpoch.current) setCopyMessage("已复制本次登记包"); }
    catch { if (valid(version)) setCopyMessage("未能复制 可使用本机下载"); }
  }
  function downloadBundle() {
    if (!bundle || !valid() || Date.parse(bundle.expiresAt) <= clock) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
    try { const link = document.createElement("a"); link.href = url; link.download = `store-node-${bundle.nodeId}.json`; link.click(); setCopyMessage("已请求本机下载登记包"); }
    finally { URL.revokeObjectURL(url); }
  }
  const selectedReviewNode = data?.nodes.find(node => node.id === review?.nodeId), visibleBundle = bundle && Date.parse(bundle.expiresAt) > clock ? bundle : null;
  return <section className="store-node" aria-label="本店独立节点" aria-busy={reading || !!busy}>
    <header className="store-node-heading"><div><h2><Server size={16} />本店独立节点</h2><p>在线表示真实 mTLS 心跳 本区管理节点身份 能力同步由下方原任务单独执行</p></div>
      <button type="button" disabled={reading} onClick={() => void load(true)}><RefreshCw size={15} />重新读取节点状态</button></header>
    {message && <p className="store-node-notice" role="status">{message}</p>}
    {!data ? <p className="store-node-empty">{reading ? "正在核对本店节点与当前本人权限" : "节点资料尚未核对 旧资料与登记包已隐藏"}</p> : <>
      <dl className="store-node-facts"><Fact label="节点配置" value={data.configuration.enabled ? "已启用登记与心跳" : "节点服务配置未启用"} />
        <Fact label="绑定修订" value={String(data.binding.revision)} /><Fact label="当前绑定" value={data.binding.state === "unbound" ? "未绑定" : data.binding.state === "draining" ? "旧租约排空中" : data.binding.effective ? "当前授权下有效" : "当前不可用"} />
        <Fact label="状态截至" value={time(data.observedAt)} /><Fact label="原租约排空期限" value={time(data.binding.leaseExpiresAt)} /><Fact label="身份协议" value="仅节点身份与心跳" /></dl>
      {data.binding.authorizationGeneration && data.binding.authorizationGeneration !== data.authorizationGeneration && <p className="store-node-notice" role="status">原绑定来自旧授权代次 不能用于当前店铺执行</p>}
      {data.binding.state === "draining" && <p className="store-node-notice" role="status">旧证书失效不代表旧租约已排空 请等原期限结束后重新读取并再次绑定</p>}
      {unverified && <p className="store-node-notice">当前节点依据尚未重新核对 所有新操作已锁定</p>}
      <div className="store-node-list" aria-label="本店节点列表"><p className="store-node-caption">本次返回 {data.nodes.length} 个节点 列表最多 100 个 状态以本次原记录为准</p>
        {!data.nodes.length ? <p className="store-node-empty">本店尚无节点 请先在独立主机生成加密私钥与公开 SPKI 公钥 再创建登记票据</p> : data.nodes.map(node => <article key={node.id} aria-label={`节点 ${node.label}`}>
          <header><h3>{node.label}</h3><span className={storeNodeReachability(node, clock) === "在线" ? "store-node-online" : ""}>{storeNodeReachability(node, clock)}</span></header>
          <dl className="store-node-facts"><Fact label="登记状态" value={node.status === "pending_enrollment" ? "待登记" : node.status === "enrolled" ? "已登记" : "已撤销"} /><Fact label="证书代次" value={String(node.certificateGeneration)} />
            <Fact label="最后心跳" value={time(node.lastSeenAt)} /><Fact label="心跳租约期限" value={time(node.sessionExpiresAt)} /><Fact label="证书有效期" value={time(node.certificateExpiresAt)} />
            <Fact label="票据状态" value={({ none: "未签发", issued: "已签发", claimed: "正在登记", consumed: "已使用", expired: "已到期" })[node.ticketState]} /></dl>
          <details><summary>核对原节点与公钥标识</summary><dl className="store-node-identifiers"><Fact label="节点 ID" value={node.id} /><Fact label="公钥校验值" value={node.publicKeySpkiSha256} /><Fact label="证书指纹" value={node.certificateFingerprintSha256 ?? "未提供"} /><Fact label="原登记请求标识" value={node.creationRequestKey} /></dl></details>
          {canChange && <div className="store-node-actions"><button disabled={!ready || !!busy} onClick={() => openReview("reissue", node.id)}><KeyRound size={14} />重新签发登记票据</button>
            {node.status !== "revoked" && <button disabled={!readyFor("revoke") || !!busy} onClick={() => openReview("revoke", node.id)}><Unplug size={14} />核对撤销节点</button>}</div>}
        </article>)}
      </div>
      {canChange ? <div className="store-node-controls">
        <button disabled={!ready || !!busy || !!attempt} onClick={() => { clearBundle(); setFormOpen(value => !value); }}><FileKey2 size={15} />准备节点登记</button>
        {data.nodes.some(node => node.status === "enrolled") && <div className="store-node-binding"><label><span>待绑定节点</span><select value={selectedNode} disabled={!ready || !!busy} onChange={event => { clearBundle(); setReview(null); setConfirmed(false); setSelectedNode(event.target.value); }}><option value="">选择本店已登记节点</option>{data.nodes.filter(node => node.status === "enrolled").map(node => <option key={node.id} value={node.id}>{node.label}</option>)}</select></label>
          <button disabled={!ready || !!busy || !selectedNode} onClick={() => openReview("bind", selectedNode)}><Link2 size={14} />核对节点绑定</button></div>}
      </div> : <p className="store-node-caption">当前仅可读取节点 管理与授权权限须同时具备才能登记或变更绑定</p>}
      {formOpen && <form className="store-node-form" aria-label="创建节点登记票据" onSubmit={event => { event.preventDefault(); void mutate("create"); }}>
        <h3>创建节点登记票据</h3><p>在独立节点主机生成并保管加密私钥 此处仅提交公开 SPKI 公钥</p><fieldset disabled={!ready || !!busy || !!attempt}>
          <label><span>节点名称</span><input required maxLength={80} value={label} onChange={event => setLabel(event.target.value)} /></label>
          <label><span>读取公钥文件</span><input type="file" accept=".pem,.pub,text/plain" onChange={event => void importKey(event.target.files?.[0])} /></label>
          <label className="store-node-wide"><span>节点公钥 PEM</span><textarea required rows={7} maxLength={8192} spellCheck={false} autoComplete="off" value={publicKey} onChange={event => { fileEpoch.current++; setPublicKey(event.target.value); setPublicConfirmed(false); }} /></label>
          <label className="store-node-check store-node-wide"><input type="checkbox" required checked={publicConfirmed} onChange={event => setPublicConfirmed(event.target.checked)} /><span>已在节点主机保管私钥 本页只提交公开公钥</span></label>
          <button type="submit"><ShieldCheck size={15} />{busy === "create" ? "正在创建原登记票据" : "创建一次性登记票据"}</button></fieldset>
        <button type="button" onClick={() => { clearBundle(); setFormOpen(false); }}>关闭填写</button></form>}
      {attempt && <section className="store-node-recovery" aria-label="原节点登记请求"><h3>原节点登记请求</h3><Fact label="原请求标识" value={attempt.idempotencyKey} />
        <p>{attemptState === "found" ? "已读取到原节点 登记包只显示一次 丢失后需明确重新签发" : "本页保留原正文和原键 刷新后仅能读取节点列表核对 不会自动重发"}</p>
        <div className="store-node-actions"><button disabled={reading} onClick={() => void load(true)}><RefreshCw size={14} />只读取原节点状态</button>
          {attemptState === "unknown" && <button disabled={!ready || !!busy} onClick={() => void mutate("create", attempt)}><RefreshCw size={14} />使用原登记请求重试</button>}
          {attemptState === "found" && <button onClick={() => { clearBundle(); attemptRef.current = null; setAttempt(null); setAttemptState(null); setFormOpen(false); setLabel(""); setPublicKey(""); setPublicConfirmed(false); }}>结束本次登记核对</button>}</div></section>}
      {review && selectedReviewNode && <section className="store-node-review" aria-label="核对节点变更"><h3>{review.kind === "bind" ? "核对本店节点绑定" : review.kind === "reissue" ? "核对重新签发" : "核对撤销节点"}</h3>
        <p>{selectedReviewNode.label}</p><dl className="store-node-facts"><Fact label="原节点 ID" value={review.nodeId} /><Fact label="原证书代次" value={String(review.fence.expectedCertificateGeneration)} /><Fact label="原绑定修订" value={String(review.fence.expectedBindingRevision)} /><Fact label="原授权代次" value={review.fence.expectedAuthorizationGeneration} /></dl>
        <p>{review.kind === "bind" ? "旧节点仍有租约时会先进入排空 到期后需要重新读取并再次明确换绑" : "本操作立即使旧证书和旧票据失效 仍保留原租约排空期限 不会执行平台操作"}</p>
        {review.kind === "revoke" && !data.configuration.enabled && <p>节点服务未启用 仍可立即废除原证书的授权记录</p>}
        <label className="store-node-check"><input type="checkbox" checked={confirmed} disabled={!!busy} onChange={event => setConfirmed(event.target.checked)} /><span>已核对本店 原节点与本次变更</span></label>
        <div className="store-node-actions"><button disabled={!readyFor(review.kind) || !!busy || !confirmed} onClick={() => void mutate(review.kind)}>{busy ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{review.kind === "bind" ? "确认绑定节点" : review.kind === "reissue" ? "确认重新签发登记票据" : "确认撤销节点"}</button>
          <button disabled={!!busy} onClick={() => { setReview(null); setConfirmed(false); }}>取消本次核对</button></div></section>}
      {visibleBundle && <section className="store-node-bundle" aria-label="本次节点登记包" data-private-secret><h3><KeyRound size={16} />本次节点登记包</h3><p>含一次性登记票据 关闭 重新读取 刷新页面或退出后不再显示 不会保存到浏览器存储</p>
        <Fact label="票据有效期" value={time(visibleBundle.expiresAt)} /><textarea aria-label="一次性节点登记包" readOnly rows={7} value={JSON.stringify(visibleBundle, null, 2)} spellCheck={false} autoComplete="off" />
        <div className="store-node-actions"><button onClick={() => void copyBundle()}><Copy size={14} />复制登记包</button><button onClick={downloadBundle}><Download size={14} />下载登记包</button><button onClick={clearBundle}><X size={14} />清除此登记包</button></div>
        {copyMessage && <p role="status"><CheckCheck size={14} />{copyMessage}</p>}</section>}
    </>}
  </section>;
}
function Fact({ label, value }: { label: string; value: string }) { return <div><dt>{label}</dt><dd>{value}</dd></div>; }
function time(value: string | null) { return value === null ? "未提供" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
