import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import { Plus, Save } from "lucide-react";
import { STUDIO_IMAGE_DRAFT_KEY, STUDIO_VIDEO_DRAFT_KEY } from "@yummyai/contracts/pod/studio-document-transfer";
import type { StudioWorkspace } from "@yummyai/contracts/pod/studio-personal";
import type { AiConfig } from "@/stores/use-config-store";
import { initialized, rpc } from "./rpc";
import { decodeBlob } from "./storage";
import { createStoredWorkbenchDraft } from "./workbench-draft-persistence";
import { createWorkbenchDraft, draftConfig, type DraftReference } from "./workbench-draft";
type Kind = "image" | "video";
type Controller = ReturnType<typeof createWorkbenchDraft>;
const controllers = new Map<Kind, Controller>();
const editableConfigs = new Map<Kind, Record<string, string>>();
let workspace: StudioWorkspace | undefined, owner = "", cleared = false;
const identity = (value?: StudioWorkspace) => value ? JSON.stringify([value.scope, value.contextAuthority]) : "";
function configure(next?: StudioWorkspace) {
  if (cleared && next) return;
  const key = identity(next); workspace = next;
  if (key === owner) return;
  owner = key; for (const item of controllers.values()) item.stop(); controllers.clear(); editableConfigs.clear();
  window.dispatchEvent(new Event("studio.draft-owner"));
}
void initialized.then(init => configure(init.workspace));
window.addEventListener("studio.workspace", event => configure((event as CustomEvent).detail.workspace));
window.addEventListener("studio.storage-clear", () => { cleared = true; configure(undefined); });
function controller(kind: Kind, config: AiConfig) {
  editableConfigs.set(kind, draftConfig(kind, config));
  const prior = controllers.get(kind); if (prior) return prior;
  if (!workspace) {
    const item = createWorkbenchDraft({ current: () => false, canSave: () => false, id: () => crypto.randomUUID(), config: () => ({}), load: async () => null, save: async () => undefined });
    controllers.set(kind, item); return item;
  }
  const captured = owner, key = kind === "image" ? STUDIO_IMAGE_DRAFT_KEY : STUDIO_VIDEO_DRAFT_KEY;
  const item = createStoredWorkbenchDraft({ key, owner: captured, current: () => captured === owner,
    available: () => workspace?.documentTransferVersion === 1, canSave: () => workspace?.documentTransferVersion === 1 && workspace.capabilities.save,
    id: () => crypto.randomUUID(), config: () => ({ ...editableConfigs.get(kind) }),
  });
  controllers.set(kind, item); void item.load(); return item;
}

