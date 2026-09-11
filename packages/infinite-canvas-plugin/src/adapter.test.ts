import { describe, expect, it } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { CANVAS_BRIDGE, CANVAS_WORKFLOW_TEMPLATES, canvasVersionSupported, type CanvasBrief } from "@yummyai/contracts/pod/canvas-bridge";
import type { CanvasNodeData } from "../vendor/canvas-sdk-types";
import { briefOperations, imageNodes } from "./adapter";
import { bridgeLocation } from "./connection";

describe("isolated public SDK adapter", () => {
  const node: CanvasNodeData = { id: "task", type: "yummyai-erp:task", title: "ERP", position: { x: 0, y: 0 }, width: 440, height: 720 };
  const brief: CanvasBrief = { id: createEntityId(), itemId: createEntityId(), name: "Artwork", prompt: "Original brief", negativePrompt: "", status: "running", referenceAssets: [{ id: createEntityId(), fileName: "owned.png", mediaType: "image/png", version: 1, checksumSha256: "a".repeat(64) }], resultCount: 0, workflow: null, nextBriefId: null };
  it("adds public nodes without overwriting existing work or persisting ERP credentials", () => {
    const ops = briefOperations(brief, node, [node], [{ assetId: brief.referenceAssets[0].id, mediaType: "image/png", contentBase64: "YWJj" }]);
    expect(ops.filter((op) => op.type === "add_node")).toHaveLength(2);
    expect(ops.some((op) => op.type === "delete_node" || op.type === "update_node")).toBe(false);
    const existing = ops.filter((op) => op.type === "add_node").map((op) => ({ ...node, id: op.id! }));
    expect(briefOperations(brief, node, existing, [{ assetId: brief.referenceAssets[0].id, mediaType: "image/png", contentBase64: "YWJj" }])).toEqual([]);
    expect(() => briefOperations(brief, node, [], [{ assetId: createEntityId(), mediaType: "image/png", contentBase64: "YWJj" }])).toThrow(/未绑定/);
  });
  it("only offers raster images and checks exact validated host/plugin versions", () => {
    expect(imageNodes([{ ...node, type: "image", metadata: { content: "javascript:alert(1)" } }])).toEqual([]);
    expect(imageNodes([{ ...node, type: "image", metadata: { content: "data:image/svg+xml;base64,PHN2Zy8+" } }])).toEqual([]);
    expect(canvasVersionSupported("0.18.0", CANVAS_BRIDGE.pluginVersion)).toBe(true);
    expect(canvasVersionSupported("0.18.0", "1.0.0")).toBe(true);
    expect(canvasVersionSupported("v0.19.0", "1.0.0")).toBe(false);
    expect(canvasVersionSupported("v0.18.0", "2.0.0")).toBe(false);
  });
  it("accepts exact HTTPS or loopback origins and rejects opaque origins and userinfo", () => {
    const hash = (origin: string) => new URLSearchParams({ yummyaiOrigin: origin, yummyaiChannel: "ee34b909-4539-42b8-a2ef-2b41322ba68b" }).toString();
    expect(bridgeLocation(hash("http://localhost:3000"))?.origin).toBe("http://localhost:3000");
    for (const origin of ["null", "https://erp.test/path", "https://user:pass@erp.test", "http://erp.test", "file:///tmp/test"]) expect(bridgeLocation(hash(origin))).toBeNull();
  });
  it("materializes connected workflow steps with snapshot metadata without changing native nodes", () => {
    const task = { ...brief, workflow: { template: CANVAS_WORKFLOW_TEMPLATES[1]!, rootBatchId: brief.id, parentBatchId: null, stepIndex: 0, sourceVersionIds: [] } };
    const ops = briefOperations(task, node, [node], []);
    const steps = ops.filter((op) => op.type === "add_node" && op.metadata?.yummyai && (op.metadata.yummyai as { role: string }).role === "workflow-step");
    expect(steps).toHaveLength(2);
    expect(ops.some((op) => op.type === "connect_nodes" && op.fromNodeId === `yummyai-${brief.id}-step-0` && op.toNodeId === `yummyai-${brief.id}-step-1`)).toBe(true);
    expect(JSON.stringify(ops)).toContain("等待前一步审核后继续");
    const existing = ops.filter((op) => op.type === "add_node").map((op) => ({ ...node, id: op.id! }));
    expect(briefOperations(task, node, existing, [])).toEqual([]);
  });
});
