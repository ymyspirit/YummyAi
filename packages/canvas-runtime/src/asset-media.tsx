import { useEffect, useRef, useState } from "react";
import type { Asset } from "@/stores/use-asset-store";
import { initialized, notify, rpc } from "./rpc";
import { createOriginalFactsUpdates, createOriginalInspector, originalFacts, originalWorkspaceIdentity, verifiedMediaProjection } from "./original-inspection";
import { decodeBlob } from "./storage";
import type { StudioWorkspace } from "@yummyai/contracts/pod/studio-personal";
import type { StudioOriginalInspection } from "@yummyai/contracts/pod/studio-original";
import { canvasLifecycles } from "./canvas-lifecycle";
import { catalogueAssetId, cataloguePreviewIdentity } from "./asset-catalogue";
import { createCanvasDisplayUrl, revokeCanvasDisplayUrl } from "./canvas-legacy-media";

const inspector = createOriginalInspector((request, signal) => rpc(request, { signal }));
let workspaceKey = "";
const originalUrls = new Map<string, string>();
function configureOriginals(workspace?: StudioWorkspace) {
  const key = originalWorkspaceIdentity(workspace);
  if (key !== workspaceKey) { for (const url of originalUrls.values()) revokeCanvasDisplayUrl(url); originalUrls.clear(); workspaceKey = key; }
  inspector.configure(workspace);
}
void initialized.then(init => configureOriginals(init.workspace));
window.addEventListener("studio.workspace", event => configureOriginals((event as CustomEvent).detail.workspace));
type MediaAsset = Exclude<Asset, { kind: "text" }>;
function address(asset: MediaAsset) {
  if (!asset.data.storageKey) throw new Error("此素材尚未保存原文件 请先保存后核对");
  return { key: asset.data.storageKey, namespace: asset.kind === "image" ? "image_files" as const : "media_files" as const,
    ...(catalogueAssetId(asset) ? { assetId: catalogueAssetId(asset) } : {}) };
}
export function AssetOriginalFacts({ asset }: { asset: Asset }) {
  const [updates] = useState(() => createOriginalFactsUpdates(workspaceKey));
  const element = useRef<HTMLSpanElement>(null), [visible, setVisible] = useState(false), [inspection, setInspection] = useState<StudioOriginalInspection>(), [error, setError] = useState(""), [owner, setOwner] = useState(updates.key);
  const key = asset.kind === "text" ? undefined : asset.data.storageKey, originalAssetId = catalogueAssetId(asset);
  const mediaType = asset.kind === "text" ? undefined : asset.data.mimeType;
  useEffect(() => {
    const update = () => { const next = updates.workspace(workspaceKey); if (next !== undefined) setOwner(next); };
    const refresh = () => setOwner(updates.refresh());
    update();
    window.addEventListener("studio.workspace", update); window.addEventListener("studio.refresh", refresh);
    return () => { window.removeEventListener("studio.workspace", update); window.removeEventListener("studio.refresh", refresh); };
  }, [updates]);
  useEffect(() => {
    if (!element.current) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: "120px" });
    observer.observe(element.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || asset.kind === "text") return;
    const controller = new AbortController(); setInspection(undefined); setError("");
    void initialized.then(() => inspector.inspect(address(asset), controller.signal)).then(value => { if (!controller.signal.aborted) setInspection(value); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "原件核对暂未完成"); });
    return () => controller.abort();
  }, [visible, key, originalAssetId, asset.id, asset.kind, mediaType, owner]);
  const currentInspection = inspection && (!originalAssetId || inspection.source.assetId === originalAssetId) && asset.kind !== "text" && inspection.source.mediaType === asset.data.mimeType ? inspection : undefined;
  return <span ref={element} data-studio-original-key={key}>{asset.kind === "text" ? asset.data.content : error || originalFacts(currentInspection)}</span>;
}

// Object URLs belong to this document. Persist keys, never temporary URLs or
// a second copy of a stored original in the asset catalogue.
export function assetMetadata(asset: Asset): Asset {
  if (asset.kind === "text" || !asset.data.storageKey) return asset;
  const original = asset.kind === "image" ? asset.data.dataUrl : asset.data.url;
  const coverUrl = asset.coverUrl.startsWith("blob:") || asset.coverUrl === original ? "" : asset.coverUrl;
  return asset.kind === "image"
    ? { ...asset, coverUrl, data: { ...asset.data, dataUrl: "" } }
    : { ...asset, coverUrl, data: { ...asset.data, url: "" } };
}

