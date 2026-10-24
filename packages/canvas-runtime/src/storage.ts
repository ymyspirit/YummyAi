import { channel, initialized, notify, rpc } from "./rpc";
import type { StudioWorkspace } from "@yummyai/contracts/pod/studio-personal";
import { flushStudioDraftOwners } from "./studio-draft-flush";
const persistent = new Set(["app_state", "image_files", "media_files", "image_generation_logs", "video_generation_logs"]);
const revisions = new Map<string, number>(), cache = new Map<string, unknown>();
const nativeCheckpoints = new Map<string, { signature: string; original: string }>();
const chains = new Map<string, Promise<unknown>>();
const scheduled = new Map<string, Promise<unknown>>();
const failures = new Map<string, () => Promise<unknown>>();
type ReadResult = { revision: number; value?: unknown; media?: { contentBase64: string; mediaType: string } };
type UncertainWrite = { namespace: string; key: string; revision: number; operation: "state.set" | "state.remove"; value?: unknown; media?: { contentBase64: string; mediaType: string } };
const uncertain = new Map<string, UncertainWrite>(), retryAllowed = new Set<string>();
// These local attempts are known not to have reached transport. They still
// require their own read proof before an operator may explicitly save again.
const notDispatched = new Map<string, UncertainWrite>();
// Recovery preserves the dispatched request. This separate intent tracks what
// the current owner subsequently accepted, including set(null) versus remove.
type LocalIntent = Pick<UncertainWrite, "namespace" | "key" | "operation"> & { seq: number; order: number; value?: unknown };
const localIntents = new Map<string, LocalIntent>(), attemptedIntents = new WeakMap<UncertainWrite, LocalIntent>();
type DraftProducer = { owner: string; current: () => boolean; canSave: () => boolean; onSaved: (value: unknown, editSeq: number) => void; retry: () => unknown; onInvalidated?: () => void; editSeq: number; value?: unknown };
const producers = new Map<string, DraftProducer>(), dirtyDocuments = new Set<string>();
const attemptedProducers = new WeakMap<UncertainWrite, { producer: DraftProducer; editSeq: number }>();
// A read proof advances the next permitted CAS, never the original attempt.
const provenRevisions = new Map<string, { attempt: UncertainWrite; revision: number }>();
const writing = new Set<Promise<unknown>>();
let writeEpoch = 0, ownerEpoch = 0, localOrder = 0, closed = false;
let activeReconcile: Promise<void> | undefined;
const ownerChanged = () => new DOMException("创作保存归属已变化", "AbortError");
function captureOwner(at?: string) {
  const epoch = ownerEpoch, address = at ?? "", producer = producers.get(address);
  const sameEpoch = () => !closed && epoch === ownerEpoch;
  const current = () => sameEpoch() && (producer
    ? producers.get(address) === producer && producer.current() && (!runtimeWorkspace || producer.owner === workspaceOwner(runtimeWorkspace))
    : !producers.has(address));
  return { current, sameEpoch, producer, assert: () => { if (!current()) throw ownerChanged(); } };
}
function resetOwner(clear: boolean) {
  const previous = [...producers.values()];
  ownerEpoch++; writeEpoch++; closed = clear;
  revisions.clear(); cache.clear(); nativeCheckpoints.clear(); chains.clear(); scheduled.clear(); failures.clear();
  uncertain.clear(); notDispatched.clear(); retryAllowed.clear(); provenRevisions.clear(); dirtyDocuments.clear(); localIntents.clear(); producers.clear(); writing.clear(); pending = 0; localOrder = 0; activeReconcile = undefined;
  for (const producer of previous) producer.onInvalidated?.();
  if (clear) window.dispatchEvent(new Event("studio.storage-clear"));
}
function tracked<T>(task: Promise<T>) { writeEpoch++; writing.add(task); void task.then(() => writing.delete(task), () => writing.delete(task)); return task; }
export function studioStorageCertain() { return !uncertain.size && !notDispatched.size && !failures.size; }
/** Includes preflight reads, unmounted workbench queues and native debounce
 * timers. An uncertain result is never converted to a successful barrier. */
