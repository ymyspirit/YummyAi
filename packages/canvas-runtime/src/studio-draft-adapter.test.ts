import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { transpileModule, createSourceFile, forEachChild, isVariableDeclaration, isCallExpression, ScriptKind, ScriptTarget, ModuleKind, JsxEmit, DiagnosticCategory, type Node } from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { studioRuntimeAdapter } from "../vite.config";
import { FrozenDraftHistory, studioDraftHistoryFields, studioDraftRestoreNodes, studioHistoryFrozen } from "./studio-draft-history";

const origin = { version: 1 as const, sourceScope: "unassigned", requestId: "original-request", executionFrozen: true as const };
async function transform(name: string, code?: string) {
  const file = new URL(`../vendor/src/${name}`, import.meta.url), source = code ?? readFileSync(file, "utf8"), hook = studioRuntimeAdapter().transform;
  if (typeof hook !== "function") throw new Error("The real Vite source transform is unavailable");
  const value = await hook.call({} as never, source, fileURLToPath(file));
  if (!value || typeof value === "string" || typeof value.code !== "string") throw new Error("The real Vite source transform did not return its compiled source");
  return value.code;
}
function expression(source: string, variable: string) {
  const file = createSourceFile("native.tsx", source, ScriptTarget.ESNext, true, ScriptKind.TSX); let found = "";
  const visit = (node: Node) => {
    if (isVariableDeclaration(node) && node.name.getText(file) === variable && node.initializer) found = (isCallExpression(node.initializer) ? node.initializer.arguments[0]! : node.initializer).getText(file);
    forEachChild(node, visit);
  };
  visit(file); if (!found) throw new Error(`Missing actual native function ${variable}`);
  return transpileModule(`const native = ${found};`, { compilerOptions: { target: ScriptTarget.ESNext, module: ModuleKind.None } }).outputText + "\nreturn native;";
}
describe("pinned native draft and history adapter", () => {
  it.each(["pages/image/index.tsx", "pages/video/index.tsx", "stores/canvas/use-canvas-store.ts", "pages/canvas/project.tsx"])("compiles unchanged upstream %s through the actual complete Vite plugin transform", async name => {
    const source = readFileSync(new URL(`../vendor/src/${name}`, import.meta.url), "utf8"), result = await transform(name, source);
    expect(result).not.toBe(source);
    const syntax = transpileModule(result, { fileName: name, reportDiagnostics: true, compilerOptions: { target: ScriptTarget.ESNext, module: ModuleKind.ESNext, jsx: JsxEmit.ReactJSX } });
    expect(syntax.diagnostics?.filter(item => item.category === DiagnosticCategory.Error)).toEqual([]);
    if (name.includes("/image/") || name.includes("/video/")) { expect(result).toContain("useWorkbenchDraft("); expect(result).not.toContain('const [prompt, setPrompt] = useState("")'); expect(result).toContain("studioDraftHistoryFields(log)"); expect(result).toContain("const canGenerate = modelsReady &&"); }
    if (name.includes("/video/")) { expect(result).toContain('!studioHistoryFrozen(log) && log.status === "pending"'); expect(result).toContain("if (!studioExecutionAllowed() || studioHistoryFrozen(log) || !log.task"); }
    if (name.endsWith("project.tsx")) { expect(result).toContain("canvasLease.onBeforeRelease(flush)"); expect(result).toContain("clearTimeout(viewportSaveTimerRef.current)"); expect(result).toContain("studioExecutionAllowed() ? studioDraftRestoreNodes(project.nodes, resetInterruptedGeneration) : project.nodes"); expect(result).toContain("studioHistoryFrozen(node)) return"); expect(result).not.toContain("studioHistoryFrozen(frozenCanvasRef.current) ||"); expect(result).toContain("studio-canvas-project relative"); }
    if (name.endsWith("use-canvas-store.ts")) { expect(result.split('queueStudioDraftWrite("native-canvas-store"')).toHaveLength(2); expect(result).not.toContain("saveTimer = setTimeout"); expect(result).not.toContain("return localForageStorage.setItem(name, JSON.stringify(value))"); }
  });
  it("fails the real pipeline closed when native draft or persistence anchors drift or duplicate", async () => {
    await expect(transform("pages/image/index.tsx", "changed upstream")).rejects.toThrow("requires one anchor");
    const source = readFileSync(new URL("../vendor/src/stores/canvas/use-canvas-store.ts", import.meta.url), "utf8").replaceAll("\r\n", "\n"), timer = '        saveTimer = setTimeout(() => {\n            saveTimer = null;\n            void localForageStorage.setItem(name, JSON.stringify(value));\n        }, 400);';
    await expect(transform("stores/canvas/use-canvas-store.ts", source.replace("}, 400);", "}, 401);"))).rejects.toThrow("requires one anchor");
    await expect(transform("stores/canvas/use-canvas-store.ts", source.replace(timer, `${timer}\n${timer}`))).rejects.toThrow("requires one anchor");
  });
  it("keeps copied pending task/status facts and never resets them even if generation is enabled", () => {
    const history = { id: "copied-node", metadata: { status: "generating", taskId: "original-task", _yummyaiOrigin: origin } }, live = { id: "new-node", metadata: { status: "generating", taskId: "new-task" } };
    const reset = vi.fn((nodes: typeof live[]) => nodes.map(node => ({ ...node, metadata: { ...node.metadata, status: "failed" } })));
    const restored = studioDraftRestoreNodes([history, live], reset);
    expect(restored[0]).toBe(history); expect(restored[0]?.metadata.taskId).toBe("original-task"); expect(restored[0]?.metadata.status).toBe("generating");
    expect(studioHistoryFrozen(history)).toBe(true); expect(studioHistoryFrozen(live)).toBe(false); expect(reset).toHaveBeenCalledExactlyOnceWith([live]);
    const normalized = { ...studioDraftHistoryFields({ status: "pending", task: { taskId: "original" }, _yummyaiOrigin: origin }), status: "pending" };
    expect(studioHistoryFrozen(normalized)).toBe(true); expect(renderToStaticMarkup(createElement(FrozenDraftHistory, { value: normalized }))).toContain("原任务已冻结");
  });
  it("runs the actual transformed native resume entries while paused without task requests, status writes or failure catches", async () => {
    const video = await transform("pages/video/index.tsx"), canvas = await transform("pages/canvas/project.tsx"), poll = vi.fn(), writes = vi.fn();
    const log = { id: "original-log", status: "pending", task: { id: "original-task" } }, node = { id: "original-node", metadata: { status: "loading", videoTaskId: "original-task" } }, original = JSON.stringify([log, node]);
    const resume = new Function("studioExecutionAllowed", "pollGenerationLog", "studioHistoryFrozen", expression(video, "resumePendingLogs"))(() => false, poll, studioHistoryFrozen);
    const videoPoll = new Function("studioExecutionAllowed", "studioHistoryFrozen", "saveLog", expression(video, "pollGenerationLog"))(() => false, studioHistoryFrozen, writes);
    const canvasPoll = new Function("studioExecutionAllowed", "studioHistoryFrozen", "setNodes", expression(canvas, "pollVideoNodeTask"))(() => false, studioHistoryFrozen, writes);
    resume([log]); await videoPoll(log); await canvasPoll(node, true);
    expect(poll).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(JSON.stringify([log, node])).toBe(original);
  });
  it("preserves original pending canvas nodes during paused restoration instead of marking interrupted work failed", async () => {
    const source = await transform("pages/canvas/project.tsx"), file = createSourceFile("canvas.tsx", source, ScriptTarget.ESNext, true, ScriptKind.TSX); let argument = "";
    const visit = (node: Node) => { if (isCallExpression(node) && node.expression.getText(file) === "restoreCanvasMedia") argument = node.arguments[0]!.getText(file); forEachChild(node, visit); }; visit(file);
    expect(argument).not.toBe(""); const nodes = [{ id: "original", metadata: { status: "loading", videoTaskId: "original-task" } }], reset = vi.fn(() => { throw new Error("Must not rewrite native statuses"); });
    const restoreInput = new Function("studioExecutionAllowed", "studioDraftRestoreNodes", "project", "resetInterruptedGeneration", `return (${argument});`)(() => false, studioDraftRestoreNodes, { nodes }, reset);
    expect(restoreInput).toBe(nodes); expect(reset).not.toHaveBeenCalled(); expect(nodes[0]?.metadata).toEqual({ status: "loading", videoTaskId: "original-task" });
  });
});
