const exact = (code: string, before: string, after: string) => {
  if (code.split(before).length !== 2) throw new Error(`Pinned draft adapter requires one anchor: ${before.slice(0, 100)}`);
  return code.replace(before, after);
};
export function adaptStudioDraft(code: string, name: string, own: (name: string) => string) {
  if (["pages/image/index.tsx", "pages/video/index.tsx"].includes(name)) {
    const kind = name.includes("/image/") ? "image" : "video";
    code = `import { useWorkbenchDraft, WorkbenchDraftBar } from ${JSON.stringify(own("./src/workbench-draft-view.tsx"))};\nimport { studioHistoryFrozen, studioDraftHistoryFields, FrozenDraftHistory } from ${JSON.stringify(own("./src/studio-draft-history.tsx"))};\n${code}`;
    code = exact(code, 'const updateConfig = useConfigStore((state) => state.updateConfig);', 'const nativeUpdateConfig = useConfigStore((state) => state.updateConfig);');
    code = exact(code, '    const [prompt, setPrompt] = useState("");\n    const [references, setReferences] = useState<ReferenceImage[]>([]);', `    const { prompt, setPrompt, references, setReferences, updateConfig, draft } = useWorkbenchDraft(${JSON.stringify(kind)}, config, nativeUpdateConfig);`);
    code = exact(code, '    const createSession = () => {\n        setPrompt("");\n        setReferences([]);', '    const createSession = () => {\n        draft.create();');
    code = exact(code, 'value={prompt} onChange={(event) => setPrompt(event.target.value)}', 'disabled={!draft.writable} value={prompt} onChange={(event) => setPrompt(event.target.value)}');
    const root = '    return (\n        <div className="flex h-full flex-col overflow-hidden bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">';
    code = exact(code, root, `    if (!draft.ready) return <WorkbenchDraftBar draft={draft} />;\n${root}\n            <WorkbenchDraftBar draft={draft} />`);
    code = exact(code, '        id: log.id || nanoid(),', '        ...studioDraftHistoryFields(log),\n        id: log.id || nanoid(),');
    code = exact(code, '{log.title}</div>', '{log.title}<FrozenDraftHistory value={log} /></div>');
    if (kind === "video") {
      code = `import { studioExecutionAllowed } from ${JSON.stringify(own("./src/model-state.ts"))};\n${code}`;
      code = exact(code, '    const resumePendingLogs = (items: GenerationLog[]) => {', '    const resumePendingLogs = (items: GenerationLog[]) => {\n        if (!studioExecutionAllowed()) return;');
      code = exact(code, 'if (log.status === "pending" && log.task) void pollGenerationLog(log);', 'if (!studioHistoryFrozen(log) && log.status === "pending" && log.task) void pollGenerationLog(log);');
      code = exact(code, '        if (!log.task || activeLogIdsRef.current.has(log.id)) return;', '        if (!studioExecutionAllowed() || studioHistoryFrozen(log) || !log.task || activeLogIdsRef.current.has(log.id)) return;');
      code = exact(code, '        } catch (error) {\n            const errorMessage = error instanceof Error ? error.message : t("workbench.generationFailed");\n            setResults([{ id: log.id, status: "failed", error: errorMessage }]);', '        } catch (error) {\n            if (!studioExecutionAllowed()) return;\n            const errorMessage = error instanceof Error ? error.message : t("workbench.generationFailed");\n            setResults([{ id: log.id, status: "failed", error: errorMessage }]);');
    }
  }
  if (name === "stores/canvas/use-canvas-store.ts") {
    code = `import { queueStudioDraftWrite } from ${JSON.stringify(own("./src/studio-draft-flush.ts"))};\n${code}`;
    code = exact(code, '        saveTimer = setTimeout(() => {\n            saveTimer = null;\n            void localForageStorage.setItem(name, JSON.stringify(value));\n        }, 400);', '        queueStudioDraftWrite("native-canvas-store", async () => { saveTimer = null; await localForageStorage.setItem(name, JSON.stringify(value)); }, 400);');
  }
  if (name === "pages/canvas/project.tsx") {
    code = `import { studioExecutionAllowed } from ${JSON.stringify(own("./src/model-state.ts"))};\n${code}`;
    code = `import { registerStudioDraftFlush } from ${JSON.stringify(own("./src/studio-draft-flush.ts"))};\nimport { studioHistoryFrozen, studioDraftRestoreNodes, FrozenDraftHistory } from ${JSON.stringify(own("./src/studio-draft-history.tsx"))};\n${code}`;
    code = exact(code, 'const projectId = params.id || "";', 'const projectId = params.id || "";\n    const frozenCanvasRef = useRef<unknown>(null);');
    code = exact(code, '        const project = openProject(projectId);', '        const project = openProject(projectId);\n        frozenCanvasRef.current = project;');
    code = exact(code, 'restoreCanvasMedia(resetInterruptedGeneration(project.nodes),', 'restoreCanvasMedia(studioExecutionAllowed() ? studioDraftRestoreNodes(project.nodes, resetInterruptedGeneration) : project.nodes,');
    code = exact(code, 'nodesRef.current.filter(hasResumableVideoTask)', 'nodesRef.current.filter(node => studioExecutionAllowed() && !studioHistoryFrozen(node) && hasResumableVideoTask(node))');
    code = exact(code, '        async (node: CanvasNodeData, silent = false) => {\n            const taskId', '        async (node: CanvasNodeData, silent = false) => {\n            if (!studioExecutionAllowed() || studioHistoryFrozen(node)) return;\n            const taskId');
    const pollStart = '    const pollVideoNodeTask = useCallback(', pollEnd = '    const stopGenerationByRunningId = useCallback(';
    if (code.split(pollStart).length !== 2 || code.split(pollEnd).length !== 2 || code.indexOf(pollEnd) <= code.indexOf(pollStart)) throw new Error("Pinned draft adapter requires one canvas video poll section");
    const poll = code.slice(code.indexOf(pollStart), code.indexOf(pollEnd));
    code = exact(code, poll, exact(poll, '            } catch (error) {\n                if (isGenerationCanceled(error)) return;\n                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");', '            } catch (error) {\n                if (!studioExecutionAllowed() || isGenerationCanceled(error)) return;\n                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");'));
    const viewport = '    useEffect(() => {\n        if (!projectLoaded || !canvasLease.canSave()) return;\n        if (viewportSaveTimerRef.current)';
    code = exact(code, viewport, '    useLayoutEffect(() => {\n        const flush = () => {\n            if (!projectLoaded || !canvasLease.canSave()) return;\n            if (viewportSaveTimerRef.current) { clearTimeout(viewportSaveTimerRef.current); viewportSaveTimerRef.current = null; }\n            updateProject(projectId, { nodes: nodesRef.current, connections: connectionsRef.current, chatSessions, activeChatId, backgroundMode, showImageInfo, viewport: viewportRef.current });\n        };\n        const unregister = registerStudioDraftFlush(flush), release = canvasLease.onBeforeRelease(flush);\n        return () => { unregister(); release(); };\n    }, [projectLoaded, canvasLease, projectId, updateProject, chatSessions, activeChatId, backgroundMode, showImageInfo]);\n\n' + viewport);
    const root = 'data-studio-canvas-id={projectId} data-studio-canvas-restored={projectLoaded} className="flex h-full min-h-0 overflow-hidden" style={{ background: theme.canvas.background, color: theme.node.text }}>';
    code = exact(code, root, root + '\n            {studioHistoryFrozen(frozenCanvasRef.current) && <div className="absolute right-3 top-14 z-20 max-w-[75%]"><FrozenDraftHistory value={frozenCanvasRef.current} /></div>}');
  }
  return code;
}