const previews = new Map<string, string>();
const pendingPreviews = new Map<string, Promise<string>>();
async function preview(key: string, identity: string) {
  const cacheKey = `${identity}/${key}`;
  const cached = previews.get(cacheKey);
  if (cached) return cached;
  let pending = pendingPreviews.get(cacheKey);
  if (!pending) {
    pending = rpc<{ contentBase64: string; mediaType: string }>({ operation: "asset.preview", namespace: "image_files", key }).then(result => {
      const url = `data:${result.mediaType};base64,${result.contentBase64}`;
      // Bound the per-project in-memory preview cache. Originals stay in the
      // existing versioned storage path and are never replaced with thumbnails.
      if (previews.size >= 64) previews.delete(previews.keys().next().value!);
      previews.set(cacheKey, url);
      return url;
    }).finally(() => pendingPreviews.delete(cacheKey));
    pendingPreviews.set(cacheKey, pending);
  }
  return pending;
}

export function AssetThumbnail({ asset, className = "aspect-[4/3] w-full object-cover" }: { asset: Asset; className?: string }) {
  const root = useRef<HTMLSpanElement>(null), [visible, setVisible] = useState(false), [url, setUrl] = useState(""), [urlOwner, setUrlOwner] = useState(""), [error, setError] = useState(false);
  const key = asset.kind === "image" ? asset.data.storageKey : undefined;
  const originalIdentity = cataloguePreviewIdentity(asset);
  const fallback = asset.coverUrl || (asset.kind === "image" ? asset.data.dataUrl : "");
  useEffect(() => {
    if (!root.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "120px" });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let live = true;
    setUrl(""); setUrlOwner(originalIdentity); setError(false);
    if (key) void preview(key, originalIdentity).then(value => { if (live) setUrl(value); }).catch(() => { if (live) setError(true); });
    else if (fallback && !fallback.startsWith("blob:")) setUrl(fallback);
    // Freshly uploaded blobs are already available in this runtime.
    else if (fallback.startsWith("blob:")) setUrl(fallback);
    return () => { live = false; };
  }, [key, originalIdentity, visible, fallback]);
  const currentUrl = urlOwner === originalIdentity ? url : "";
  return <span ref={root} className={`studio-asset-thumbnail ${className}`}>
    {currentUrl ? <img src={currentUrl} alt={asset.title} loading="lazy" className="size-full object-cover" /> : <span>{error ? "预览未能读取，可点击查看原文件" : asset.kind === "video" ? "视频 · 点击查看" : asset.kind === "text" ? asset.data.content : "预览读取中…"}</span>}
  </span>;
}

export async function withAssetOriginal(asset: Asset, action: (resolved: Asset) => void, requireDimensions = false) {
  const canvasOperation = requireDimensions ? canvasLifecycles.captureOperation() : undefined;
  const originalCanvas = canvasOperation?.current ?? (() => true);
  const owner = workspaceKey;
  try {
    if (!originalCanvas()) return;
    if (asset.kind === "text") { action(asset); return; }
    if (!asset.data.storageKey) { if (requireDimensions) throw new Error("此素材尚未保存原文件 暂不能插入画布"); action(asset); return; }
    const inspection = await inspector.inspect(address(asset), canvasOperation?.signal);
    if (owner !== workspaceKey || !originalCanvas()) return;
    const projection = inspection.technical.status === "verified" && inspection.technical.kind !== "audio" ? verifiedMediaProjection(inspection) : undefined;
    if (requireDimensions && !projection) throw new Error("原件尺寸尚未通过核对 暂不能插入画布");
    const source = inspection.source;
    const result = await rpc<{ revision: number; assetId?: string; media?: { contentBase64: string; mediaType: string } }>({ operation: "state.get", namespace: source.namespace, key: asset.data.storageKey }, { signal: canvasOperation?.signal });
    if (owner !== workspaceKey || !originalCanvas()) return;
    if (result.revision !== source.revision || result.assetId !== source.assetId || result.media?.mediaType !== source.mediaType) throw new Error("素材原件已变化 请刷新后重新核对");
    const blob = decodeBlob(result.media), bytes = await blob.arrayBuffer();
    const checksum = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    if (owner !== workspaceKey || !originalCanvas()) return;
    if (blob.size !== source.byteSize || checksum !== source.checksumSha256) throw new Error("素材原件与检查结果不一致 请重新读取");
    const pin = JSON.stringify(source);
    let url = originalUrls.get(pin);
    if (!url) { url = createCanvasDisplayUrl(blob); originalUrls.set(pin, url); }
    const data = { ...asset.data, ...(projection ?? {}), bytes: source.byteSize, mimeType: source.mediaType };
    action(asset.kind === "image" ? { ...asset, data: { ...data, dataUrl: url } } as Asset : { ...asset, data: { ...data, url } } as Asset);
  } catch (cause) {
    if (owner !== workspaceKey || !originalCanvas() || cause instanceof Error && cause.name === "AbortError") return;
    notify("studio.error", { error: cause instanceof Error ? cause.message : "素材读取失败，请重试" });
  }
}
