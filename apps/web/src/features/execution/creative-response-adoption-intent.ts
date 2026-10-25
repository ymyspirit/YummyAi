import { ASSIST_INTENT_PREFIX } from "@yummyai/contracts/ai/assist-recovery";
import {
  CreativeResponseAdoptionCommandSchema,
  CreativeResponseAdoptionWorkspaceSchema,
  type CreativeResponseAdoptionCommand,
  type CreativeResponseAdoptionRequestView,
  type CreativeResponseAdoptionWorkspace,
} from "@yummyai/contracts/harness/creative-response-adoption";
import { CreativeResponseAdoptionError, sameCreativeResponseAdoptionCommand, type CreativeResponseAdoptionClient, type CreativeResponseAdoptionPreview } from "./creative-response-adoption-client";

export const CREATIVE_RESPONSE_ADOPTION_INTENT_PREFIX = `${ASSIST_INTENT_PREFIX}creative-response-adoption:v1:`;
export type CreativeResponseAdoptionStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;
export type CreativeResponseAdoptionIntent = { executionId: string; identityStamp: string; command: CreativeResponseAdoptionCommand };
export type CreativeResponseAdoptionSnapshot = {
  workspace?: CreativeResponseAdoptionWorkspace; intent?: CreativeResponseAdoptionIntent; request?: CreativeResponseAdoptionRequestView; lookupMissing: boolean;
};

/** This namespace is already covered by the global ASSIST logout cleanup,
 * including when the panel which created the marker has been unmounted. */
export function creativeResponseAdoptionVault(identity: string, storage: CreativeResponseAdoptionStorage) {
  const identityStamp = CreativeResponseAdoptionWorkspaceSchema.shape.identityStamp.parse(identity);
  const key = (executionId: string) => `${CREATIVE_RESPONSE_ADOPTION_INTENT_PREFIX}${identityStamp}:${CreativeResponseAdoptionWorkspaceSchema.shape.executionId.parse(executionId)}`;
  const read = (executionId: string): CreativeResponseAdoptionIntent | undefined => {
    const text = storage.getItem(key(executionId));
    if (text === null) return;
    try {
      if (text.length > 2048) throw new Error("marker too large");
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "command,executionId,identityStamp") throw new Error("invalid marker");
      const marker = value as Record<string, unknown>;
      if (marker.executionId !== executionId || marker.identityStamp !== identityStamp) throw new Error("marker identity changed");
      return { executionId, identityStamp, command: CreativeResponseAdoptionCommandSchema.parse(marker.command) };
    } catch { throw new Error("原采用标识无法核对 请保留原任务编号 不另起请求"); }
  };
  return {
    read,
    save(executionId: string, input: CreativeResponseAdoptionCommand) {
      const command = CreativeResponseAdoptionCommandSchema.parse(input), previous = read(executionId);
      if (previous && !sameCreativeResponseAdoptionCommand(previous.command, command)) throw new Error("已有原采用请求 未替换原编号或正文");
      if (previous) return previous;
      const marker: CreativeResponseAdoptionIntent = { executionId, identityStamp, command }, text = JSON.stringify(marker);
      try { storage.setItem(key(executionId), text); if (storage.getItem(key(executionId)) !== text) throw new Error("marker not retained"); }
      catch { throw new Error("浏览器未能保留原采用标识 未发起采用 请保留此页后重试读取"); }
      return marker;
    },
  };
}
export function clearCreativeResponseAdoptionIntents(storage: CreativeResponseAdoptionStorage) {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => !!key?.startsWith(CREATIVE_RESPONSE_ADOPTION_INTENT_PREFIX));
  for (const key of keys) { storage.removeItem(key); if (storage.getItem(key) !== null) throw new Error("原采用标识未能清除"); }
}

