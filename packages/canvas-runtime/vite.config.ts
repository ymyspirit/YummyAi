import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { adaptConfiguration } from "./configuration-adapter";
import { adaptStudioOriginal } from "./studio-original-adapter";
import { adaptStudioDraft } from "./src/studio-draft-adapter";
import upstream from "./upstream.lock.json";
const path = (name: string) => fileURLToPath(new URL(name, import.meta.url));
function replace(source: string, before: string, after: string) {
  if (!source.includes(before)) throw new Error(`Pinned canvas adapter anchor missing: ${before.slice(0, 90)}`);
  return source.replace(before, after);
}
function replaceSection(source: string, start: string, end: string, replacement: string) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Pinned canvas adapter section missing: ${start}`);
  return source.slice(0, from) + replacement + source.slice(to);
}
export function studioRuntimeAdapter(): Plugin {
  return { name: "yummyai-canvas-adapter", enforce: "pre",
    generateBundle() {
      if (Object.keys(upstream.files).some(name => name.startsWith("public/plugins/"))) throw new Error("Pinned canvas local plugin inventory requires upstream review");
      // This embedded build ships its ERP bridge as a native adapter. It has no
      // separately bundled local plugins; existing saved plugins are untouched.
      // Publish the real empty local inventory expected by upstream discovery.
      this.emitFile({ type: "asset", fileName: "plugins/index.json", source: "[]\n" });
    },
    transform(code, id) {
    const name = id.replaceAll("\\", "/").split("/vendor/src/")[1];
    if (!name) return;
    code = code.replaceAll("\r\n", "\n");
    code = adaptConfiguration(code, name);
    code = adaptStudioOriginal(code, name, name => path(name).replaceAll("\\", "/"));
    code = adaptStudioDraft(code, name, name => path(name).replaceAll("\\", "/"));
    if (name === "pages/canvas/project.tsx") code = replace(code, 'className="flex h-full min-h-0 overflow-hidden"', 'className="studio-canvas-project relative flex h-full min-h-0 overflow-hidden"');
    if (name === "components/canvas/canvas-side-panel.tsx") {
      code = replace(code, 'className="relative z-[60] flex h-full shrink-0"', 'className="studio-canvas-side-panel relative z-[60] flex h-full shrink-0"');
      const relatedTarget = "const to = event.relatedTarget as Element | null;";
      if (code.split(relatedTarget).length !== 3) throw new Error("Pinned canvas hover adapter requires upstream review");
      // Leaving an iframe can provide its Window rather than an Element.
      code = code.replaceAll(relatedTarget, "const to = event.relatedTarget instanceof Element ? event.relatedTarget : null;");
    }
    if (name === "components/canvas/canvas-zoom-controls.tsx") code = replace(code, 'className="absolute bottom-5 left-5 z-50"', 'className="studio-canvas-zoom absolute bottom-5 left-5 z-50"');
    if (name === "stores/use-canvas-side-panel-store.ts") {
      code = replace(code, 'return localStorage.getItem(OPEN_KEY) !== "0";', 'return !window.matchMedia("(max-width: 700px)").matches && localStorage.getItem(OPEN_KEY) !== "0";');
      for (const value of ["0", "1"]) code = replace(code, `if (typeof window !== "undefined") localStorage.setItem(OPEN_KEY, "${value}");`, `if (typeof window !== "undefined" && !window.matchMedia("(max-width: 700px)").matches) localStorage.setItem(OPEN_KEY, "${value}");`);
    }
    if (name === "styles/globals.css") return replace(code, '@import "shadcn/tailwind.css";', "");
    if (name === "components/layout/app-providers.tsx") {
      // No mounted ERP tool uses Pro components. Ant's ConfigProvider already
      // supplies the theme; importing Pro here pulls its whole UI into startup.
      code = replace(code, 'import { ProConfigProvider } from "@ant-design/pro-components";', '');
      code = replace(code, '<ProConfigProvider dark={dark}>', '<>');
      code = replace(code, '</ProConfigProvider>', '</>');
    }
    if (name === "lib/app-theme.ts") code = replace(code, 'token: {', 'token: { fontFamily: \'"Segoe UI", "Microsoft YaHei", sans-serif\', fontSize: 13,');
    if (name === "components/image-settings-panel.tsx") code = replace(code, 'maxCount = 15, quickCount = 10', 'maxCount = 4, quickCount = 4');
    if (name === "pages/image/index.tsx") code = replace(code, 'maxCount={10}', 'maxCount={4}');
    if (["pages/image/index.tsx", "pages/video/index.tsx", "components/canvas/canvas-config-node-panel.tsx", "components/canvas/canvas-node-prompt-panel.tsx", "components/model-picker.tsx"].includes(name)) {
      code = `import { useStudioModels } from "${path("./src/model-state.ts").replaceAll("\\", "/")}";\n${code}`;
      if (name !== "components/model-picker.tsx") code = `import { studioModelUsable } from "${path("./src/model-selection.ts").replaceAll("\\", "/")}";\n${code}`;
      if (name.startsWith("pages/")) {
        const capability = name.includes("/image/") ? "image" : "video";
        code = replace(code, 'const canGenerate = Boolean(prompt.trim());', `const modelsReady = useStudioModels(state => state.status === "ready" && state.executionAllowed);\n    const canGenerate = modelsReady && studioModelUsable(effectiveConfig, model, "${capability}") && Boolean(prompt.trim());`);
        code = replace(code, 'const generate = async () => {', `const generate = async () => {\n        if (useStudioModels.getState().status !== "ready" || !useStudioModels.getState().executionAllowed || !studioModelUsable(effectiveConfig, model, "${capability}")) return;`);
      }
      else if (name.endsWith("canvas-config-node-panel.tsx")) {
        code = replace(code, 'const globalConfig = useEffectiveConfig();', 'const globalConfig = useEffectiveConfig();\n    const modelsReady = useStudioModels(state => state.status === "ready" && state.executionAllowed);');
        code = replace(code, 'disabled={!isRunning && !canGenerate}', 'disabled={!isRunning && (!modelsReady || !studioModelUsable(config, config.model, mode) || !canGenerate)}');
      } else if (name.endsWith("canvas-node-prompt-panel.tsx")) {
        code = replace(code, 'const globalConfig = useEffectiveConfig();', 'const globalConfig = useEffectiveConfig();\n    const modelsReady = useStudioModels(state => state.status === "ready" && state.executionAllowed);');
        code = replace(code, 'disabled={!isRunning && !prompt.trim()}', 'disabled={!isRunning && (!modelsReady || !studioModelUsable(config, config.model, mode) || !prompt.trim())}');
        code = replace(code, 'if (!text || isRunning) return;', 'if (!modelsReady || !studioModelUsable(config, config.model, mode) || !text || isRunning) return;');
      } else {
        code = replace(code, 'const pickerId = useId();', 'const pickerId = useId();\n    const modelsReady = useStudioModels(state => state.status === "ready");');
        code = replace(code, '<SelectTrigger', '<SelectTrigger disabled={!modelsReady}');
      }
    }
    if (name === "stores/use-asset-store.ts") {
      code = `import { assetMetadata } from "${path("./src/asset-media.tsx").replaceAll("\\", "/")}";\n${code}`;
      code = `import { catalogueProjectionActive } from "${path("./src/asset-catalogue.ts").replaceAll("\\", "/")}";\n${code}`;
      code = replaceSection(code, '        parsed.state.assets = await Promise.all(', '        return parsed;', '        parsed.state.assets = parsed.state.assets.map(assetMetadata);\n');
      code = replace(code, 'partialize: (state) => ({ assets: state.assets })', 'partialize: (state) => ({ assets: state.assets.map(assetMetadata) })');
      code = replace(code, 'setItem: (name, value) => localForageStorage.setItem(name, JSON.stringify(value)),', 'setItem: (name, value) => catalogueProjectionActive() ? Promise.resolve() : localForageStorage.setItem(name, JSON.stringify(value)),');
    }
    if (["pages/assets/index.tsx", "components/canvas/asset-picker-modal.tsx", "components/canvas/canvas-side-panel.tsx"].includes(name)) {
      code = `import { AssetThumbnail, withAssetOriginal } from "${path("./src/asset-media.tsx").replaceAll("\\", "/")}";\n${code}`;
      if (name === "pages/assets/index.tsx") {
        code = replace(code, 'onOpen={() => setPreviewAsset(asset)} onEdit={() => openEdit(asset)}', 'onOpen={() => void withAssetOriginal(asset, setPreviewAsset)} onEdit={() => void withAssetOriginal(asset, openEdit)}');
        code = replaceSection(code, '                    {cover ? (', '                </button>\n            }', '                    <AssetThumbnail asset={asset} />\n');
      } else if (name.endsWith("asset-picker-modal.tsx")) {
        code = replace(code, 'function PickerCard({ title, kind, cover, onClick }: { title: string; kind: string; cover: string; onClick: () => void }) {', 'function PickerCard({ title, kind, asset, onClick }: { title: string; kind: string; asset: Asset; onClick: () => void }) {');
        code = replaceSection(code, '            {cover ? (', '            <div className="p-2.5">', '            <AssetThumbnail asset={asset} />\n');
        code = replace(code, 'cover={assetCoverUrl(asset)} onClick={() => handleInsert(asset)}', 'asset={asset} onClick={() => void withAssetOriginal(asset, handleInsert, true)}');
      } else {
        code = replace(code, 'onInsert={() => onInsert(buildInsertPayload(asset))}', 'onInsert={() => void withAssetOriginal(asset, resolved => onInsert(buildInsertPayload(resolved)), true)}');
        code = replaceSection(code, 'function AssetCover({ asset }: { asset: Asset }) {', '// ---------------------------------------------------------------------------\n// Prompt library tab:', 'function AssetCover({ asset }: { asset: Asset }) {\n    return <AssetThumbnail asset={asset} className="size-full" />;\n}\n\n');
      }
    }
    if (name === "pages/video/index.tsx") code = code.replaceAll('7 - references.length', '1 - references.length');
    if (name === "i18n/locales/zh-CN.ts") code = replace(code, '暂无参考图，可拖入文件，最多 9 张', '可上传 1 张首帧参考图，生成前需完成素材审核');
    if (name === "components/video-settings-panel.tsx") {
      code = replace(code, '<SettingGroup title={t("settingsPanels.video.mode")} color={theme.node.muted}>', '{false && <SettingGroup title={t("settingsPanels.video.mode")} color={theme.node.muted}>');
      code = replace(code, '</SettingGroup>\n            </div>\n        </ImageSettingsTheme>', '</SettingGroup>}\n            </div>\n        </ImageSettingsTheme>');
      code = replace(code, 'export function videoModeLabel(value: string) {', 'export function videoModeLabel(value: string) { return "单张首帧";');
    }
    if (name === "stores/use-config-store.ts") {
      code = 'import { openSettings } from "' + path("./src/rpc.ts").replaceAll("\\", "/") + '";\n' + code;
      code = replace(code, 'return Boolean(match && match.channel.baseUrl.trim() && match.channel.apiKey.trim());', 'return Boolean(match && match.channel.id);');
      code = replace(code, 'openConfigDialog: (shouldPromptContinue = false, configTab = "channels") => set({ isConfigOpen: true, shouldPromptContinue, configTab }),', 'openConfigDialog: () => openSettings(),');
      code = replace(code, 'name: CONFIG_STORE_KEY,', 'name: CONFIG_STORE_KEY, storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },');
    }
    // adaptStudioDraft owns the exact native persistence timer above. Keeping
    // the old immediate-write replacement here would consume its anchor twice.
    if (name === "services/api/image.ts") {
      code = `import { studioImages, studioText } from "${path("./src/generation.ts").replaceAll("\\", "/")}";\n${code}`;
      code = replace(code, 'export async function requestGeneration(config: AiConfig, prompt: string, options?: RequestOptions) {', 'export async function requestGeneration(config: AiConfig, prompt: string, options?: RequestOptions) { return studioImages(config, prompt, [], options);');
      code = replace(code, 'export async function requestEdit(config: AiConfig, prompt: string, references: ReferenceImage[], options?: RequestOptions) {', 'export async function requestEdit(config: AiConfig, prompt: string, references: ReferenceImage[], options?: RequestOptions) { return studioImages(config, prompt, references, options);');
      code = replace(code, 'export async function requestImageQuestion(config: AiConfig, messages: AiTextMessage[], onDelta: (text: string) => void, options?: RequestOptions) {', 'export async function requestImageQuestion(config: AiConfig, messages: AiTextMessage[], onDelta: (text: string) => void, options?: RequestOptions) { return studioText(config, messages, onDelta, options);');
    }
    if (name === "services/api/video.ts") {
      code = `import { studioVideo, pollStudioVideo } from "${path("./src/generation.ts").replaceAll("\\", "/")}";\n${code}`;
      code = replace(code, 'export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: VideoMediaOptions): Promise<VideoGenerationTask> {', 'export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: VideoMediaOptions): Promise<VideoGenerationTask> { return studioVideo(config, prompt, references, options);');
      code = replace(code, 'export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {', 'export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> { return pollStudioVideo(task);');
    }
    // Media lifecycle belongs to the ERP. A tool's local history cleanup cannot delete files used by another tool.
    if (name === "services/image-storage.ts") code = code.replace(/export async function cleanupUnusedImages\([^\n]+\) \{/, '$& return;');
    if (name === "services/file-storage.ts") code = replace(code, 'export async function cleanupUnusedMedia(usedData: unknown) {', 'export async function cleanupUnusedMedia(usedData: unknown) { return;');
    return { code, map: null };
  } };
}
export default defineConfig({
  publicDir: "vendor/public", plugins: [studioRuntimeAdapter(), react()],
  resolve: { alias: [
    { find: "upstream-channel-editor", replacement: path("./vendor/src/components/layout/channel-editor-drawer.tsx") },
    { find: "@/components/canvas/canvas-top-bar", replacement: path("./src/canvas-top-bar.tsx") },
    { find: "@/components/layout/client-root-init", replacement: path("./src/client-root-init.tsx") },
    { find: "@/lib/localforage-storage", replacement: path("./src/localforage-storage.ts") },
    { find: "@/services/api/prompts", replacement: path("./src/prompts.ts") },
    { find: "localforage", replacement: path("./src/storage.ts") },
    { find: "@", replacement: path("./vendor/src") },
  ] },
  define: { __APP_VERSION__: JSON.stringify(`${upstream.tag.slice(1)}-erp.${upstream.adapterVersion}`), __APP_RELEASES__: "[]" },
  build: { chunkSizeWarningLimit: 2500, rollupOptions: { output: { manualChunks: { react: ["react", "react-dom", "react-router-dom"] } } } },
});
