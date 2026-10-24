export interface EditorHistory<T> { past: T[]; present: T; future: T[] }
const historyLimit = 60;

export function createEditorHistory<T>(value: T): EditorHistory<T> {
  return { past: [], present: structuredClone(value), future: [] };
}

export function commitEditorHistory<T>(history: EditorHistory<T>, next: T): EditorHistory<T> {
  if (JSON.stringify(history.present) === JSON.stringify(next)) return history;
  return { past: [...history.past, history.present].slice(-historyLimit), present: structuredClone(next), future: [] };
}

export function undoEditorHistory<T>(history: EditorHistory<T>): EditorHistory<T> {
  const previous = history.past.at(-1);
  if (previous === undefined) return history;
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] };
}

export function redoEditorHistory<T>(history: EditorHistory<T>): EditorHistory<T> {
  const next = history.future[0];
  if (next === undefined) return history;
  return { past: [...history.past, history.present].slice(-historyLimit), present: next, future: history.future.slice(1) };
}

export function safeEditorFileName(name: string): string {
  return [...name].map((character) => character.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(character) ? "_" : character).join("") || "production-file";
}

export function editorViewport(widthMm: number, heightMm: number, availableWidth: number, zoom = 1) {
  const width = Math.min(1400, Math.max(260, availableWidth));
  const height = Math.min(900, Math.max(360, width * 0.78));
  const fit = Math.min((width - 48) / Math.max(1, widthMm), (height - 48) / Math.max(1, heightMm));
  const scale = fit * Math.max(0.25, Math.min(4, zoom));
  return { width, height, scale, left: (width - widthMm * scale) / 2, top: (height - heightMm * scale) / 2 };
}