export async function flushStudioStorage() {
  const owner = captureOwner(); owner.assert();
  for (let attempt = 0; attempt < 50; attempt++) {
    await flushStudioDraftOwners();
    owner.assert();
    const epoch = writeEpoch;
    await Promise.all([...writing, ...chains.values(), ...scheduled.values()]);
    await Promise.resolve();
    owner.assert();
    if (failures.size || uncertain.size || notDispatched.size) throw new Error("保存结果尚未确认 请先只读核对原保存结果");
    if (dirtyDocuments.size) throw new Error("当前输入尚未保存 请先明确保存当前输入");
    if (!writing.size && !pending && !scheduled.size && epoch === writeEpoch) return;
  }
  throw new Error("仍有创作输入正在保存 请停止编辑后重试");
}
let runtimeWorkspace: StudioWorkspace | undefined;
let workspaceConfigured = false;
const workspaceOwner = (value?: StudioWorkspace) => value ? JSON.stringify([value.scope, value.contextAuthority]) : "";
function configureWorkspace(value?: StudioWorkspace) {
  if (closed) return;
  if (workspaceConfigured && workspaceOwner(runtimeWorkspace) !== workspaceOwner(value)) resetOwner(false);
  workspaceConfigured = true;
  runtimeWorkspace = value;
}
void initialized.then(init => configureWorkspace(init?.workspace));
window.addEventListener("studio.workspace", event => configureWorkspace((event as CustomEvent).detail.workspace));
window.addEventListener("message", event => {
  const received = event as MessageEvent;
  if (typeof parent === "undefined" || typeof location === "undefined") return;
  const origin = new URLSearchParams(location.search).get("parentOrigin");
  if (!origin || !channel || received.source !== parent || received.origin !== origin || received.data?.channel !== channel || received.data.type !== "studio.clear") return;
  resetOwner(true);
});
window.addEventListener("pagehide", () => resetOwner(true));
let pending = 0;
function status() { if (!closed) notify("studio.storage", { pending, dirty: dirtyDocuments.size, error: failures.size ? "保存结果尚未确认 请先只读核对 或导出当前画布备份" : null }); }
function hasWritePermission(namespace: string, value?: unknown, producer?: DraftProducer) {
  const media = namespace === "image_files" || namespace === "media_files" || value instanceof Blob;
  return (!runtimeWorkspace || runtimeWorkspace.capabilities.save && (!media || runtimeWorkspace.capabilities.mediaWrite)) && (!producer || producer.canSave());
}
function assertWritePermission(namespace: string, value?: unknown, producer?: DraftProducer) {
  if (!hasWritePermission(namespace, value, producer)) throw new Error("当前项目仅可查看 你的修改尚未保存");
}
function sameLocalValue(left: unknown, right: unknown) {
  return left === right || !(left instanceof Blob) && !(right instanceof Blob) && left !== undefined && right !== undefined && canonical(left) === canonical(right);
}
function acceptIntent(at: string, operation: Pick<UncertainWrite, "namespace" | "key" | "operation">, order: number, value?: unknown, force = false) {
  const previous = localIntents.get(at);
  if (previous && previous.order > order) return previous;
  const intent: LocalIntent = previous && !force && previous.operation === operation.operation && (operation.operation === "state.remove" || sameLocalValue(previous.value, value)) ? previous : { ...operation, seq: (previous?.seq ?? 0) + 1, order,
    ...(operation.operation === "state.set" ? { value: value instanceof Blob ? value : structuredClone(value) } : {}) };
  intent.order = order; localIntents.set(at, intent);
  cache.set(at, intent.operation === "state.remove" ? null : intent.value); dirtyDocuments.add(at);
  return intent;
}
function recoveryAt(at: string) { return uncertain.get(at) ?? notDispatched.get(at); }
function recordNotDispatched(at: string, namespace: string, key: string, producer?: DraftProducer, candidate?: UncertainWrite) {
  // In particular, a failed later local queue must not downgrade unknown A.
  if (recoveryAt(at)) return;
  const revision = candidate?.revision ?? revisions.get(at);
  if (revision === undefined) return;
  const attempt: UncertainWrite = candidate ?? { operation: "state.set", namespace, key, revision, value: structuredClone(cache.get(at)) };
  notDispatched.set(at, attempt); dirtyDocuments.add(at); retryAllowed.delete(at); provenRevisions.delete(at);
  if (producer && !attemptedProducers.has(attempt)) attemptedProducers.set(attempt, { producer, editSeq: producer.editSeq });
}
/** Both native retries and input producers must recover a failure occurring
 * after proof consumption but before the API reaches its dispatch catch. */
