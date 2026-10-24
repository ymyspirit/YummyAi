import { useLayoutEffect, useState } from "react";
import { canvasLifecycles, createCanvasIfAllowed } from "./canvas-lifecycle";
import { rpc } from "./rpc";
import { decodeBlob } from "./storage";
import { CanvasNodeType, type CanvasNodeData, type CanvasAssistantSession } from "@/types/canvas";
import { createCanvasDisplayUrl, restoreLegacyImage, revokeCanvasDisplayUrl } from "./canvas-legacy-media";
import { Dropdown } from "antd";
import { FolderOpen, Menu, Plus } from "lucide-react";
import { useStudioModels } from "./model-state";
import { attachStudioDraftFlushes, releaseStudioDraftOwner } from "./studio-draft-flush";

export function useCanvasLease(id: string) {
  const [lease] = useState(() => attachStudioDraftFlushes(canvasLifecycles.create(id)));
  useLayoutEffect(() => { lease.activate(); return () => releaseStudioDraftOwner(() => lease.canSave() && useStudioModels.getState().canSave, lease.beforeRelease, lease.release); }, [lease]);
  return lease;
}
type Lease = ReturnType<typeof canvasLifecycles.create>;
const check = (lease: Lease, current: () => boolean) => { if (!lease.current() || !current()) throw new DOMException("原画布读取已结束", "AbortError"); };
async function originalUrl(key: string, namespace: "image_files" | "media_files", lease: Lease, current: () => boolean, urls: string[], original: { present: boolean; value?: string }) {
  check(lease, current);
  const result = await rpc<{ media?: { contentBase64: string; mediaType: string } }>({ operation: "state.get", namespace, key }, { signal: lease.signal });
  check(lease, current);
  if (!result.media) throw new Error("原画布引用的文件暂时不可读取");
  const url = createCanvasDisplayUrl(decodeBlob(result.media), original); urls.push(url); return url;
}
export async function restoreCanvasMedia(nodes: CanvasNodeData[], sessions: CanvasAssistantSession[], lease: Lease, current: () => boolean) {
  const urls: string[] = [];
  const hydrate = async <T extends { content?: string; storageKey?: string }>(item: T, namespace: "image_files" | "media_files") => {
    check(lease, current);
    if (item.storageKey) return { ...item, content: await originalUrl(item.storageKey, namespace, lease, current, urls, { present: Object.hasOwn(item, "content"), value: item.content }) };
    if (namespace === "image_files" && item.content?.startsWith("data:image/")) return { ...item, content: restoreLegacyImage(item.content, lease.signal, current) };
    return item;
  };
  try {
    const restoredNodes = await Promise.all(nodes.map(async node => {
      check(lease, current); const metadata = node.metadata;
      if (!metadata) return node;
      if (node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) return { ...node, metadata: await hydrate(metadata, "media_files") };
      if (node.type !== CanvasNodeType.Image) return node;
      const images = metadata.images ? await Promise.all(metadata.images.map(image => hydrate(image, "image_files"))) : undefined;
      const restored = await hydrate(metadata, "image_files");
      check(lease, current);
      return { ...node, metadata: images ? { ...restored, images } : restored };
    }));
    const restoredSessions = await Promise.all(sessions.map(async session => ({ ...session, messages: await Promise.all(session.messages.map(async message => ({ ...message,
      ...(message.references ? { references: await Promise.all(message.references.map(async reference => {
        check(lease, current);
        if (reference.storageKey) return { ...reference, dataUrl: await originalUrl(reference.storageKey, "image_files", lease, current, urls, { present: Object.hasOwn(reference, "dataUrl"), value: reference.dataUrl }) };
        if (reference.dataUrl?.startsWith("data:image/")) return { ...reference, dataUrl: restoreLegacyImage(reference.dataUrl, lease.signal, current) };
        return reference;
      })) } : {}),
    }))) })));
    check(lease, current);
    const revoke = () => { for (const url of urls.splice(0)) revokeCanvasDisplayUrl(url); };
    lease.signal.addEventListener("abort", revoke, { once: true });
    return { nodes: restoredNodes, sessions: restoredSessions };
  } catch (cause) { for (const url of urls) revokeCanvasDisplayUrl(url); throw cause; }
}
export function CanvasRestoreNotice({ error, retry, onProjects, onCreate }: { error: string; retry: () => void; onProjects: () => void; onCreate: () => void }) {
  const canSave = useStudioModels(state => state.canSave);
  return <div className="studio-editor-error" role="status"><Dropdown trigger={["click"]} menu={{ items: [
    { key: "projects", label: "画布列表", icon: <FolderOpen size={15} />, onClick: onProjects },
    { key: "new", label: "新建画布", icon: <Plus size={15} />, disabled: !canSave, onClick: () => createCanvasIfAllowed(() => useStudioModels.getState().canSave, onCreate) },
  ] }}><button type="button" aria-label="画布菜单"><Menu size={16} /></button></Dropdown>{error ? <><p>{error}</p><p>原节点 连接和视图保持 未保存空白画布</p><button type="button" onClick={retry}>重新读取原画布</button></> : <p>正在读取原画布及媒体</p>}</div>;
}
