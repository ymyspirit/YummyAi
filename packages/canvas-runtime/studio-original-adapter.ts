const exact = (source: string, before: string, after: string) => {
  if (source.split(before).length !== 2) throw new Error(`Pinned original adapter requires one anchor: ${before.slice(0, 100)}`);
  return source.replace(before, after);
};
export function adaptStudioOriginal(code: string, name: string, own: (name: string) => string) {
  if (name === "pages/canvas/project.tsx") {
    code = `import { useCanvasLease, restoreCanvasMedia, CanvasRestoreNotice } from ${JSON.stringify(own("./src/canvas-project-session.tsx"))};\nimport { restoredViewport, fitCanvasBounds } from ${JSON.stringify(own("./src/canvas-lifecycle.ts"))};\n${code}`;
    code = exact(code, 'const projectId = params.id || "";', 'const projectId = params.id || "";\n    const canvasLease = useCanvasLease(projectId);\n    const [restoreAttempt, setRestoreAttempt] = useState(0);\n    const [restoreError, setRestoreError] = useState("");');
    code = exact(code, '        const restore = async () => {\n            const restoredNodes = await hydrateCanvasImages(resetInterruptedGeneration(project.nodes));\n            const restoredSessions = await hydrateAssistantImages(project.chatSessions || []);', '        const isCurrentRestore = canvasLease.beginRestore();\n        const restore = async () => {\n            const restored = await restoreCanvasMedia(resetInterruptedGeneration(project.nodes), project.chatSessions || [], canvasLease, isCurrentRestore);\n            if (!isCurrentRestore()) return;\n            const restoredNodes = restored.nodes, restoredSessions = restored.sessions;');
    code = exact(code, '            setViewport(project.viewport);', '            setViewport(restoredViewport(project.viewport));');
    code = exact(code, '            setProjectLoaded(true);\n        };\n        void restore();\n    }, [hydrated, navigate, openProject, projectId]);', '            canvasLease.markRestored();\n            setProjectLoaded(true);\n        };\n        void restore().catch(() => { if (isCurrentRestore()) setRestoreError("原画布媒体暂时无法读取 请保留原记录后重试"); });\n        return () => canvasLease.cancelRestore();\n    }, [hydrated, navigate, openProject, projectId, canvasLease, restoreAttempt]);');
    code = exact(code, '        if (!projectLoaded || historyPausedRef.current) return;', '        if (!projectLoaded || historyPausedRef.current || !canvasLease.canSave()) return;');
    code = exact(code, '    useEffect(() => {\n        if (!projectLoaded) return;\n        if (viewportSaveTimerRef.current)', '    useEffect(() => {\n        if (!projectLoaded || !canvasLease.canSave()) return;\n        if (viewportSaveTimerRef.current)');
    code = exact(code, '            updateProject(projectId, { viewport: viewportRef.current });', '            if (canvasLease.canSave()) updateProject(projectId, { viewport: viewportRef.current });');
    code = exact(code, 'focusViewportForNode, getConnectionTargetAnchor', 'focusViewportForNode, nodeBounds, getConnectionTargetAnchor');
    code = exact(code, '    const resetViewport = useCallback(() => {', '    const fitAllViewport = useCallback(() => {\n        const next = fitCanvasBounds(nodeBounds(nodesRef.current), size);\n        if (next && canvasLease.canSave()) setViewport(next);\n    }, [size, canvasLease]);\n\n    const resetViewport = useCallback(() => {');
    code = exact(code, 'if (!projectLoaded) return <CanvasRefreshShell />;', 'if (!projectLoaded) return <CanvasRestoreNotice error={restoreError} onProjects={() => navigate("/canvas")} onCreate={createAndOpenProject} retry={() => { setRestoreError(""); setRestoreAttempt(value => value + 1); }} />;');
    code = exact(code, '<CanvasZoomControls scale={viewport.k}', '<CanvasZoomControls onFitAll={fitAllViewport} scale={viewport.k}');
    code = exact(code, 'className="flex h-full min-h-0 overflow-hidden"', 'data-studio-canvas-id={projectId} data-studio-canvas-restored={projectLoaded} className="flex h-full min-h-0 overflow-hidden"');
    code = exact(code, '                insertAssistantImage({ id: `asset-${Date.now()}`, prompt: payload.title, dataUrl: payload.dataUrl, storageKey: payload.storageKey });', '                if (!canvasLease.canSave() || !payload.width || !payload.height || !Number.isFinite(payload.width) || !Number.isFinite(payload.height)) return;\n                const config = fitNodeSize(payload.width, payload.height);\n                const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);\n                const id = `asset-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;\n                setNodes(previous => [...previous, { id, type: CanvasNodeType.Image, title: payload.title, position: { x: center.x - config.width / 2, y: center.y - config.height / 2 }, width: config.width, height: config.height, metadata: imageMetadata({ url: payload.dataUrl, storageKey: payload.storageKey, width: payload.width, height: payload.height, bytes: payload.bytes ?? 0, mimeType: payload.mimeType ?? "" }) }]);\n                setSelectedNodeIds(new Set([id]));\n                setSelectedConnectionId(null);');
  }
  if (name === "components/canvas/asset-picker-modal.tsx") {
    code = exact(code, '{ kind: "image"; dataUrl: string; title: string; storageKey?: string }', '{ kind: "image"; dataUrl: string; title: string; storageKey?: string; width?: number; height?: number; bytes?: number; mimeType?: string }');
    code = exact(code, '{ kind: "image", dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, title: asset.title }', '{ kind: "image", dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, title: asset.title, width: asset.data.width, height: asset.data.height, bytes: asset.data.bytes, mimeType: asset.data.mimeType }');
  }
  if (name === "components/canvas/canvas-side-panel.tsx") code = exact(code, 'return { kind: "image", dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, title: asset.title };', 'return { kind: "image", dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, title: asset.title, width: asset.data.width, height: asset.data.height, bytes: asset.data.bytes, mimeType: asset.data.mimeType };');
  if (name === "stores/canvas/use-canvas-store.ts") {
    code = `import { canvasLifecycles } from ${JSON.stringify(own("./src/canvas-lifecycle.ts"))};\nimport { persistedCanvasOriginals } from ${JSON.stringify(own("./src/canvas-legacy-media.ts"))};\nimport { useStudioModels } from ${JSON.stringify(own("./src/model-state.ts"))};\n${code}`;
    code = exact(code, 'updateProject: (id, patch) =>\n                set((state) => ({', 'updateProject: (id, patch) => {\n                if (!canvasLifecycles.canWrite(id) || !useStudioModels.getState().canSave) return;\n                const originalPatch = persistedCanvasOriginals(patch);\n                set((state) => ({');
    code = exact(code, 'projects: state.projects.map((project) => (project.id === id ? { ...project, ...patch, updatedAt: new Date().toISOString() } : project)),\n                })),', 'projects: state.projects.map((project) => (project.id === id ? { ...project, ...originalPatch, updatedAt: new Date().toISOString() } : project)),\n                }));\n            },');
  }
  if (name === "services/image-storage.ts" || name === "services/file-storage.ts") {
    code = `import { createCanvasDisplayUrl, revokeCanvasDisplayUrl } from ${JSON.stringify(own("./src/canvas-legacy-media.ts"))};\n${code}`;
    // Both pinned owners create originals in store/upload, resolve and replace.
    // Thumbnails keep their upstream path and never enter canvas documents.
    const anchor = "URL.createObjectURL(blob)";
    if (code.split(anchor).length !== 4) throw new Error(`Pinned original adapter requires three media URL anchors: ${name}`);
    code = code.replaceAll(anchor, "createCanvasDisplayUrl(blob)").replaceAll("URL.revokeObjectURL(url)", "revokeCanvasDisplayUrl(url)");
  }
  if (name === "components/canvas/canvas-zoom-controls.tsx") {
    code = exact(code, '    onReset: () => void;', '    onReset: () => void;\n    onFitAll: () => void;');
    code = exact(code, 'export function CanvasZoomControls({ scale, onScaleChange, onReset,', 'export function CanvasZoomControls({ scale, onScaleChange, onReset, onFitAll,');
    code = exact(code, '                <Tooltip title={t("canvas.zoom")}>', '                <Tooltip title="显示全部"><Button type="text" className="!h-8 !w-8 !min-w-8 !p-0" style={{ color: theme.toolbar.item }} icon={<Focus className="size-4" />} onClick={onFitAll} aria-label="显示全部" /></Tooltip>\n                <Tooltip title={t("canvas.zoom")}>');
  }
  if (name === "pages/assets/index.tsx") {
    code = `import { AssetOriginalFacts } from ${JSON.stringify(own("./src/asset-media.tsx"))};\n${code}`;
    code = exact(code, 'const summary = assetSummary(asset);', 'const summary = <AssetOriginalFacts asset={asset} />;');
    code = exact(code, '{asset.data.width}x{asset.data.height} · {formatBytes(asset.data.bytes)} · {asset.data.mimeType}', '<AssetOriginalFacts asset={asset} />');
    // An upload draft has not yet acquired a catalogue ID, but its original key
    // still goes through the same owner inspection. Client dimensions are not facts.
    code = exact(code, '{imageDraft.width}x{imageDraft.height} · {formatBytes(imageDraft.bytes)}', '<AssetOriginalFacts asset={{ id: "draft", kind: "image", title: "", coverUrl: "", tags: [], createdAt: "", updatedAt: "", data: imageDraft }} />');
  }
  return code;
}
