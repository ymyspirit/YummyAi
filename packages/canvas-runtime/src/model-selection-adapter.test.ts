import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { createSourceFile, forEachChild, isFunctionDeclaration, transpileModule, DiagnosticCategory, JsxEmit, ModuleKind, ScriptKind, ScriptTarget, type Node } from "typescript";
import { studioRuntimeAdapter } from "../vite.config";
import { isStudioRuntimeConfig, modelToken, projectStudioModels, requireStudioModel, studioModelCatalogue, studioModelValue, studioNodeModelFields } from "./model-selection";
import { modelSelectionConfig, modelSelectionFixtures as models } from "./model-selection-fixtures";

async function transform(name: string, code?: string) {
  const file = new URL(`../vendor/src/${name}`, import.meta.url), source = code ?? readFileSync(file, "utf8"), hook = studioRuntimeAdapter().transform;
  if (typeof hook !== "function") throw new Error("Actual source-transform hook is unavailable");
  const result = await hook.call({} as never, source, fileURLToPath(file));
  if (!result || typeof result === "string" || typeof result.code !== "string" || !result.code.trim()) throw new Error("Actual transform did not return source");
  return result.code;
}
function nativeFunction(source: string, name: string) {
  const file = createSourceFile("native.tsx", source, ScriptTarget.ESNext, true, ScriptKind.TSX); let code = "";
  const visit = (node: Node) => { if (isFunctionDeclaration(node) && node.name?.text === name && node.body) code = `const native = (${node.parameters.map(parameter => parameter.getText(file)).join(",")}) => ${node.body.getText(file)};`; forEachChild(node, visit); }; visit(file);
  if (!code) throw new Error(`Missing actual native function ${name}`);
  return transpileModule(code, { compilerOptions: { target: ScriptTarget.ESNext, module: ModuleKind.None } }).outputText + "\nreturn native;";
}
beforeEach(async () => { studioModelCatalogue.configure(""); studioModelCatalogue.configure("unit-owner"); await studioModelCatalogue.load(async () => structuredClone(models)); });
describe("model matching through the actual complete pinned Vite pipeline", () => {
  it.each(["stores/use-config-store.ts", "components/model-picker.tsx", "pages/image/index.tsx", "pages/video/index.tsx", "components/canvas/canvas-config-node-panel.tsx", "components/canvas/canvas-node-prompt-panel.tsx", "lib/canvas/canvas-generation-helpers.ts", "pages/canvas/project.tsx"])("compiles unchanged upstream %s with its existing original/draft transforms", async name => {
    const result = await transform(name), syntax = transpileModule(result, { fileName: name, reportDiagnostics: true, compilerOptions: { target: ScriptTarget.ESNext, module: ModuleKind.ESNext, jsx: JsxEmit.ReactJSX } });
    expect(syntax.diagnostics?.filter(item => item.category === DiagnosticCategory.Error)).toEqual([]);
    if (name.includes("model-picker")) { expect(result).toContain("const nativeOptions = useMemo("); expect(result).toContain("const current = selection ? selection.value"); expect(result).toContain("data-studio-model-id"); }
    if (name === "pages/image/index.tsx" || name === "pages/video/index.tsx") { expect(result).toContain("studioWorkbenchModel(effectiveConfig,"); expect(result).toContain("draft.document"); expect(result).toContain("useWorkbenchDraft("); expect(result).toContain("studioModelUsable(effectiveConfig, model,"); }
    if (name === "pages/canvas/project.tsx") { expect(result).not.toContain("effectiveConfig.imageModel || effectiveConfig.model"); expect(result).not.toContain("effectiveConfig.textModel || effectiveConfig.model"); }
  });
  it("runs the actual transformed upstream resolver without a built-in or cross-capability fallback", async () => {
    const source = await transform("stores/use-config-store.ts"), resolver = new Function("isStudioRuntimeConfig", "studioModelValue", nativeFunction(source, "resolveModelForCapability"))(isStudioRuntimeConfig, studioModelValue);
    const config = projectStudioModels(modelSelectionConfig({ model: modelToken(models[0]!) }), models);
    expect(resolver(config, undefined, "video")).toBe(""); expect(resolver(config, modelToken(models[0]!), "video")).toBe(modelToken(models[0]!));
    expect(() => requireStudioModel({ ...config, videoModel: resolver(config, modelToken(models[0]!), "video") }, "video")).toThrow();
  });
  it("runs the actual transformed canvas builder with a node's exact route and capability-specific field", async () => {
    const source = await transform("lib/canvas/canvas-generation-helpers.ts"), builder = new Function("studioNodeModelFields", "defaultConfig", nativeFunction(source, "buildGenerationConfig"))(studioNodeModelFields, modelSelectionConfig());
    const config = projectStudioModels(modelSelectionConfig({ imageModel: modelToken(models[0]!), videoModel: modelToken(models[2]!) }), models), node = { metadata: { model: modelToken(models[1]!) } };
    const original = JSON.stringify(node), result = builder(config, node, "image"); expect(result.imageModel).toBe(modelToken(models[1]!)); expect(requireStudioModel(result, "image").id).toBe(models[1]!.id); expect(JSON.stringify(node)).toBe(original);
  });
  it("rejects a changed pinned model-selection anchor instead of silently keeping the unsafe native fallback", async () => {
    const original = readFileSync(new URL("../vendor/src/pages/video/index.tsx", import.meta.url), "utf8");
    await expect(transform("pages/video/index.tsx", original.replace("const model = effectiveConfig.videoModel || effectiveConfig.model;", "const model = effectiveConfig.model;"))).rejects.toThrow("requires one anchor");
  });
});