async function writeWithRecovery<T>(at: string, operation: Pick<UncertainWrite, "namespace" | "key" | "operation">, write: () => Promise<T>): Promise<T> {
  const owner = captureOwner(at); owner.assert();
  const revision = recoveryAt(at) ? consumeProof(at) : revisions.get(at);
  try { const result = await write(); owner.assert(); return result; }
  catch (cause) {
    // A dispatched failure already has an unknown record. Never replace it,
    // another current recovery, or any state belonging to a new owner.
    if (owner.current() && !recoveryAt(at) && revision !== undefined) {
      const candidate: UncertainWrite = { ...operation, revision,
        ...(operation.operation === "state.set" ? { value: structuredClone(cache.get(at)) } : {}) };
      recordNotDispatched(at, operation.namespace, operation.key, owner.producer, candidate);
      failures.set(at, explicitRetry(at, write)); status();
    }
    throw cause;
  }
}

/** Register one current local producer. Staging is synchronous and never sends
 * an RPC, including while the previous attempt has an unknown outcome. */
export function bindStudioDraftPersistence(key: string, options: Omit<DraftProducer, "editSeq" | "value">) {
  const at = `app_state/${key}`, epoch = ownerEpoch;
  if (closed || producers.has(at) || runtimeWorkspace && options.owner !== workspaceOwner(runtimeWorkspace)) throw ownerChanged();
  const producer: DraftProducer = { ...options, editSeq: 0 };
  producers.set(at, producer);
  const current = () => !closed && ownerEpoch === epoch && producers.get(at) === producer && options.current() && (!runtimeWorkspace || options.owner === workspaceOwner(runtimeWorkspace));
  const assert = () => { if (!current()) throw ownerChanged(); };
  const api = instance("app_state");
  return {
    current,
    load: async () => { assert(); const value = await api.getItem(key); assert(); producer.value = structuredClone(value); return value; },
    stage(value: unknown, editSeq: number) {
      assert(); if (!options.canSave()) throw new Error("当前范围仅可查看 输入未保存");
      assertWritePermission("app_state", value, producer);
      if (!Number.isSafeInteger(editSeq) || editSeq <= producer.editSeq) throw new Error("草稿编辑代次无效 原输入未替换");
      producer.editSeq = editSeq; producer.value = structuredClone(value);
      acceptIntent(at, { operation: "state.set", namespace: "app_state", key }, ++localOrder, value, true); status();
    },
    canRetry: () => current() && options.canSave() && (recoveryAt(at)
      ? retryAllowed.has(at) && provenRevisions.get(at)?.attempt === recoveryAt(at)
      : dirtyDocuments.has(at) && revisions.has(at) && !failures.has(at) && !chains.has(at) && !scheduled.has(at)),
    async save(value: unknown) {
      assert(); if (!options.canSave()) throw new Error("当前范围仅可查看 输入未保存");
      return writeWithRecovery(at, { operation: "state.set", namespace: "app_state", key }, () => api.setItem(key, value));
    },
    release() {
      if (producers.get(at) !== producer) return;
      producers.delete(at); cache.delete(at); revisions.delete(at); nativeCheckpoints.delete(at); chains.delete(at); scheduled.delete(at); failures.delete(at); uncertain.delete(at); notDispatched.delete(at); retryAllowed.delete(at); provenRevisions.delete(at); dirtyDocuments.delete(at); localIntents.delete(at);
      status();
    },
  };
}
export async function encodeBlob(blob: Blob) { const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = ""; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); return { contentBase64: btoa(binary), mediaType: blob.type }; }
export function decodeBlob(media: { contentBase64: string; mediaType: string }) { const value = atob(media.contentBase64); return new Blob([Uint8Array.from(value, char => char.charCodeAt(0))], { type: media.mediaType }); }
function canonical(value: unknown): string {
  const ordered = (input: unknown): unknown => Array.isArray(input) ? input.map(ordered) : input !== null && typeof input === "object"
    ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)])) : input;
  return JSON.stringify(ordered(JSON.parse(JSON.stringify(value))));
}
// Zustand stores these two documents as JSON strings. Compare their parsed
// content only for no-op persistence, retaining the acknowledged original bytes.
// Lost-ACK and media comparisons deliberately continue using canonical above.
function nativeDocument(namespace: string, key: string, value: unknown) {
  if (namespace !== "app_state" || !["infinite-canvas:canvas_store", "infinite-canvas:asset_store"].includes(key) || typeof value !== "string") return;
  try {
    const document: unknown = JSON.parse(value);
    if (!document || typeof document !== "object" || Array.isArray(document)) return;
    const root = document as Record<string, unknown>, state = root.state;
    if ((root.version !== undefined && (!Number.isInteger(root.version) || (root.version as number) < 0)) || !state || typeof state !== "object" || Array.isArray(state)) return;
    const collection = (state as Record<string, unknown>)[key.endsWith(":canvas_store") ? "projects" : "assets"];
    if (!Array.isArray(collection)) return;
    const signature = JSON.stringify(document, (_key, item: unknown) => item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
    return { signature, original: value };
  } catch { return; }
}
function rememberNative(at: string, namespace: string, key: string, value: unknown) {
  const checkpoint = nativeDocument(namespace, key, value);
  if (checkpoint) nativeCheckpoints.set(at, checkpoint); else nativeCheckpoints.delete(at);
}
function sameNative(at: string, namespace: string, key: string, value: unknown) {
  const checkpoint = nativeCheckpoints.get(at), current = nativeDocument(namespace, key, value);
  return checkpoint && current?.signature === checkpoint.signature ? checkpoint : undefined;
}
async function matchesCurrent(at: string, result: ReadResult) {
  const current = cache.get(at);
  return current instanceof Blob ? Boolean(result.media && canonical(result.media) === canonical(await encodeBlob(current)))
    : !result.media && canonical(result.value ?? null) === canonical(current ?? null);
}
function confirmAttempt(at: string, attempted: UncertainWrite) {
  const metadata = attemptedProducers.get(attempted);
  if (attempted.operation === "state.set" && metadata && producers.get(at) === metadata.producer && metadata.producer.current()) metadata.producer.onSaved(structuredClone(attempted.value), metadata.editSeq);
}
function matchesAttemptSequence(at: string, attempted: UncertainWrite) {
  const metadata = attemptedProducers.get(attempted), intent = attemptedIntents.get(attempted), current = localIntents.get(at);
  return (intent ? current === intent && current.seq === intent.seq && current.operation === attempted.operation : !current)
    && (!metadata || producers.get(at) === metadata.producer && metadata.producer.editSeq === metadata.editSeq);
}
async function reconcileOne(at: string, attempted: UncertainWrite, phase: "unknown" | "not_dispatched"): Promise<"confirmed" | "unchanged" | "conflict"> {
  const owner = captureOwner(at); owner.assert();
  const result = await rpc<ReadResult>({ operation: "state.get", namespace: attempted.namespace, key: attempted.key });
  owner.assert();
  if (recoveryAt(at) !== attempted || (phase === "unknown" ? uncertain.get(at) : notDispatched.get(at)) !== attempted) throw ownerChanged();
  rememberNative(at, attempted.namespace, attempted.key, result.media ? undefined : result.value);
  if (phase === "not_dispatched") {
    if (result.revision === attempted.revision) {
      provenRevisions.set(at, { attempt: attempted, revision: result.revision }); retryAllowed.add(at); dirtyDocuments.add(at); return "unchanged";
    }
    retryAllowed.delete(at); provenRevisions.delete(at); return "conflict";
  }
  const sameAttempt = attempted.operation === "state.remove" ? !result.media && result.value === null
    : attempted.media ? Boolean(result.media && canonical(result.media) === canonical(attempted.media))
      : !result.media && canonical(result.value) === canonical(attempted.value);
  if (result.revision === attempted.revision + 1 && sameAttempt) {
    revisions.set(at, result.revision);
    confirmAttempt(at, attempted);
    const local = cache.get(at), matches = await matchesCurrent(at, result); owner.assert();
    if (matches && cache.get(at) === local && matchesAttemptSequence(at, attempted)) {
      uncertain.delete(at); retryAllowed.delete(at); provenRevisions.delete(at); failures.delete(at); dirtyDocuments.delete(at); return "confirmed";
    }
    // The original save is proven, but the operator has since edited the local
    // draft. Keep it and require a separate, explicit save at this proven CAS.
    provenRevisions.set(at, { attempt: attempted, revision: result.revision }); retryAllowed.add(at); dirtyDocuments.add(at); return "unchanged";
  }
  if (result.revision === attempted.revision) { provenRevisions.set(at, { attempt: attempted, revision: result.revision }); retryAllowed.add(at); return "unchanged"; }
  retryAllowed.delete(at); provenRevisions.delete(at); return "conflict";
}
async function reconcile() {
  const owner = captureOwner(); if (!owner.current()) return;
  let result: "confirmed" | "unchanged" | "conflict" = failures.size > uncertain.size + notDispatched.size ? "conflict" : "confirmed";
  try {
    const recoveries: Array<[string, UncertainWrite, "unknown" | "not_dispatched"]> = [
      ...[...uncertain].map(([at, attempt]): [string, UncertainWrite, "unknown"] => [at, attempt, "unknown"]),
      ...[...notDispatched].filter(([at]) => !uncertain.has(at)).map(([at, attempt]): [string, UncertainWrite, "not_dispatched"] => [at, attempt, "not_dispatched"]),
    ];
    for (const [at, attempted, phase] of recoveries) {
      owner.assert();
      const current = await reconcileOne(at, attempted, phase);
      if (current === "conflict" || current === "unchanged" && result !== "conflict") result = current;
    }
    owner.assert();
    if (result === "confirmed" && (dirtyDocuments.size || pending || uncertain.size || notDispatched.size || failures.size)) result = "unchanged";
    status();
    notify("studio.reconciled", { result, message: result === "confirmed" ? "原保存已核对"
      : result === "unchanged" ? "原记录已核对 当前内容仍需你再次保存" : "原记录已有其他版本 当前草稿已保留 请导出备份并核对" });
  } catch (cause) {
    if (!owner.current()) return;
    retryAllowed.clear(); provenRevisions.clear(); status();
    notify("studio.reconciled", { result: "conflict", message: cause instanceof Error ? cause.message : "核对尚未完成 当前草稿已保留" });
  }
}
function consumeProof(at: string) {
  const attempted = recoveryAt(at), proof = provenRevisions.get(at);
  if (!attempted || !retryAllowed.has(at) || !proof || proof.attempt !== attempted) throw new Error("请先只读核对原保存结果");
  revisions.set(at, proof.revision);
  uncertain.delete(at); notDispatched.delete(at); retryAllowed.delete(at); provenRevisions.delete(at); failures.delete(at);
  return proof.revision;
}
function explicitRetry(at: string, write: () => Promise<unknown>) {
  return async () => {
    const producer = producers.get(at);
    if (producer) { if (!producer.current()) throw ownerChanged(); return producer.retry(); }
    const attempted = recoveryAt(at);
    if (!attempted) throw new Error("请先只读核对原保存结果");
    const intent = localIntents.get(at), operation = intent ?? attempted, api = instance(operation.namespace);
    const latestWrite = intent ? () => intent.operation === "state.remove" ? api.removeItem(intent.key) : api.setItem(intent.key, cache.get(at)) : write;
    return writeWithRecovery(at, { operation: operation.operation, namespace: operation.namespace, key: operation.key }, latestWrite);
  };
}
function instance(namespace: string) {
  const address = (key: string) => `${namespace}/${key}`;
  const api = {
    async getItem<T>(key: string): Promise<T | null> {
      const at = address(key), owner = captureOwner(at); owner.assert();
      if (cache.has(at)) return cache.get(at) as T;
      if (!persistent.has(namespace)) return null;
      await initialized;
      owner.assert();
      const result = await rpc<{ revision: number; value?: T; media?: { contentBase64: string; mediaType: string } }>({ operation: "state.get", namespace, key }).catch(cause => { if (owner.current()) notify(namespace === "app_state" ? "studio.read-error" : "studio.error", { error: cause instanceof Error ? cause.message : "创作记录读取失败" }); throw cause; });
      owner.assert();
      // Another hydration or local edit may have won while this read was in
      // flight. Never roll its cache/revision back with a late older body.
      if (cache.has(at)) return cache.get(at) as T;
      revisions.set(at, result.revision);
      const value = result.media ? decodeBlob(result.media) : result.value ?? null;
      rememberNative(at, namespace, key, value);
      cache.set(at, value); return value as T | null;
    },
    async setItem<T>(key: string, value: T): Promise<T> {
      const at = address(key), owner = captureOwner(at); owner.assert();
      const order = ++localOrder;
      // Keep a newer synchronously staged edit when an older save resumes from
      // initialization. The 350ms queue will send the latest actual snapshot.
      const producer = owner.producer;
      if (producer && canonical(producer.value) !== canonical(value)) throw new Error("草稿保存正文与当前本地输入不一致 原输入保持");
      if (!persistent.has(namespace)) { cache.set(at, value); return value; }
      await initialized;
      owner.assert();
      // Do not write an empty document when hydration failed. First establish its server revision.
      if (!revisions.has(at)) {
        if (namespace === "app_state") throw new Error("项目尚未成功读取，请重新连接后再编辑");
        await api.getItem(key);
        owner.assert();
      }
      const newerIntent = localIntents.get(at);
      if (newerIntent && newerIntent.order > order) { assertWritePermission(namespace, value, producer); return value; }
      const checkpoint = sameNative(at, namespace, key, value);
      if (checkpoint && !dirtyDocuments.has(at) && !chains.has(at) && !scheduled.has(at) && !recoveryAt(at) && !failures.has(at)) {
        cache.set(at, checkpoint.original); return value;
      }
      if (!hasWritePermission(namespace, value, producer)) {
        const original = cache.get(at);
        // Upstream persistence may echo a hydrated document on mount. A true
        // no-op remains a read; a changed draft must never report a saved edit.
        if (!producer && !dirtyDocuments.has(at) && !recoveryAt(at) && !failures.has(at) && (original === value || !(original instanceof Blob) && !(value instanceof Blob) && canonical(original ?? null) === canonical(value ?? null))) return value;
        throw new Error("当前项目仅可查看 你的修改尚未保存");
      }
      acceptIntent(at, { operation: "state.set", namespace, key }, order, value); status();
      if (recoveryAt(at)) throw new Error("保存结果尚未确认 请先只读核对 当前修改已保留");
      const alreadyScheduled = scheduled.get(at);
      if (alreadyScheduled) return alreadyScheduled as Promise<T>;
      let attempted: UncertainWrite | undefined, candidate: UncertainWrite | undefined;
      const save = async () => {
        owner.assert();
        const intent = localIntents.get(at);
        if (!intent || intent.operation !== "state.set") return value;
        const latest = cache.get(at), editSeq = producer?.editSeq;
        candidate = { operation: "state.set", namespace, key, revision: revisions.get(at) ?? 0, value: structuredClone(latest) };
        if (producer && editSeq !== undefined) attemptedProducers.set(candidate, { producer, editSeq });
        assertWritePermission(namespace, latest, producer);
        if (recoveryAt(at)) throw new Error("保存结果尚未确认 请先只读核对 当前修改已保留");
        const checkpoint = sameNative(at, namespace, key, latest);
        if (checkpoint) { if (localIntents.get(at) === intent) { cache.set(at, checkpoint.original); failures.delete(at); dirtyDocuments.delete(at); } return value; }
        const body: UncertainWrite = { operation: "state.set", namespace, key, revision: revisions.get(at) ?? 0,
          ...(latest instanceof Blob ? { media: await encodeBlob(latest) } : { value: structuredClone(latest) }) };
        owner.assert();
        assertWritePermission(namespace, latest, producer);
        attempted = body;
        attemptedIntents.set(attempted, intent);
        if (producer && editSeq !== undefined) attemptedProducers.set(attempted, { producer, editSeq });
        const result = await rpc<{ revision: number }>(attempted);
        owner.assert();
        rememberNative(at, namespace, key, attempted.media ? undefined : attempted.value);
        revisions.set(at, result.revision); failures.delete(at);
        confirmAttempt(at, attempted);
        let matches = cache.get(at) === latest;
        if (!matches && matchesAttemptSequence(at, attempted)) {
          const local = cache.get(at);
          matches = await matchesCurrent(at, { ...result, ...(attempted.media ? { media: attempted.media } : { value: attempted.value }) }); owner.assert();
          matches = matches && cache.get(at) === local;
        }
        if (matches && matchesAttemptSequence(at, attempted)) dirtyDocuments.delete(at);
        return value;
      };
      pending++; status();
      // Group rapid drag/edit updates while keeping the host's unsaved indicator active.
      const queued = (chains.get(at) ?? Promise.resolve()).catch(() => undefined).then(async () => {
        if (!(value instanceof Blob)) await new Promise(resolve => setTimeout(resolve, 350));
        owner.assert();
        scheduled.delete(at);
        return save();
      });
      scheduled.set(at, queued);
      chains.set(at, queued);
      try { return await queued; }
      catch (cause) { if (owner.current()) {
        if (attempted) { notDispatched.delete(at); uncertain.set(at, attempted); }
        else recordNotDispatched(at, namespace, key, producer, candidate);
        retryAllowed.delete(at); provenRevisions.delete(at); failures.set(at, explicitRetry(at, () => api.setItem(key, cache.get(at))));
      } throw cause; }
      finally { if (owner.sameEpoch()) { pending = Math.max(0, pending - 1); if (chains.get(at) === queued) chains.delete(at); status(); } }
    },
    async removeItem(key: string) {
      const at = address(key), owner = captureOwner(at); owner.assert();
      const order = ++localOrder, producer = owner.producer;
      if (!persistent.has(namespace)) { cache.delete(at); return; }
      assertWritePermission(namespace, undefined, producer);
      await initialized;
      owner.assert();
      assertWritePermission(namespace, undefined, producer);
      if (!revisions.has(at)) await api.getItem(key);
      owner.assert();
      assertWritePermission(namespace, undefined, producer);
      const newerIntent = localIntents.get(at);
      if (newerIntent && newerIntent.order > order) return;
      acceptIntent(at, { operation: "state.remove", namespace, key }, order); status();
      if (recoveryAt(at)) throw new Error("保存结果尚未确认 请先只读核对 当前修改已保留");
      let attempted: UncertainWrite | undefined, candidate: UncertainWrite | undefined;
      const remove = async () => {
        owner.assert();
        const intent = localIntents.get(at);
        if (!intent || intent.operation !== "state.remove") return;
        candidate = { operation: "state.remove", namespace, key, revision: revisions.get(at) ?? 0 };
        assertWritePermission(namespace, undefined, producer);
        if (recoveryAt(at)) throw new Error("保存结果尚未确认 请先只读核对 当前修改已保留");
        attempted = candidate; attemptedIntents.set(attempted, intent);
        const result = await rpc<{ revision: number }>(attempted);
        owner.assert();
        revisions.set(at, result.revision); nativeCheckpoints.delete(at); failures.delete(at);
        if (matchesAttemptSequence(at, attempted)) { cache.set(at, null); dirtyDocuments.delete(at); }
      };
      pending++; status();
      const queued = (chains.get(at) ?? Promise.resolve()).catch(() => undefined).then(remove);
      chains.set(at, queued);
      try { await queued; }
      catch (cause) { if (owner.current()) {
        if (attempted) { notDispatched.delete(at); uncertain.set(at, attempted); }
        else recordNotDispatched(at, namespace, key, producer, candidate);
        retryAllowed.delete(at); provenRevisions.delete(at); failures.set(at, explicitRetry(at, () => api.removeItem(key)));
      } throw cause; }
      finally { if (owner.sameEpoch()) { pending = Math.max(0, pending - 1); if (chains.get(at) === queued) chains.delete(at); status(); } }
    },
    async keys(): Promise<string[]> { const owner = captureOwner(); owner.assert(); await initialized; owner.assert(); const keys = persistent.has(namespace) ? await rpc<string[]>({ operation: "state.keys", namespace }) : [...cache.keys()].filter(key => key.startsWith(`${namespace}/`)).map(key => key.slice(namespace.length + 1)); owner.assert(); return keys; },
    async iterate<T, U>(iterator: (value: T, key: string, index: number) => U) { let index = 0; for (const key of await api.keys()) { const result = iterator((await api.getItem<T>(key))!, key, ++index); if (result !== undefined) return result; } },
    async clear() { for (const key of await api.keys()) await api.removeItem(key); },
    async length() { return (await api.keys()).length; },
  };
  const set = api.setItem, remove = api.removeItem;
  api.setItem = <T,>(key: string, value: T) => tracked(set(key, value));
  api.removeItem = (key: string) => tracked(remove(key));
  return api;
}
window.addEventListener("studio.retry", () => { void Promise.allSettled([...failures.values()].map(retry => retry())); });
window.addEventListener("studio.reconcile", () => {
  if (activeReconcile) return;
  const task = reconcile(); activeReconcile = task;
  const complete = () => { if (activeReconcile === task) activeReconcile = undefined; };
  void task.then(complete, complete);
});
const localforage = { ...instance("app_state"), config: () => undefined, createInstance: ({ storeName = "app_state" }: { name?: string; storeName?: string }) => instance(storeName) };
export default localforage;
