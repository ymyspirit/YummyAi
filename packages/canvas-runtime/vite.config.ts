import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { adaptConfiguration } from "./configuration-adapter";
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
function adapter(): Plugin {
  return { name: "yummyai-canvas-adapter", enforce: "pre", transform(code, id) {
    const name = id.replaceAll("\\", "/").split("/vendor/src/")[1];
    if (!name) return;
    code = code.replaceAll("\r\n", "\n");
    code = adaptConfiguration(code, name);
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
      if (name.startsWith("pages/")) {
        code = replace(code, 'const canGenerate = Boolean(prompt.trim());', 'const modelsReady = useStudioModels(state => state.status === "ready");\n    const canGenerate = modelsReady && Boolean(prompt.trim());');
        code = replace(code, 'const generate = async () => {', 'const generate = async () => {\n        if (useStudioModels.getState().status !== "ready") return;');
      }
      else if (name.endsWith("canvas-config-node-panel.tsx")) {
        code = replace(code, 'const globalConfig = useEffectiveConfig();', 'const globalConfig = useEffectiveConfig();\n    const modelsReady = useStudioModels(state => state.status === "ready");');
        code = replace(code, 'disabled={!isRunning && !canGenerate}', 'disabled={!isRunning && (!modelsReady || !canGenerate)}');
      } else if (name.endsWith("canvas-node-prompt-panel.tsx")) {
        code = replace(code, 'const globalConfig = useEffectiveConfig();', 'const globalConfig = useEffectiveConfig();\n    const modelsReady = useStudioModels(state => state.status === "ready");');
        code = replace(code, 'disabled={!isRunning && !prompt.trim()}', 'disabled={!isRunning && (!modelsReady || !prompt.trim())}');
        code = replace(code, 'if (!text || isRunning) return;', 'if (!modelsReady || !text || isRunning) return;');
      } else {
        code = replace(code, 'const pickerId = useId();', 'const pickerId = useId();\n    const modelsReady = useStudioModels(state => state.status === "ready");');
        code = replace(code, '<SelectTrigger', '<SelectTrigger disabled={!modelsReady}');
      }
    }
    if (name === "stores/use-asset-store.ts") {
      code = `import { assetMetadata } from "${path("./src/asset-media.tsx").replaceAll("\\", "/")}";\n${code}`;
      code = replaceSection(code, '        parsed.state.assets = await Promise.all(', '        return parsed;', '        parsed.state.assets = parsed.state.assets.map(assetMetadata);\n');
      code = replace(code, 'partialize: (state) => ({ assets: state.assets })', 'partialize: (state) => ({ assets: state.assets.map(assetMetadata) })');
    }
    if (["pages/assets/index.tsx", "components/canvas/asset-picker-modal.tsx", "components/canvas/canvas-side-panel.tsx"].includes(name)) {
      code = `import { AssetThumbnail, withAssetOriginal } from "${path("./src/asset-media.tsx").replaceAll("\\", "/")}";\n${code}`;
      if (name === "pages/assets/index.tsx") {
        code = replace(code, 'onOpen={() => setPreviewAsset(asset)} onEdit={() => openEdit(asset)}', 'onOpen={() => void withAssetOriginal(asset, setPreviewAsset)} onEdit={() => void withAssetOriginal(asset, openEdit)}');
        code = replaceSection(code, '                    {cover ? (', '                </button>\n            }', '                    <AssetThumbnail asset={asset} />\n');
      } else if (name.endsWith("asset-picker-modal.tsx")) {
        code = replace(code, 'function PickerCard({ title, kind, cover, onClick }: { title: string; kind: string; cover: string; onClick: () => void }) {', 'function PickerCard({ title, kind, asset, onClick }: { title: string; kind: string; asset: Asset; onClick: () => void }) {');
        code = replaceSection(code, '            {cover ? (', '            <div className="p-2.5">', '            <AssetThumbnail asset={asset} />\n');
        code = replace(code, 'cover={asset.coverUrl || (asset.kind === "image" ? asset.data.dataUrl : "")} onClick={() => handleInsert(asset)}', 'asset={asset} onClick={() => void withAssetOriginal(asset, handleInsert)}');
      } else {
        code = replace(code, 'onInsert={() => onInsert(buildInsertPayload(asset))}', 'onInsert={() => void withAssetOriginal(asset, resolved => onInsert(buildInsertPayload(resolved)))}');
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
      code = replace(code, 'return Boolean(model.trim() && channel.baseUrl.trim() && channel.apiKey.trim());', 'return Boolean(model.trim() && channel.id && channel.models.some(item => model.endsWith("::" + item.name)));');
      code = replace(code, 'openConfigDialog: (shouldPromptContinue = false, configTab = "channels") => set({ isConfigOpen: true, shouldPromptContinue, configTab }),', 'openConfigDialog: () => openSettings(),');
      code = replace(code, 'name: CONFIG_STORE_KEY,', 'name: CONFIG_STORE_KEY, storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },');
    }
    if (name === "stores/canvas/use-canvas-store.ts") code = replace(code, 'saveTimer = setTimeout(() => {\n            saveTimer = null;\n            void localForageStorage.setItem(name, JSON.stringify(value));\n        }, 400);', 'return localForageStorage.setItem(name, JSON.stringify(value));');
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
  publicDir: "vendor/public", plugins: [adapter(), react()],
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
