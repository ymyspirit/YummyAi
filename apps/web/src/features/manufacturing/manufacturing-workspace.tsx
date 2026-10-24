"use client";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Boxes, Plus, RefreshCw } from "lucide-react";
import { flushSync } from "react-dom";
import { z } from "zod";
import { ManufacturingRecipeListSchema, ManufacturingReferencesSchema, ManufacturingRecipeWorkspaceSchema,
  type ManufacturingReferences, type ManufacturingRecipeWorkspace } from "@yummyai/contracts/catalog/manufacturing";
import { Permission } from "@yummyai/authz/permissions";
import { useErpAccess } from "../identity/erp-access";
import { clearTaskDrafts } from "../navigation/task-draft";
import { cancelViewTransitions } from "../navigation/view-transition";
import { useWorkflowReturn } from "../navigation/use-workflow-return";
import { workflowHref } from "../navigation/workflow-href";
import { ManufacturingEditor } from "./manufacturing-editor";
import { ManufacturingContextChanged, ManufacturingRequestError, manufacturingRequest } from "./manufacturing-api";
import "./manufacturing.css";
type Listing = z.infer<typeof ManufacturingRecipeListSchema>;
type Loaded = { references: ManufacturingReferences; listing: Listing; workspace: ManufacturingRecipeWorkspace | null };
export function ManufacturingWorkspace() { return <Suspense fallback={<main className="mf-page"><p role="status">正在读取制造模板</p></main>}><WorkspaceQuery /></Suspense>; }
function WorkspaceQuery() {
  const query = useSearchParams(), access = useErpAccess(), spuId = query.get("spuId"), recipeId = query.get("recipe"), newMode = query.get("new") === "1", specificationId = query.get("specificationId");
  if (!z.uuidv7().safeParse(spuId).success || recipeId && !z.uuidv7().safeParse(recipeId).success || recipeId && newMode || specificationId && !z.uuidv7().safeParse(specificationId).success)
    return <main className="mf-page"><h1>制造模板</h1><p className="mf-notice">请从具体SPU或产品规格打开制造模板</p><Link className="oc-button" href="/product-specifications">查看商品规格</Link></main>;
  if (!access.authority) return <main className="mf-page"><p role="status">正在核对当前身份</p></main>;
  return <ManufacturingScope key={`${access.preferenceScope}:${access.authority}:${spuId}:${recipeId}:${newMode}:${specificationId}`}
    spuId={spuId!} recipeId={recipeId} newMode={newMode} specificationId={specificationId} authority={access.authority}
    actorScope={access.preferenceScope ?? "local-development"} localDevelopment={access.localDevelopment} />;
}
function ManufacturingScope({ spuId, recipeId, newMode, specificationId, authority, actorScope, localDevelopment }: {
  spuId: string; recipeId: string | null; newMode: boolean; specificationId: string | null; authority: string; actorScope: string; localDevelopment: boolean;
}) {
  const router = useRouter(), workflow = useWorkflowReturn(), { can } = useErpAccess();
  const scopePrefix = `${actorScope}:manufacturing:${spuId}`, formScope = `${scopePrefix}:${recipeId ?? "new:" + (specificationId ?? "unselected")}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null), [phase, setPhase] = useState<"loading" | "ready" | "error" | "denied" | "identity">("loading");
  const [error, setError] = useState(""), [listError, setListError] = useState(""), [paging, setPaging] = useState(false), [refresh, setRefresh] = useState(0);
  const generation = useRef(0), live = useRef(true), active = useRef<AbortController | null>(null), pageRead = useRef<AbortController | null>(null);
  const href = useCallback((id: string | null, create = false, spec?: string) => {
    const params = new URLSearchParams({ spuId }); if (id) params.set("recipe", id); if (create) params.set("new", "1"); if (spec) params.set("specificationId", spec);
    return workflowHref(`/manufacturing-recipes?${params}`, workflow.current);
  }, [spuId, workflow.current]);
  const accessChanged = useCallback(() => {
    cancelViewTransitions(); active.current?.abort(); pageRead.current?.abort(); generation.current++;
    flushSync(() => setPhase("identity"));
  }, []);
  const denied = useCallback(() => {
    cancelViewTransitions(); flushSync(() => { setPhase("denied"); setLoaded(null); }); clearTaskDrafts(scopePrefix);
  }, [scopePrefix]);
  const load = useCallback(async () => {
    const version = ++generation.current; active.current?.abort(); pageRead.current?.abort();
    const abort = new AbortController(); active.current = abort;
    setPhase("loading"); setError(""); setListError(""); setPaging(false);
    try {
      const [references, listing, workspace] = await Promise.all([
        manufacturingRequest(`/references?${new URLSearchParams({ spuId })}`, ManufacturingReferencesSchema, authority, localDevelopment, { signal: abort.signal }),
        manufacturingRequest(`?${new URLSearchParams({ spuId, limit: "50" })}`, ManufacturingRecipeListSchema, authority, localDevelopment, { signal: abort.signal }),
        recipeId ? manufacturingRequest(`/${recipeId}`, ManufacturingRecipeWorkspaceSchema, authority, localDevelopment, { signal: abort.signal }) : Promise.resolve(null),
      ]);
      if (!live.current || abort.signal.aborted || version !== generation.current) return;
      if (references.spu.id !== spuId || workspace && workspace.spuId !== spuId) throw new ManufacturingContextChanged();
      setLoaded({ references, listing, workspace }); setPhase("ready");
    } catch (cause) {
      if (!live.current || abort.signal.aborted || version !== generation.current) return;
      if (cause instanceof ManufacturingContextChanged || cause instanceof ManufacturingRequestError && cause.status === 409) accessChanged();
      else if (cause instanceof ManufacturingRequestError && [401, 403, 404].includes(cause.status ?? 0)) denied();
      else { setPhase("error"); setError(cause instanceof Error ? cause.message : "制造资料暂时无法读取 请重试"); }
    }
  }, [accessChanged, authority, denied, localDevelopment, recipeId, spuId]);
  useEffect(() => {
    live.current = true; void load();
    const focus = () => { if (document.visibilityState !== "hidden") void load(); };
    window.addEventListener("focus", focus); window.addEventListener("pageshow", focus);
    return () => { live.current = false; generation.current++; active.current?.abort(); pageRead.current?.abort(); window.removeEventListener("focus", focus); window.removeEventListener("pageshow", focus); };
  }, [load]);
  const reload = useCallback(() => { setRefresh(n => n + 1); void load(); }, [load]);
  async function more() {
    if (!loaded?.listing.nextCursor || paging || phase !== "ready") return;
    const version = generation.current, abort = new AbortController(); pageRead.current?.abort(); pageRead.current = abort;
    setPaging(true); setListError("");
    try {
      const next = await manufacturingRequest(`?${new URLSearchParams({ spuId, after: loaded.listing.nextCursor, limit: "50" })}`, ManufacturingRecipeListSchema, authority, localDevelopment, { signal: abort.signal });
      if (!live.current || abort.signal.aborted || generation.current !== version) return;
      setLoaded(current => current ? { ...current, listing: { items: [...new Map([...current.listing.items, ...next.items].map(row => [row.id, row])).values()], nextCursor: next.nextCursor } } : current);
    } catch (cause) {
      if (!live.current || abort.signal.aborted || generation.current !== version) return;
      if (cause instanceof ManufacturingContextChanged) accessChanged();
      else if (cause instanceof ManufacturingRequestError && [401, 403, 404].includes(cause.status ?? 0)) denied();
      else setListError(cause instanceof Error ? cause.message : "更多模板暂时无法读取");
    } finally { if (live.current && !abort.signal.aborted && generation.current === version) setPaging(false); }
  }
  if (phase === "identity") return <main className="mf-page"><h1>制造模板</h1><p className="mf-notice" role="alert">当前资料或权限范围已变化 内容已隐藏 请重新核对</p><button className="oc-button" type="button" onClick={() => window.location.reload()}>重新核对身份与资料</button></main>;
  if (phase === "denied") return <main className="mf-page"><h1>制造模板</h1><p role="alert">此产品或制造记录当前不可读取 私有填写已清除</p><Link className="oc-button" href="/product-specifications">返回商品规格</Link></main>;
  const references = loaded?.references, resource = references ? { ownerId: references.spu.ownerId, teamId: references.spu.teamId } : undefined;
  const createAllowed = !!references?.spu.active && !!references.specifications.length && references.canReadMaterials && can(Permission.ProductWrite, resource);
  return <main className="mf-page"><header className="mf-header"><div><span className="mf-eyebrow"><Boxes size={16} />产品制造</span><h1>制造模板</h1>
    {references && <p>{references.spu.code} · {references.spu.name}</p>}</div><div className="mf-actions">
      <Link className="oc-button" href={workflowHref(`/product-specifications?${new URLSearchParams({ spu: spuId })}`, workflow.current)}>返回SPU规格</Link>
      <button className="oc-button" type="button" disabled={phase === "loading"} onClick={reload}><RefreshCw size={14} />重新读取</button>
    </div></header>
    {phase === "loading" && <p role="status" className="mf-notice">正在核对当前产品与制造版本 填写将保留</p>}
    {error && <p role="alert" className="mf-error">{error} <button className="oc-button" type="button" onClick={reload}>重试资料读取</button></p>}
    {references && !!references.sourceProblems.length && <ul className="mf-problems" aria-label="产品当前限制">{references.sourceProblems.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
    {loaded && references && <div className="mf-layout"><aside className="mf-templates" aria-label="本SPU制造模板"><div className="mf-aside-title"><h2>本SPU模板</h2>{createAllowed
      ? <Link className="oc-button primary" href={href(null, true)}><Plus size={14} />新建</Link>
      : <button className="oc-button" type="button" disabled><Plus size={14} />新建</button>}</div>
      {!loaded.listing.items.length && <p className="mf-empty">尚无制造模板 {createAllowed ? "可新建并先保存未知草稿" : "请联系可维护产品与物料的成员"}</p>}
      <ul>{loaded.listing.items.map(row => <li key={row.id}><Link className={`mf-template${row.id === recipeId ? " active" : ""}`} href={href(row.id)} aria-current={row.id === recipeId ? "page" : undefined}>
        <strong>{row.code}</strong><span>当前 V{row.versionNumber}</span></Link></li>)}</ul>
      {listError && <p role="alert" className="mf-error">{listError}</p>}{loaded.listing.nextCursor && <button type="button" className="oc-button" disabled={paging || phase !== "ready"} onClick={() => void more()}>{paging ? "正在读取" : "更多模板"}</button>}
    </aside><div className="mf-main">
      {newMode || loaded.workspace ? <ManufacturingEditor key={formScope} references={references} workspace={loaded.workspace} recipeId={recipeId} initialSpecId={specificationId}
        ready={phase === "ready"} scope={formScope} authority={authority} localDevelopment={localDevelopment} refresh={refresh}
        onAccessChanged={accessChanged} onRefresh={reload} onSaved={version => {
          if (version.recipeId === recipeId) reload(); else router.replace(href(version.recipeId), { scroll: false });
        }} /> : <div className="mf-empty"><h2>选择制造模板</h2><p>打开已保存版本 或从具体规格新建一份制造模板</p></div>}
    </div></div>}
  </main>;
}
