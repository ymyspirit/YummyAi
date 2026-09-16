import { initialized, notify, rpc } from "./rpc";
const persistent = new Set(["app_state", "image_files", "media_files", "image_generation_logs", "video_generation_logs"]);
const revisions = new Map<string, number>(), cache = new Map<string, unknown>();
const chains = new Map<string, Promise<unknown>>();
const scheduled = new Map<string, Promise<unknown>>();
const failures = new Map<string, () => Promise<unknown>>();
let pending = 0;
function status() { notify("studio.storage", { pending, error: failures.size ? "保存未完成，请重试或导出当前画布备份" : null }); }
export async function encodeBlob(blob: Blob) { const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = ""; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); return { contentBase64: btoa(binary), mediaType: blob.type }; }
export function decodeBlob(media: { contentBase64: string; mediaType: string }) { const value = atob(media.contentBase64); return new Blob([Uint8Array.from(value, char => char.charCodeAt(0))], { type: media.mediaType }); }
function instance(namespace: string) {
  const address = (key: string) => `${namespace}/${key}`;
  const api = {
    async getItem<T>(key: string): Promise<T | null> {
      const at = address(key);
      if (cache.has(at)) return cache.get(at) as T;
      if (!persistent.has(namespace)) return null;
      await initialized;
      const result = await rpc<{ revision: number; value?: T; media?: { contentBase64: string; mediaType: string } }>({ operation: "state.get", namespace, key }).catch(cause => { notify(namespace === "app_state" ? "studio.read-error" : "studio.error", { error: cause instanceof Error ? cause.message : "创作记录读取失败" }); throw cause; });
      revisions.set(at, result.revision);
      const value = result.media ? decodeBlob(result.media) : result.value ?? null;
      cache.set(at, value); return value as T | null;
    },
    async setItem<T>(key: string, value: T): Promise<T> {
      const at = address(key);
      if (!persistent.has(namespace)) { cache.set(at, value); return value; }
      await initialized;
      // Do not write an empty document when hydration failed. First establish its server revision.
      if (!revisions.has(at)) {
        if (namespace === "app_state") throw new Error("项目尚未成功读取，请重新连接后再编辑");
        await api.getItem(key);
      }
      cache.set(at, value);
      const alreadyScheduled = scheduled.get(at);
      if (alreadyScheduled) return alreadyScheduled as Promise<T>;
      const save = async () => {
        const latest = cache.get(at);
        const result = await rpc<{ revision: number }>({ operation: "state.set", namespace, key, revision: revisions.get(at) ?? 0,
          ...(latest instanceof Blob ? { media: await encodeBlob(latest) } : { value: latest }) });
        revisions.set(at, result.revision); failures.delete(at); return value;
      };
      pending++; status();
      // Group rapid drag/edit updates while keeping the host's unsaved indicator active.
      const queued = (chains.get(at) ?? Promise.resolve()).catch(() => undefined).then(async () => {
        if (!(value instanceof Blob)) await new Promise(resolve => setTimeout(resolve, 350));
        scheduled.delete(at);
        return save();
      });
      scheduled.set(at, queued);
      chains.set(at, queued);
      try { return await queued; }
      catch (cause) { failures.set(at, () => api.setItem(key, cache.get(at))); throw cause; }
      finally { pending--; if (chains.get(at) === queued) chains.delete(at); status(); }
    },
    async removeItem(key: string) {
      const at = address(key);
      if (!persistent.has(namespace)) { cache.delete(at); return; }
      await initialized;
      await chains.get(at);
      if (!revisions.has(at)) await api.getItem(key);
      pending++; status();
      try { const result = await rpc<{ revision: number }>({ operation: "state.remove", namespace, key, revision: revisions.get(at) ?? 0 }); revisions.set(at, result.revision); cache.set(at, null); failures.delete(at); }
      catch (cause) { failures.set(at, () => api.removeItem(key)); throw cause; }
      finally { pending--; status(); }
    },
    async keys(): Promise<string[]> { await initialized; return persistent.has(namespace) ? rpc<string[]>({ operation: "state.keys", namespace }) : [...cache.keys()].filter(key => key.startsWith(`${namespace}/`)).map(key => key.slice(namespace.length + 1)); },
    async iterate<T, U>(iterator: (value: T, key: string, index: number) => U) { let index = 0; for (const key of await api.keys()) { const result = iterator((await api.getItem<T>(key))!, key, ++index); if (result !== undefined) return result; } },
    async clear() { for (const key of await api.keys()) await api.removeItem(key); },
    async length() { return (await api.keys()).length; },
  };
  return api;
}
window.addEventListener("studio.retry", () => { void Promise.allSettled([...failures.values()].map(retry => retry())); });
const localforage = { ...instance("app_state"), config: () => undefined, createInstance: ({ storeName = "app_state" }: { name?: string; storeName?: string }) => instance(storeName) };
export default localforage;
