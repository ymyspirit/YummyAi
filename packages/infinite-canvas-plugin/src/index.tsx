import { CANVAS_BRIDGE, CanvasBriefSchema, CanvasResultReceiptSchema, type CanvasBrief, type SubmitCanvasResultInput } from "@yummyai/contracts/pod/canvas-bridge";
import type { CanvasNodeContext, CanvasNodeData, CanvasPlugin, PluginRuntime } from "../vendor/canvas-sdk-types";
import { briefOperations, imageNodes, readNodeImage } from "./adapter";
import { createConnection } from "./connection";

export default function yummyaiPlugin(runtime: PluginRuntime): CanvasPlugin {
  const React = runtime.React;
  let connection: ReturnType<typeof createConnection>;

  function Task({ ctx }: { ctx: CanvasNodeContext }) {
    const [brief, setBrief] = React.useState<CanvasBrief>();
    const [refs, setRefs] = React.useState<string[]>([]), [images, setImages] = React.useState<CanvasNodeData[]>([]);
    const [selected, setSelected] = React.useState(""), [title, setTitle] = React.useState("");
    const [batchMode, setBatchMode] = React.useState(false), [batchIds, setBatchIds] = React.useState<string[]>([]);
    const [sourceKind, setSourceKind] = React.useState<SubmitCanvasResultInput["sourceKind"]>("ai_generated"), [sourceReference, setSourceReference] = React.useState("");
    const [attested, setAttested] = React.useState(false), [busy, setBusy] = React.useState(false), [notice, setNotice] = React.useState("先读取从 ERP 打开的当前需求"), [error, setError] = React.useState("");
    async function action(work: () => Promise<void>) {
      if (busy) return; setBusy(true); setError("");
      try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败，请重试"); }
      finally { setBusy(false); }
    }
    async function readBrief() {
      await connection.connect();
      const next = CanvasBriefSchema.parse(await connection.request({ type: "brief.read" }));
      setBrief(next); setRefs(next.referenceAssets.map((asset) => asset.id)); setAttested(false); setBatchIds([]); setSelected("");
      ctx.updateMetadata({ yummyai: { schemaVersion: 1, briefId: next.id }, content: next.prompt });
      setNotice(`已读取需求，已回传 ${next.resultCount}/4 个方案`);
    }
    async function addAssets() {
      if (!brief) return;
      const loaded: Array<{ assetId: string; mediaType: string; contentBase64: string }> = [];
      for (const assetId of refs) {
        const value = await connection.request({ type: "asset.read", assetId }) as { assetId: string; mediaType: string; contentBase64: string };
        if (!value || typeof value.contentBase64 !== "string" || value.contentBase64.length > 28 * 1024 * 1024) throw new Error("ERP 素材响应无效");
        loaded.push(value);
      }
      const ops = briefOperations(brief, ctx.node, ctx.getNodes(), loaded);
      ctx.applyOps(ops); setNotice(ops.length ? "需求和素材已加入右侧画布。可继续使用原版生图和编辑功能。" : "所选需求和素材已在画布中，无需重复加入。");
    }
    function refreshImages() { const nodes = imageNodes(ctx.getNodes()); setImages(nodes); setSelected(""); setTitle(""); setAttested(false); setNotice(nodes.length ? "请选择要回传的图片" : "尚无可读取的图片，请先在画布上传或生成图片。"); }
    async function submit() {
      if (!brief || !attested) return;
      const ids = batchMode ? batchIds : [selected];
      if (!ids.length || ids.length > 4) throw new Error("一次请选择 1 至 4 张图片");
      let succeeded = 0, replayed = 0; const failures: string[] = [];
      for (const [index, id] of ids.entries()) {
        try {
          setNotice(`正在回传 ${index + 1}/${ids.length}，请保留 ERP 页面`);
          const node = ctx.getNode(id); if (!node) throw new Error("图片节点已删除，请刷新列表");
          const resultTitle = batchMode ? `${title.slice(0, 100)} · ${node.title || node.id}`.slice(0, 160) : title;
          const contentBase64 = await readNodeImage(node);
          const identity = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ briefId: brief.id, nodeId: node.id, contentBase64, title: resultTitle, sourceKind, sourceReference })));
          const key = `submission:${Array.from(new Uint8Array(identity), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
          let submissionId = await ctx.storage.get<string>(key);
          if (!submissionId) { submissionId = crypto.randomUUID(); await ctx.storage.set(key, submissionId); }
          const result = CanvasResultReceiptSchema.parse(await connection.request({ type: "result.submit", input: {
            submissionId, protocolVersion: 1, pluginVersion: CANVAS_BRIDGE.pluginVersion, upstreamVersion: CANVAS_BRIDGE.upstreamVersion,
            sourceNodeId: node.id, title: resultTitle, contentBase64, rightsAttested: true, sourceKind, sourceReference,
          } }));
          succeeded += 1; if (result.replayed) replayed += 1;
        } catch (cause) { failures.push(`第 ${index + 1} 张：${cause instanceof Error ? cause.message : "提交失败"}`); }
      }
      setBrief({ ...brief, resultCount: Math.min(4, brief.resultCount + succeeded - replayed) });
      setNotice(`已保存到 ERP ${succeeded} 个方案${replayed ? `（${replayed} 个为重复提交）` : ""}，请回到 ERP 审核。`);
      if (failures.length) setError(`已成功 ${succeeded} 个，失败 ${failures.length} 个。可重新提交，已保存的方案不会重复。${failures.join("；")}`);
    }
    return <div className="yummyai-task" style={{ color: ctx.theme.node.text, background: ctx.theme.node.panel }} onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
      <header><strong>ERP 创作任务</strong><span>连接 · 制作 · 回传</span></header>
      {brief?.workflow ? <p><b>{brief.workflow.template.name}</b> · 第 {brief.workflow.stepIndex + 1}/{brief.workflow.template.steps.length} 步：{brief.workflow.template.steps[brief.workflow.stepIndex]?.name}<br /><small>回传方案后，在 ERP 完成审核再继续。</small></p> : null}
      <button disabled={busy} onClick={() => void action(readBrief)}>读取当前需求</button>
      {brief ? <><h3>{brief.name}</h3><p className="yummyai-prompt">{brief.prompt}</p><fieldset><legend>选择参考素材</legend>{brief.referenceAssets.length ? brief.referenceAssets.map((asset) => <label className="yummyai-check" key={asset.id}><input type="checkbox" checked={refs.includes(asset.id)} onChange={(event) => setRefs((current) => event.target.checked ? [...current, asset.id] : current.filter((id) => id !== asset.id))} /><span>{asset.fileName}</span></label>) : <p>此需求没有参考素材</p>}</fieldset><button disabled={busy} onClick={() => void action(addAssets)}>将需求和所选素材加入画布</button></> : null}
      <hr /><h3>回传设计方案</h3><button disabled={busy || !brief} onClick={refreshImages}>刷新画布图片</button>
      <label>选择图片<select disabled={busy || !brief} value={selected} onChange={(event) => { const node = images.find((image) => image.id === event.target.value); setSelected(node?.id ?? ""); setTitle(node?.title?.slice(0, 160) ?? ""); setAttested(false); }}><option value="">请选择要回传的图片</option>{images.map((node) => <option key={node.id} value={node.id}>{node.title || "未命名图片"}</option>)}</select></label>
      {selected ? <img className="yummyai-preview" alt="待回传方案预览" src={String(images.find((node) => node.id === selected)?.metadata?.content ?? "")} /> : null}
      <label>方案名称<input value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="yummyai-check"><input type="checkbox" checked={batchMode} disabled={busy || !brief} onChange={(event) => { setBatchMode(event.target.checked); setBatchIds(selected ? [selected] : []); setAttested(false); }} /><span>批量回传图片（最多 4 张，共用来源说明）</span></label>
      {batchMode ? <fieldset><legend>选择批量方案 {batchIds.length}/4</legend>{images.map((node) => <label className="yummyai-check" key={node.id}><input type="checkbox" checked={batchIds.includes(node.id)} disabled={busy || !batchIds.includes(node.id) && batchIds.length >= 4} onChange={(event) => { setBatchIds((current) => event.target.checked ? [...current, node.id] : current.filter((id) => id !== node.id)); setAttested(false); }} /><span>{node.title || "未命名图片"}</span></label>)}</fieldset> : null}
      <label>图片来源<select value={sourceKind} onChange={(event) => { setSourceKind(event.target.value as SubmitCanvasResultInput["sourceKind"]); setAttested(false); }}><option value="ai_generated">AI 生成</option><option value="owned">自主制作</option><option value="licensed">已获得授权</option></select></label>
      <label>来源说明<input value={sourceReference} maxLength={500} placeholder="填写所用模型、原作或授权记录" onChange={(event) => { setSourceReference(event.target.value); setAttested(false); }} /></label>
      <label className="yummyai-check"><input type="checkbox" checked={attested} onChange={(event) => setAttested(event.target.checked)} /><span>确认图片及参考素材可以用于本次设计</span></label>
      <button className="yummyai-primary" disabled={busy || !brief || !!brief.nextBriefId || brief.status === "cancelled" || (batchMode ? !batchIds.length : !selected) || !title.trim() || !sourceReference.trim() || !attested} onClick={() => void action(submit)}>{busy ? "处理中…" : "提交到 ERP 待审核"}</button>
      {error ? <p role="alert" className="yummyai-error">{error}</p> : <p role="status" className="yummyai-status">{notice}</p>}
      <small>每个需求最多 4 个方案 · PNG / JPG / WebP · 20 MiB<br />画布 {CANVAS_BRIDGE.upstreamVersion} / 插件 {CANVAS_BRIDGE.pluginVersion}</small>
    </div>;
  }
  return {
    id: "yummyai-erp", name: "YummyAI ERP 创作接入", version: CANVAS_BRIDGE.pluginVersion,
    description: "读取 ERP 创作需求、加入授权素材、回传设计方案待审核", minAppVersion: CANVAS_BRIDGE.upstreamVersion,
    css: `.yummyai-task{height:100%;box-sizing:border-box;overflow:auto;padding:18px;font:14px/1.5 system-ui,sans-serif;display:flex;flex-direction:column;gap:12px}.yummyai-task header{display:flex;justify-content:space-between;gap:12px}.yummyai-task header span,.yummyai-task small{font-size:12px;opacity:.8}.yummyai-task h3,.yummyai-task p{margin:0;overflow-wrap:anywhere}.yummyai-task h3{font-size:15px}.yummyai-task label{display:grid;gap:5px}.yummyai-task button,.yummyai-task input:not([type=checkbox]),.yummyai-task select{font:inherit;background:transparent;color:inherit;border:1px solid currentColor;border-radius:5px;padding:9px;min-height:40px;width:100%;box-sizing:border-box}.yummyai-task option{background:#fff;color:#182232}.yummyai-task button{cursor:pointer}.yummyai-task button:disabled{opacity:.5;cursor:not-allowed}.yummyai-task :focus-visible{outline:2px solid #60a5fa;outline-offset:2px}.yummyai-task .yummyai-primary{background:#2563eb;color:#fff;border-color:#2563eb}.yummyai-task .yummyai-check{display:flex;align-items:flex-start;gap:8px}.yummyai-task input[type=checkbox]{margin-top:4px}.yummyai-task fieldset{border:0;padding:0;margin:0;display:grid;gap:6px}.yummyai-task hr{width:100%;border:0;border-top:1px solid currentColor;opacity:.2}.yummyai-prompt{white-space:pre-wrap;max-height:150px;overflow:auto}.yummyai-preview{width:100%;max-height:180px;object-fit:contain;background:#e2e8f0}.yummyai-task .yummyai-error{color:#ef4444}.yummyai-status{font-size:13px}`,
    nodes: [{ type: "yummyai-erp:task", title: "ERP 创作任务", description: "连接 ERP 需求并提交设计方案", icon: React.createElement("svg", { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8 }, React.createElement("path", { d: "M3 3h7v7H3zM14 14h7v7h-7zM7 10v7h7M10 6h7v8" })), defaultSize: { width: 440, height: 720 }, interactionToggle: true, forceInteractive: () => true, hidePanel: true, Content: Task, resource: (node) => typeof node.metadata?.content === "string" ? { kind: "text", text: node.metadata.content } : null }],
    setup() { connection = createConnection(runtime.version); void connection.connect().catch(() => {}); return () => connection.dispose(); },
  };
}
