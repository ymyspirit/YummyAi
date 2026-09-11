import { CANVAS_BRIDGE, type CanvasBrief } from "@yummyai/contracts/pod/canvas-bridge";
import type { CanvasAgentOp, CanvasNodeData } from "../vendor/canvas-sdk-types";

export function imageNodes(nodes: CanvasNodeData[]) {
  return nodes.filter((node) => node.type === "image" && typeof node.metadata?.content === "string" && /^(data:image\/(?:png|jpeg|webp);base64,|blob:|https?:\/\/)/.test(node.metadata.content));
}

export function briefOperations(brief: CanvasBrief, anchor: CanvasNodeData, existing: CanvasNodeData[], assets: Array<{ assetId: string; mediaType: string; contentBase64: string }>): CanvasAgentOp[] {
  const ops: CanvasAgentOp[] = [], occupied = new Set(existing.map((node) => node.id));
  const workflow = brief.workflow;
  const left = anchor.position.x + anchor.width + 100 + (workflow?.stepIndex ?? 0) * 1100;
  const top = anchor.position.y + (workflow ? 240 : 0);
  if (workflow) {
    workflow.template.steps.forEach((step, index) => {
      const id = `yummyai-${brief.id}-step-${index}`;
      if (occupied.has(id)) return;
      const state = index < workflow.stepIndex ? "已完成" : index === workflow.stepIndex ? "当前步骤 · 回传后人工审核" : "等待前一步审核后继续";
      ops.push({ type: "add_node", id, nodeType: "text", title: `${index + 1}. ${step.name}`, position: { x: left + index * 400, y: anchor.position.y }, width: 360, height: 180,
        metadata: { content: `${state}\n\n${step.instructions}`, yummyai: { schemaVersion: 1, role: "workflow-step", briefId: brief.id, templateKey: workflow.template.key, templateVersion: workflow.template.version, stepIndex: index } } });
      ops.push({ type: "connect_nodes", fromNodeId: index ? `yummyai-${brief.id}-step-${index - 1}` : anchor.id, toNodeId: id });
    });
  }
  const promptId = `yummyai-${brief.id}-prompt`;
  if (!occupied.has(promptId)) {
    ops.push({ type: "add_node", id: promptId, nodeType: "text", title: brief.name, position: { x: left, y: top }, width: 420, height: 280, metadata: { content: brief.prompt + (brief.negativePrompt ? `\n\n避免：${brief.negativePrompt}` : ""), yummyai: { schemaVersion: 1, briefId: brief.id, role: "brief" } } });
    ops.push({ type: "connect_nodes", fromNodeId: workflow ? `yummyai-${brief.id}-step-${workflow.stepIndex}` : anchor.id, toNodeId: promptId });
  }
  assets.forEach((asset, index) => {
    const ref = brief.referenceAssets.find((entry) => entry.id === asset.assetId);
    if (!ref || !["image/png", "image/jpeg", "image/webp"].includes(asset.mediaType)) throw new Error("ERP 返回了未绑定的素材或不支持的格式");
    const id = `yummyai-${brief.id}-${asset.assetId}`;
    if (occupied.has(id)) return;
    ops.push({ type: "add_node", id, nodeType: "image", title: ref.fileName, position: { x: left + index * 340, y: top + 340 }, width: 300, height: 300, metadata: { content: `data:${asset.mediaType};base64,${asset.contentBase64}`, yummyai: { schemaVersion: 1, briefId: brief.id, assetId: ref.id, assetVersion: ref.version, checksumSha256: ref.checksumSha256, role: "reference" } } });
    ops.push({ type: "connect_nodes", fromNodeId: promptId, toNodeId: id });
  });
  return ops;
}

export async function readNodeImage(node: CanvasNodeData): Promise<string> {
  const source = node.metadata?.content;
  if (typeof source !== "string" || !imageNodes([node]).length) throw new Error("请选择一张已加载的图片");
  const response = await fetch(source, { credentials: "omit", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error("图片读取失败，请在原版画布中确认图片已加载，或重新上传图片");
  if (Number(response.headers.get("content-length")) > CANVAS_BRIDGE.maxImageBytes) throw new Error("图片不能超过 20 MiB");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("图片内容为空");
  const parts: Uint8Array[] = []; let length = 0;
  while (true) {
    const next = await reader.read(); if (next.done) break;
    length += next.value.byteLength;
    if (length > CANVAS_BRIDGE.maxImageBytes) { await reader.cancel(); throw new Error("图片不能超过 20 MiB"); }
    parts.push(next.value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  let binary = "";
  for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(binary);
}
