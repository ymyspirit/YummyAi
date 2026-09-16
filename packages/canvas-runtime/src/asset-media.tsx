import { useEffect, useRef, useState } from "react";
import type { Asset } from "@/stores/use-asset-store";
import { resolveImageUrl } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";
import { notify, rpc } from "./rpc";

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
async function preview(key: string) {
  const cached = previews.get(key);
  if (cached) return cached;
  let pending = pendingPreviews.get(key);
  if (!pending) {
    pending = rpc<{ contentBase64: string; mediaType: string }>({ operation: "asset.preview", namespace: "image_files", key }).then(result => {
      const url = `data:${result.mediaType};base64,${result.contentBase64}`;
      // Bound the per-project in-memory preview cache. Originals stay in the
      // existing versioned storage path and are never replaced with thumbnails.
      if (previews.size >= 64) previews.delete(previews.keys().next().value!);
      previews.set(key, url);
      return url;
    }).finally(() => pendingPreviews.delete(key));
    pendingPreviews.set(key, pending);
  }
  return pending;
}

export function AssetThumbnail({ asset, className = "aspect-[4/3] w-full object-cover" }: { asset: Asset; className?: string }) {
  const root = useRef<HTMLSpanElement>(null), [visible, setVisible] = useState(false), [url, setUrl] = useState(""), [error, setError] = useState(false);
  const key = asset.kind === "image" ? asset.data.storageKey : undefined;
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
    setUrl(""); setError(false);
    if (key) void preview(key).then(value => { if (live) setUrl(value); }).catch(() => { if (live) setError(true); });
    else if (fallback && !fallback.startsWith("blob:")) setUrl(fallback);
    // Freshly uploaded blobs are already available in this runtime.
    else if (fallback.startsWith("blob:")) setUrl(fallback);
    return () => { live = false; };
  }, [key, visible, fallback]);
  return <span ref={root} className={`studio-asset-thumbnail ${className}`}>
    {url ? <img src={url} alt={asset.title} loading="lazy" className="size-full object-cover" /> : <span>{error ? "预览未能读取，可点击查看原文件" : asset.kind === "video" ? "视频 · 点击查看" : asset.kind === "text" ? asset.data.content : "预览读取中…"}</span>}
  </span>;
}

export async function withAssetOriginal(asset: Asset, action: (resolved: Asset) => void) {
  try {
    if (asset.kind === "text" || !asset.data.storageKey) { action(asset); return; }
    if (asset.kind === "image") {
      const dataUrl = await resolveImageUrl(asset.data.storageKey, "");
      if (!dataUrl) throw new Error("素材原文件不存在，请检查项目素材。");
      action({ ...asset, data: { ...asset.data, dataUrl } });
    } else {
      const url = await resolveMediaUrl(asset.data.storageKey, "");
      if (!url) throw new Error("素材原文件不存在，请检查项目素材。");
      action({ ...asset, data: { ...asset.data, url } });
    }
  } catch (cause) { notify("studio.error", { error: cause instanceof Error ? cause.message : "素材读取失败，请重试" }); }
}
