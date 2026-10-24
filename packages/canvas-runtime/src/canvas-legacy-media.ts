type OriginalField = { present: boolean; value?: string };
const originalFields = new Map<string, OriginalField>();

/** Display URLs never become document content. New keyed media persists an
 * empty content field; restored media keeps its exact original field instead. */
export function createCanvasDisplayUrl(blob: Blob, original: OriginalField = { present: true, value: "" }) {
  const url = URL.createObjectURL(blob);
  originalFields.set(url, original); return url;
}
export function revokeCanvasDisplayUrl(url: string) {
  URL.revokeObjectURL(url); originalFields.delete(url);
}
/** A legacy embedded original may be displayed locally. This is not a server
 * inspection and never creates a media entry, rights approval or new version. */
export function restoreLegacyImage(dataUri: string, signal: AbortSignal, current: () => boolean) {
  signal.throwIfAborted();
  if (!current()) throw new DOMException("原画布读取已结束", "AbortError");
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUri);
  if (!match || match[2]!.length > 28_000_000) throw new Error("历史嵌入图片格式暂不支持 原文档保持");
  const binary = atob(match[2]!);
  if (!binary.length || binary.length > 20 * 1024 * 1024 || btoa(binary) !== match[2]) throw new Error("历史嵌入图片无法读取 原文档保持");
  const url = createCanvasDisplayUrl(new Blob([Uint8Array.from(binary, char => char.charCodeAt(0))], { type: match[1] }), { present: true, value: dataUri });
  const revoke = () => revokeCanvasDisplayUrl(url);
  signal.addEventListener("abort", revoke, { once: true });
  return url;
}
/** Global Zustand state outlives a canvas mount. Restore original fields in
 * that state before another canvas causes a whole-store save or URL revocation. */
export function persistedCanvasOriginals<T>(value: T): T {
  if (typeof value === "string") { const original = originalFields.get(value); return (original ? original.value : value) as T; }
  if (Array.isArray(value)) return value.map(persistedCanvasOriginals) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const original = typeof item === "string" ? originalFields.get(item) : undefined;
    return original && !original.present ? [] : [[key, persistedCanvasOriginals(item)]];
  })) as T;
  return value;
}
