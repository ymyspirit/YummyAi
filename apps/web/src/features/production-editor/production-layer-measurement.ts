import type { ProductionEditorLayer } from "@yummyai/contracts/pod/production-editor";
import { parseProductionFont } from "@yummyai/production-editor/text";
import type { Font } from "opentype.js";

import { alphaBounds, imageSubjectBounds, type LayerBounds } from "./production-layout-tools";
import { productionTextPath } from "./production-text-path";

/** Project-scoped, in-memory caches only. Never persist customer image pixels in browser storage. */
export function createLayerMeasurement() {
  const images = new Map<string, Promise<LayerBounds>>();
  const fonts = new Map<string, Promise<Font>>();
  async function font(projectId: string, fontId: string) {
    const key = `${projectId}:${fontId}`;
    if (!fonts.has(key)) fonts.set(key, (async () => {
      const response = await fetch(`/api/production-editor/projects/${encodeURIComponent(projectId)}/fonts/${encodeURIComponent(fontId)}`, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error("图稿字体未加载，请稍后重试。");
      return parseProductionFont(await response.arrayBuffer());
    })().catch((cause) => { fonts.delete(key); throw cause; }));
    return fonts.get(key)!;
  }
  async function measure(projectId: string, layer: ProductionEditorLayer): Promise<LayerBounds> {
    if (layer.kind === "image") {
      const key = `${projectId}:${layer.assetId}:${layer.assetVersion}`;
      if (!images.has(key)) images.set(key, readImageBounds(`/api/production-editor/projects/${encodeURIComponent(projectId)}/images/${encodeURIComponent(layer.assetId)}?kind=preview`).catch((cause) => { images.delete(key); throw cause; }));
      return imageSubjectBounds(layer, await images.get(key)!);
    }
    const [loadedFont, fabric] = await Promise.all([font(projectId, layer.fontId), import("fabric")]);
    const path = productionTextPath(loadedFont, layer, fabric);
    if (!path.trim()) throw new Error("图稿中的所选文字没有可见字形，请先填写文字。");
    const a = layer.rotationDeg * Math.PI / 180;
    const transformed = fabric.util.transformPath(fabric.util.makePathSimpler(fabric.util.parsePath(path)), [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), layer.xMm, layer.yMm], new fabric.Point(0, 0));
    const object = new fabric.Path(transformed, { originX: "left", originY: "top", strokeWidth: 0 });
    return { x: object.left, y: object.top, width: object.width, height: object.height };
  }
  return { measure, font, clear: () => { images.clear(); fonts.clear(); } };
}
async function readImageBounds(url: string): Promise<LayerBounds> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image(); img.referrerPolicy = "no-referrer";
    const timeout = setTimeout(() => { img.src = ""; reject(new Error("图稿图片读取超时，请稍后重试。")); }, 30_000);
    img.onload = () => { clearTimeout(timeout); resolve(img); };
    img.onerror = () => { clearTimeout(timeout); reject(new Error("图稿图片未加载，请检查素材后重试。")); };
    img.src = url;
  });
  const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("图稿图片暂时无法测量，请刷新页面重试。");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return alphaBounds(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
}
