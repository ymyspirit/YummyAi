import type { ProductionEditorImageLayer } from "@yummyai/contracts/pod/production-editor";
import type { PillowAlphaMask } from "@yummyai/production-editor/pillow-outline";
export * from "@yummyai/production-editor/pillow-outline";

export async function samplePillowImage(url: string, layer: ProductionEditorImageLayer, whiteBorderMm: number): Promise<PillowAlphaMask> {
  const image = new Image(); image.referrerPolicy = "no-referrer";
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("图稿原图预览读取失败，请刷新项目后重试。")); image.src = url; });
  const radians = layer.rotationDeg * Math.PI / 180;
  const corners = [[0, 0], [layer.widthMm, 0], [layer.widthMm, layer.heightMm], [0, layer.heightMm]].map(([x, y]) => [layer.xMm + x! * Math.cos(radians) - y! * Math.sin(radians), layer.yMm + x! * Math.sin(radians) + y! * Math.cos(radians)]);
  const minX = Math.min(...corners.map(([x]) => x!)), maxX = Math.max(...corners.map(([x]) => x!));
  const minY = Math.min(...corners.map(([, y]) => y!)), maxY = Math.max(...corners.map(([, y]) => y!));
  const mmPerPixel = Math.max(0.2, (Math.max(maxX - minX, maxY - minY) + whiteBorderMm * 2) / 980);
  const pad = whiteBorderMm + mmPerPixel * 8;
  const originX = minX - pad, originY = minY - pad;
  const width = Math.ceil((maxX - minX + pad * 2) / mmPerPixel), height = Math.ceil((maxY - minY + pad * 2) / mmPerPixel);
  const canvas = window.document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("图稿采样画布无法启动。");
  context.scale(1 / mmPerPixel, 1 / mmPerPixel);
  context.translate(layer.xMm - originX, layer.yMm - originY); context.rotate(radians);
  context.translate(layer.flipX ? layer.widthMm : 0, layer.flipY ? layer.heightMm : 0); context.scale(layer.flipX ? -1 : 1, layer.flipY ? -1 : 1);
  context.drawImage(image, 0, 0, layer.widthMm, layer.heightMm);
  const rgba = context.getImageData(0, 0, width, height).data;
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3]!;
  return { alpha, width, height, mmPerPixel, originX, originY };
}
