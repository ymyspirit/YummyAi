import { StudioOriginalInspectionSchema, type StudioOriginalInspection, type StudioTechnicalInfo } from "@yummyai/contracts/pod/studio-original";
import type { StudioWorkspace } from "@yummyai/contracts/pod/studio-personal";

export type OriginalAddress = { key: string; namespace: "image_files" | "media_files"; assetId?: string };
type Transport = (request: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
type Job = { address: OriginalAddress; resolve: (value: StudioOriginalInspection) => void; reject: (cause: unknown) => void; signal: AbortSignal };

export function originalWorkspaceIdentity(workspace?: StudioWorkspace) {
  if (!workspace) return "";
  const access = workspace.capabilities;
  return JSON.stringify([workspace.scope, workspace.contextAuthority, workspace.originalHandoffVersion,
    access.read, access.save, access.mediaWrite, access.review, access.submit, access.configure]);
}

/** Workspace echoes are idempotent; an explicit refresh still checks the same
 * original again. The generation also fences a batched A → B → A transition. */
export function createOriginalFactsUpdates(initialIdentity: string) {
  let identity = initialIdentity, generation = 0;
  const key = () => JSON.stringify([identity, generation]);
  return { key,
    workspace(nextIdentity: string) {
      if (identity === nextIdentity) return;
      identity = nextIdentity; generation++; return key();
    },
    refresh() { generation++; return key(); },
  };
}

/** Owner-scoped metadata reads share a bounded queue. Cancelling a consumer
 * cancels its transport; one malformed original never blocks other cards. */
export function createOriginalInspector(transport: Transport) {
  let workspace: StudioWorkspace | undefined, owner = "", controller = new AbortController(), active = 0;
  const jobs: Job[] = [];
  function configure(next?: StudioWorkspace) {
    const key = originalWorkspaceIdentity(next);
    workspace = next;
    if (owner === key) return;
    owner = key; controller.abort(); controller = new AbortController();
    for (const job of jobs.splice(0)) job.reject(new DOMException("创作归属已变化", "AbortError"));
  }
  function pump() {
    while (active < 3 && jobs.length) {
      const job = jobs.shift()!;
      if (job.signal.aborted) { job.reject(job.signal.reason); continue; }
      const captured = owner;
      active++;
      void transport({ operation: "asset.inspect", namespace: job.address.namespace, key: job.address.key }, job.signal)
        .then(raw => {
          job.signal.throwIfAborted();
          if (captured !== owner) throw new DOMException("创作归属已变化", "AbortError");
          const value = StudioOriginalInspectionSchema.parse(raw);
          if (value.source.namespace !== job.address.namespace || job.address.assetId && value.source.assetId !== job.address.assetId) throw new Error("素材原件已变化 请刷新目录");
          job.resolve(value);
        }).catch(job.reject).finally(() => { active--; pump(); });
    }
  }
  return { configure,
    supported: () => workspace?.originalHandoffVersion === 1,
    inspect(address: OriginalAddress, signal?: AbortSignal): Promise<StudioOriginalInspection> {
      if (workspace?.originalHandoffVersion !== 1) return Promise.reject(new Error("当前创作服务尚未提供原件核对 请联系管理员升级"));
      const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      return new Promise((resolve, reject) => { jobs.push({ address, signal: combined, resolve, reject }); pump(); });
    },
  };
}

export function originalFacts(value?: StudioOriginalInspection) {
  if (!value) return "原件尺寸与大小尚未核对";
  const info = value.technical, bytes = value.source.byteSize;
  const size = bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  if (info.status !== "verified") return `${technicalStatus(info)} · 登记大小 ${size} · ${value.source.mediaType}`;
  if (info.kind === "audio") return `${info.durationSeconds.toFixed(2)} 秒 · ${size} · 容器与数据包已核对`;
  const dimensions = `${info.displayWidth}×${info.displayHeight} px`;
  const orientation = info.kind === "image" && info.orientation !== 1 ? ` · 编码 ${info.encodedWidth}×${info.encodedHeight} · 方向 ${info.orientation}`
    : info.kind === "video" && info.rotation ? ` · 旋转 ${info.rotation}°` : "";
  return `${dimensions}${orientation}${info.kind === "video" ? ` · ${info.durationSeconds.toFixed(2)} 秒 · 容器与数据包已核对` : " · 原图已完整解码"} · ${size}`;
}
export function technicalStatus(info: StudioTechnicalInfo) {
  if (info.status === "verified") return "原件已核对";
  return info.status === "unknown" ? "原件参数未知" : info.status === "unsupported" ? "暂不支持检查此原件" : "原件未通过检查";
}

export function verifiedMediaProjection(value: StudioOriginalInspection) {
  if (value.technical.status !== "verified" || value.technical.kind === "audio") throw new Error("原件尺寸尚未通过核对 暂不能插入画布");
  return { width: value.technical.displayWidth, height: value.technical.displayHeight, bytes: value.source.byteSize, mimeType: value.source.mediaType };
}