export function useWorkbenchDraft(kind: Kind, config: AiConfig, nativeUpdate: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void) {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => { const changed = () => setEpoch(value => value + 1); window.addEventListener("studio.draft-owner", changed); return () => window.removeEventListener("studio.draft-owner", changed); }, []);
  const item = controller(kind, config), snapshot = useSyncExternalStore(item.subscribe, item.snapshot), active = item.active();
  const [prompt, setLocalPrompt] = useState(""), [references, setLocalReferences] = useState<DraftReference[]>([]), [referenceError, setReferenceError] = useState("");
  const promptInput = useRef(prompt), referenceInput = useRef(references);
  useLayoutEffect(() => {
    if (!snapshot.ready) { promptInput.current = ""; referenceInput.current = []; setLocalPrompt(""); setLocalReferences([]); setReferenceError(""); return; }
    const abort = new AbortController(), urls: string[] = [];
    promptInput.current = active?.prompt ?? ""; referenceInput.current = active?.references ?? [];
    setLocalPrompt(promptInput.current); setLocalReferences(referenceInput.current); setReferenceError("");
    for (const [key, value] of Object.entries(draftConfig(kind, active?.config ?? {}))) nativeUpdate(key as keyof AiConfig, value);
    void Promise.all((active?.references ?? []).map(async reference => {
      if (!reference.storageKey) return reference;
      const result = await rpc<{ media?: { contentBase64: string; mediaType: string } }>({ operation: "state.get", namespace: "image_files", key: reference.storageKey }, { signal: abort.signal });
      abort.signal.throwIfAborted(); if (!result.media) throw new Error("草稿引用的原图暂不可读取 输入与原引用保持");
      const url = URL.createObjectURL(decodeBlob(result.media)); urls.push(url); return { ...reference, dataUrl: url };
    })).then(value => { if (!abort.signal.aborted) {
      const restored = new Map(value.map(reference => [reference.id, reference]));
      referenceInput.current = referenceInput.current.map(reference => { const original = restored.get(reference.id); return original?.storageKey === reference.storageKey ? original ?? reference : reference; });
      setLocalReferences(referenceInput.current);
    } }).catch(cause => { if (!abort.signal.aborted) setReferenceError(cause instanceof Error ? cause.message : "原图暂不可读取"); });
    return () => { abort.abort(); for (const url of urls) URL.revokeObjectURL(url); };
    // Select and initial hydration restore one exact draft. Normal keystrokes
    // already update local display and must not restart its original reads.
  }, [snapshot.ready, snapshot.document.activeId, item, epoch]);
  const safely = (action: () => void) => { try { action(); } catch (cause) { setReferenceError(cause instanceof Error ? cause.message : "当前输入未采用"); } };
  const setPrompt: Dispatch<SetStateAction<string>> = next => safely(() => { const value = typeof next === "function" ? next(promptInput.current) : next; item.update({ prompt: value }); promptInput.current = value; setLocalPrompt(value); });
  const setReferences: Dispatch<SetStateAction<DraftReference[]>> = next => safely(() => { const value = typeof next === "function" ? next(referenceInput.current) : next; item.update({ references: value }); referenceInput.current = value; setLocalReferences(value); });
  const updateConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => safely(() => { item.update({ config: { ...(item.active()?.config ?? draftConfig(kind, config)), ...draftConfig(kind, { [key]: value }) } }); nativeUpdate(key, value); });
  return { prompt, setPrompt, references, setReferences, updateConfig, draft: { ...snapshot, writable: workspace?.documentTransferVersion === 1 && workspace.capabilities.save, referenceError,
    choose: (id: string) => safely(() => item.choose(id)), create: () => safely(() => item.create()), retryRead: () => void item.load(),
    retrySave: () => safely(() => { void item.retrySave()?.catch(() => undefined); }),
  } };
}
export function WorkbenchDraftBar({ draft }: { draft: ReturnType<typeof useWorkbenchDraft>["draft"] }) {
  return <div className="studio-input-draft" role="region" aria-label="输入草稿">
    <label>输入草稿<select aria-label="选择输入草稿" disabled={!draft.ready || !draft.writable} value={draft.document.activeId ?? ""} onChange={event => draft.choose(event.target.value)}><option value="" disabled>选择已复制草稿或开始输入</option>{draft.document.drafts.map((item, index) => <option key={item.id} value={item.id}>{index + 1} · {item.prompt.slice(0, 40) || "空白输入"}</option>)}</select></label>
    <button type="button" disabled={!draft.ready || !draft.writable} onClick={draft.create}><Plus size={14} />新草稿</button>
    <span role="status">{!draft.ready ? "正在读取原输入草稿" : draft.error ? "输入仍保留 保存尚未确认" : !draft.writable ? "当前输入只读" : "输入自动保存"}</span>
    {(draft.error || draft.referenceError) && <p role="alert">{draft.error || draft.referenceError}{!draft.ready ? <button type="button" onClick={draft.retryRead}>重试读取</button> : draft.error && <button type="button" onClick={draft.retrySave}><Save size={14} />保存当前输入</button>}</p>}
    <style>{`.studio-input-draft{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid #dfe4ec;background:white;font-size:12px;animation:studio-draft-in .18s ease-out}.studio-input-draft label{display:flex;gap:6px;align-items:center;min-width:0}.studio-input-draft select{max-width:240px;min-width:0;border:1px solid #dfe4ec;border-radius:5px;padding:5px}.studio-input-draft button{display:inline-flex;align-items:center;gap:4px;border:1px solid #dfe4ec;background:white;border-radius:5px;padding:5px 8px;transition:transform .14s,background .14s}.studio-input-draft button:hover:enabled{transform:translateY(-1px);background:#eff5ff}.studio-input-draft button:active:enabled{transform:scale(.98)}.studio-input-draft p{width:100%;overflow-wrap:anywhere;color:#a12727;margin:0}@keyframes studio-draft-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:translateY(0)}}@media(max-width:500px){.studio-input-draft label{width:100%}.studio-input-draft select{flex:1}}@media(prefers-reduced-motion:reduce){.studio-input-draft,.studio-input-draft button{animation:none;transition:none;transform:none!important}}`}</style>
  </div>;
}