export function createCreativeResponseAdoptionIntent(options: {
  executionId: string; client: CreativeResponseAdoptionClient; storage: CreativeResponseAdoptionStorage; current: () => void; id: () => string;
}) {
  const executionId = CreativeResponseAdoptionWorkspaceSchema.shape.executionId.parse(options.executionId);
  let state: CreativeResponseAdoptionSnapshot = { lookupMissing: false }, preview: CreativeResponseAdoptionPreview | undefined, displayed: string | undefined;
  let vault: ReturnType<typeof creativeResponseAdoptionVault> | undefined, reading = false, writing = false;
  const current = () => options.current();
  const snapshot = () => { current(); return { ...state }; };
  const marker = () => {
    current(); const original = state.intent, retained = vault?.read(executionId);
    if (!original || !retained || !sameCreativeResponseAdoptionCommand(retained.command, original.command))
      throw new Error("原采用标识已清除或变化 未重建请求");
    return original;
  };
  function requirePreview(acknowledgedBasis: string) {
    current(); const workspace = state.workspace;
    if (reading || !workspace || !["failed", "uncertain"].includes(workspace.originalPhase) || !preview || !displayed || displayed !== preview.basis || workspace.basis !== preview.basis
      || workspace.source.responseChecksum !== preview.responseChecksum || acknowledgedBasis !== preview.basis) throw new Error("请先完整查看本次原图 再核对同一版本的采用声明");
    return workspace;
  }
  const belongs = (request: CreativeResponseAdoptionRequestView, workspace: CreativeResponseAdoptionWorkspace) => request.executionId === executionId
    && (!request.receipt || request.receipt.candidateId === workspace.candidateId && request.receipt.inputFingerprint === workspace.source.inputFingerprint
      && (workspace.source.responseChecksum === null || request.receipt.responseChecksum === workspace.source.responseChecksum));
  const apply = (request: CreativeResponseAdoptionRequestView) => {
    current(); const original = marker();
    if (!state.workspace || !belongs(request, state.workspace) || !sameCreativeResponseAdoptionCommand(request.command, original.command)) throw new Error("原采用回执不对应当前固定请求");
    state = { ...state, request, lookupMissing: false }; return snapshot();
  };
  async function write(action: () => Promise<CreativeResponseAdoptionRequestView>) {
    current(); if (writing || reading) throw new Error("原请求正在核对 请稍候");
    writing = true; state = { ...state, request: undefined, lookupMissing: false };
    try { const value = await action(); current(); return apply(value); }
    finally { writing = false; }
  }
  return {
    snapshot,
    async read() {
      current(); if (reading || writing) throw new Error("原请求正在核对 请稍候");
      reading = true; preview = undefined; displayed = undefined;
      state = { ...state, workspace: undefined, request: undefined, lookupMissing: false };
      try {
        const workspace = await options.client.workspace(); current();
        if (workspace.executionId !== executionId || state.intent && state.intent.identityStamp !== workspace.identityStamp) throw new CreativeResponseAdoptionError("原归档所属本人已变化 旧内容未采用", 409, "authority_changed");
        vault = creativeResponseAdoptionVault(workspace.identityStamp, options.storage);
        const local = vault.read(executionId), indexed = workspace.requests[0];
        // A server index restores only the exact existing command. It never
        // creates a command or promotes prepared/processing to committed.
        const original = local ?? (indexed ? vault.save(executionId, indexed.command) : undefined);
        current(); state = { workspace, intent: original, lookupMissing: false };
        if (original) {
          const request = await options.client.lookup(original.command); current(); marker();
          if (request && !belongs(request, workspace)) throw new Error("原采用回执不对应当前原候选或归档依据");
          state = { ...state, request: request ?? undefined, lookupMissing: request === null };
        }
        return snapshot();
      } finally { reading = false; }
    },
    async inspect() {
      current(); if (reading || writing || !state.workspace) throw new Error("请先只读核对原归档");
      preview = undefined; displayed = undefined;
      const workspace = state.workspace, result = await options.client.preview(workspace); current();
      if (state.workspace !== workspace) throw new Error("原归档已重新读取 迟到预览未采用");
      preview = result; return result;
    },
    previewLoaded(basis: string, artifactChecksum: string) {
      current();
      if (!preview || preview.basis !== basis || preview.artifactChecksum !== artifactChecksum || state.workspace?.basis !== basis) throw new Error("预览所属原版本已变化 未允许采用");
      displayed = basis;
    },
    async adopt(acknowledgedBasis: string) {
      const workspace = requirePreview(acknowledgedBasis);
      if (!workspace.canAdopt || workspace.requests.length || state.intent) throw new Error("原执行已有采用请求或当前不能采用 请只读核对原记录");
      if (!vault) throw new Error("原采用标识尚未就绪");
      const command = CreativeResponseAdoptionCommandSchema.parse({ requestId: options.id(), expectedBasis: acknowledgedBasis, acknowledgeReviewRequired: true });
      const original = vault.save(executionId, command); current(); state = { ...state, intent: original };
      return write(() => options.client.adopt(original.command));
    },
    async retry(acknowledgedBasis: string) {
      requirePreview(acknowledgedBasis); const original = marker(), request = state.request;
      if (!request || !["prepared", "processing"].includes(request.status) || !request.canRetry || request.leaseActive || original.command.expectedBasis !== acknowledgedBasis)
        throw new Error("尚未核对可重试的原请求 仅可只读核对 不另起采用");
      return write(() => options.client.adopt(original.command));
    },
    async cancel() {
      const original = marker(), request = state.request;
      if (!request || !request.canCancel || request.requestId !== original.command.requestId
        || !(["prepared", "processing"].includes(request.status) || request.status === "cancelled" && request.artifactCleanup === "pending"))
        throw new Error("当前原请求不可取消或重试清理 请先只读核对");
      return write(() => options.client.cancel(request));
    },
  };
}
