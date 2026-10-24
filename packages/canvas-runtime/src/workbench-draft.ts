export type DraftReference = { id: string; name: string; type: string; dataUrl: string; storageKey?: string };
export type WorkbenchDraft = { id: string; prompt: string; references: DraftReference[]; config: Record<string, string>; [key: string]: unknown };
export type WorkbenchDraftDocument = { version: 1; drafts: WorkbenchDraft[]; activeId: string | null };
type State = { ready: boolean; error: string; document: WorkbenchDraftDocument };
const editable = { image: ["model", "imageModel", "size", "quality", "count"], video: ["model", "videoModel", "size", "vquality", "videoSeconds", "videoGenerateAudio", "videoWatermark", "videoMode"] };
export function draftConfig(kind: "image" | "video", config: object) {
  const input = config as Record<string, unknown>;
  return Object.fromEntries(editable[kind].flatMap(key => typeof input[key] === "string" ? [[key, input[key]]] : [])) as Record<string, string>;
}
export function readDraftDocument(value: unknown): WorkbenchDraftDocument {
  if (value === null) return { version: 1, drafts: [], activeId: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("原输入草稿格式不可读取 未覆盖原记录");
  const document = value as WorkbenchDraftDocument;
  if (document.version !== 1 || !Array.isArray(document.drafts) || document.drafts.length > 1000 || !(document.activeId === null || typeof document.activeId === "string") ||
    document.drafts.some(item => !item || typeof item.id !== "string" || typeof item.prompt !== "string" || !Array.isArray(item.references) || !item.config || typeof item.config !== "object" || Array.isArray(item.config) || Object.values(item.config).some(value => typeof value !== "string") || item.references.some(ref => !ref || typeof ref.id !== "string" || typeof ref.name !== "string" || typeof ref.type !== "string" || typeof ref.dataUrl !== "string" || ref.storageKey !== undefined && typeof ref.storageKey !== "string")) ||
    new Set(document.drafts.map(item => item.id)).size !== document.drafts.length || document.activeId !== null && !document.drafts.some(item => item.id === document.activeId)) throw new Error("原输入草稿格式不可读取 未覆盖原记录");
  return structuredClone(document);
}
export function createWorkbenchDraft(options: { load: () => Promise<unknown>; save: (value: WorkbenchDraftDocument) => Promise<unknown>; stage?: (value: WorkbenchDraftDocument, editSeq: number) => void; onStop?: () => void; current: () => boolean; canSave: () => boolean; canRetry?: () => boolean; id: () => string; config: () => Record<string, string> }) {
  let state: State = { ready: false, error: "", document: { version: 1, drafts: [], activeId: null } }, stopped = false, dirty = false, failed = false, editSeq = 0, saving: Promise<void> | undefined;
  const listeners = new Set<() => void>(), current = () => !stopped && options.current();
  const emit = () => { state = { ...state }; for (const listener of listeners) listener(); };
  const assert = () => { if (!current()) throw new DOMException("草稿归属已变化", "AbortError"); };
  const empty = (): WorkbenchDraft => ({ id: options.id(), prompt: "", references: [], config: options.config() });
  const load = async () => {
    if (state.ready && (dirty || saving || failed)) { state.error = "当前输入仍有未确认保存 原输入保留 请先只读核对"; emit(); return; }
    try { const value = readDraftDocument(await options.load()); assert();
      if (state.ready && (dirty || saving || failed)) { state.error = "当前输入仍有未确认保存 原输入保留 请先只读核对"; emit(); return; }
      state.document = value; state.ready = true; state.error = ""; emit(); }
    catch (cause) { if (current()) { state.error = cause instanceof Error ? cause.message : "输入草稿暂时无法读取"; emit(); } }
  };
  const persist = () => {
    if (saving || failed || !dirty || !current()) return saving;
    if (!options.canSave()) { failed = true; state.error = "当前范围仅可查看 输入尚未保存"; emit(); return; }
    const value = structuredClone(state.document); dirty = false;
    saving = options.save(value).then(() => { assert(); state.error = ""; }, cause => { if (current()) { dirty = true; failed = true; state.error = cause instanceof Error ? cause.message : "输入尚未保存 请保留原稿"; } throw cause; })
      .finally(() => { saving = undefined; if (current()) { emit(); if (dirty && !failed) void persist(); } });
    void saving.catch(() => undefined); return saving;
  };
  const change = (mutate: (document: WorkbenchDraftDocument) => void) => {
    assert(); if (!state.ready) throw new Error("原草稿尚未读取 请先重试读取"); if (!options.canSave()) throw new Error("当前范围仅可查看 输入未保存");
    const document = structuredClone(state.document), sequence = editSeq + 1;
    mutate(document); options.stage?.(document, sequence);
    state.document = document; editSeq = sequence; dirty = true; if (!failed) state.error = ""; emit(); void persist();
  };
  return { load, snapshot: () => state, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    active: () => state.document.drafts.find(item => item.id === state.document.activeId),
    update(patch: Partial<Pick<WorkbenchDraft, "prompt" | "references" | "config">>) { change(document => {
      let item = document.drafts.find(item => item.id === document.activeId);
      if (!item) { item = empty(); document.drafts.push(item); document.activeId = item.id; }
      Object.assign(item, structuredClone(patch));
      item.references = item.references.map(ref => ({ ...ref, dataUrl: ref.storageKey ? "" : ref.dataUrl }));
    }); },
    choose(id: string) { change(document => { if (!document.drafts.some(item => item.id === id)) throw new Error("所选草稿不存在"); document.activeId = id; }); },
    create() { change(document => { const item = empty(); document.drafts.push(item); document.activeId = item.id; }); },
    /** Only the persistence adapter supplies the sequence of the body actually
     * sent. An older ACK must never clear a newer local edit. */
    confirmPersisted(value: WorkbenchDraftDocument, sequence: number) {
      assert(); if (sequence !== editSeq) return;
      const signature = (document: WorkbenchDraftDocument) => JSON.stringify(document, (_key, item: unknown) => item !== null && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
      if (signature(value) !== signature(state.document)) return;
      dirty = false; failed = false; state.error = ""; emit();
    },
    retrySave() { assert(); if (!options.canSave() || !options.canRetry?.()) throw new Error("请先只读核对原保存结果 再明确保存当前输入"); failed = false; state.error = ""; dirty = true; emit(); return persist(); },
    async flush() { assert(); if (!state.ready) throw new Error(state.error || "输入草稿尚未读取");
      for (let attempt = 0; attempt < 50; attempt++) {
        assert(); if (saving) await saving; else if (dirty) { if (state.error) throw new Error(state.error); await persist(); }
        if (!saving && !dirty) { assert(); return; }
      }
      throw new Error("输入仍在更新 请停止编辑后重试复制");
    },
    stop() { if (stopped) return; stopped = true; options.onStop?.(); listeners.clear(); },
  };
}
