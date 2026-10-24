import { useSyncExternalStore } from "react";
import { Settings2 } from "lucide-react";
import type { AiConfig, ModelCapability } from "@/stores/use-config-store";
import { isStudioRuntimeConfig, selectStudioConfigModel, studioModelCatalogue, type StudioModelSelection } from "./model-selection";
import { openSettings } from "./rpc";
import { useStudioModels } from "./model-state";

export function useStudioModelPicker(config: AiConfig, value: string | undefined, capability?: ModelCapability) {
  const state = useSyncExternalStore(studioModelCatalogue.subscribe, studioModelCatalogue.snapshot, studioModelCatalogue.snapshot);
  return isStudioRuntimeConfig(config) && capability ? selectStudioConfigModel(config, value, capability, state) : undefined;
}
export function StudioModelSelectionNotice({ selection }: { selection?: StudioModelSelection }) {
  const canConfigure = useStudioModels(state => state.canConfigure);
  return <StudioModelSelectionNoticeView selection={selection} canConfigure={canConfigure} onConfigure={openSettings} />;
}
export function StudioModelSelectionNoticeView({ selection, canConfigure, onConfigure }: { selection?: StudioModelSelection; canConfigure: boolean; onConfigure: () => void }) {
  if (!selection || selection.status === "ready") return null;
  const separator = selection.original.indexOf("::"), originalName = separator < 0 ? selection.original : selection.original.slice(separator + 2);
  return <div className="studio-model-selection-notice" data-studio-model-state={selection.status} role="status">
    <span>{selection.message}</span>{selection.original && <span className="studio-original-model">原选择 {originalName}</span>}
    {!["loading", "failed", "unsupported"].includes(selection.status) && <button type="button" disabled={!canConfigure} onClick={onConfigure}><Settings2 size={12} />{canConfigure ? "打开 ERP 模型配置" : "需要模型配置权限"}</button>}
    <style>{`.studio-model-selection-notice{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 0;color:var(--foreground,#202124);font-size:11px;line-height:1.5;overflow-wrap:anywhere;animation:studio-status-appear .16s ease-out;transition:opacity .16s,transform .16s}.studio-original-model{flex-basis:100%;color:#656b76;word-break:break-all}.studio-model-selection-notice button{display:inline-flex;gap:4px;align-items:center;border:1px solid var(--border,#e4e5e9);padding:3px 6px;color:inherit;background:var(--background,#fff);cursor:pointer;transition:transform .14s,background-color .14s}.studio-model-selection-notice button:hover:enabled{transform:translateY(-1px);background:#eff5ff}.studio-model-selection-notice button:active:enabled{transform:scale(.98)}@media(prefers-reduced-motion:reduce){.studio-model-selection-notice,.studio-model-selection-notice button{animation:none;transition:none;transform:none!important}}`}</style>
  </div>;
}
