import {
  CREATIVE_RESPONSE_ADOPTION_ARTIFACT_HEADER,
  CREATIVE_RESPONSE_ADOPTION_BASIS_HEADER,
  CREATIVE_RESPONSE_ADOPTION_CHECKSUM_HEADER,
  CREATIVE_RESPONSE_ADOPTION_PREVIEW_MAX_BYTES,
  CreativeResponseAdoptionCommandSchema,
  type CreativeResponseAdoptionCommand,
} from "@yummyai/contracts/harness/creative-response-adoption";
import {
  CreativeOwnerResponseAdoptionRequestSchema,
  CreativeOwnerResponseAdoptionWorkspaceSchema,
  type CreativeOwnerResponseAdoptionRequest,
  type CreativeOwnerResponseAdoptionWorkspace,
} from "@yummyai/contracts/harness/creative-owner-response-adoption";

const metadataLimit = 128 * 1024;
const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/tiff"]);
const hash = /^[a-f0-9]{64}$/;
const sameId = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
export const sameCreativeOwnerResponseAdoptionCommand = (left: CreativeResponseAdoptionCommand, right: CreativeResponseAdoptionCommand) =>
  left.requestId === right.requestId && left.expectedBasis === right.expectedBasis && left.acknowledgeReviewRequired === right.acknowledgeReviewRequired;

export class CreativeOwnerResponseAdoptionError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}
export type CreativeOwnerResponseAdoptionPreview = { blob: Blob; basis: string; responseChecksum: string; artifactChecksum: string; mediaType: string };
export type CreativeOwnerResponseAdoptionClient = ReturnType<typeof createCreativeOwnerResponseAdoptionClient>;
export type CreativeOwnerResponseAdoptionExpected = {
  kind: CreativeOwnerResponseAdoptionWorkspace["kind"]; stepKey: string; parentExecutionId: string | null; inputFingerprint: string;
};
export type CreativeOwnerResponseAdoptionClientOptions = {
  executionId: string; authority: string; signal: AbortSignal; current: () => void; fetch?: typeof fetch;
  expected?: CreativeOwnerResponseAdoptionExpected;
};

export function creativeOwnerResponseRequestBelongs(request: CreativeOwnerResponseAdoptionRequest, workspace: CreativeOwnerResponseAdoptionWorkspace) {
  const receipt = request.receipt;
  return sameId(request.executionId, workspace.executionId) && (!receipt || sameId(receipt.executionId, workspace.executionId)
    && receipt.kind === workspace.kind && receipt.stepKey === workspace.stepKey && sameId(receipt.ownerId, workspace.ownerId)
    && receipt.parentId === workspace.parentId && receipt.originalPhase === workspace.originalPhase && receipt.inputFingerprint === workspace.source.inputFingerprint
    && (workspace.source.responseChecksum === null || receipt.responseChecksum === workspace.source.responseChecksum)
    && (workspace.source.encryptedChecksum === null || receipt.encryptedChecksum === workspace.source.encryptedChecksum));
}

const failure = (status: number) => new CreativeOwnerResponseAdoptionError(
  status === 401 ? "本人登录已失效 原采用内容已隐藏" : status === 403 ? "当前本人没有原归档的读取或采用权限" : status === 404 ? "原归档或采用记录不存在或当前不可读取"
    : status === 409 ? "原归档或采用请求已变化 请先只读核对原记录" : status === 410 ? "原响应已过保留期或原件已清理"
      : status === 413 ? "原响应超过允许读取的大小" : status === 422 ? "原响应未通过核对 原任务状态保持"
        : "原采用结果尚未核对 请保留原编号并只读核对", status);

/** No transport retry lives here. An interrupted POST remains an original
 * request to look up, even when the caller never received its JSON body. */
export function createCreativeOwnerResponseAdoptionClient(options: CreativeOwnerResponseAdoptionClientOptions) {
  const executionId = CreativeOwnerResponseAdoptionWorkspaceSchema.shape.executionId.parse(options.executionId);
  const base = `/api/creative-executions/${encodeURIComponent(executionId)}`;
  const transport = options.fetch ?? globalThis.fetch;
  const current = () => { options.signal.throwIfAborted(); options.current(); };
  const expected = options.expected ? { ...options.expected } : undefined;
  let fixedOwner: CreativeOwnerResponseAdoptionWorkspace | undefined;
  async function request(path: string, init: RequestInit = {}) {
    current();
    const headers = new Headers(init.headers);
    if (init.body) headers.set("content-type", "application/json");
    headers.set("x-yummyai-context-authority", options.authority);
    const response = await transport(base + path, { ...init, credentials: "same-origin", cache: "no-store",
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(60_000)]),
      headers });
    try { current(); }
    catch (cause) { await response.body?.cancel().catch(() => undefined); throw cause; }
    const authority = response.headers.get("x-yummyai-context-authority");
    if (response.ok && authority !== options.authority) { await response.body?.cancel().catch(() => undefined); throw new CreativeOwnerResponseAdoptionError("当前本人身份已变化 旧响应未读取", 409, "authority_changed"); }
    return response;
  }
  async function bytes(response: Response, maximum: number) {
    current();
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximum)) {
      await response.body?.cancel().catch(() => undefined); throw failure(413);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new CreativeOwnerResponseAdoptionError("原响应正文不可读取 未采用替代数据", 502);
    const chunks: Uint8Array[] = []; let total = 0;
    try {
      for (;;) {
        current(); const part = await reader.read(); current();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > maximum) throw failure(413);
        chunks.push(part.value);
      }
      if (length !== null && total !== Number(length)) throw new CreativeOwnerResponseAdoptionError("原响应未完整读取 请只读核对原记录", 502);
    } catch (cause) { await reader.cancel().catch(() => undefined); throw cause; }
    finally { reader.releaseLock(); }
    current(); const result = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }
  async function json(response: Response) {
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw failure(response.status); }
    if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      await response.body?.cancel().catch(() => undefined); throw new CreativeOwnerResponseAdoptionError("原采用响应格式无法核对 请保留原编号", 502);
    }
    const body = await bytes(response, metadataLimit); current();
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown; }
    catch { throw new CreativeOwnerResponseAdoptionError("原采用响应正文无法核对 请保留原编号", 502); }
  }
  function checkedRequest(raw: unknown, command: CreativeResponseAdoptionCommand, adoptionId?: string) {
    current(); const checked = CreativeOwnerResponseAdoptionRequestSchema.safeParse(raw);
    if (!checked.success || !fixedOwner || !creativeOwnerResponseRequestBelongs(checked.data, fixedOwner)
      || !sameId(checked.data.executionId, executionId) || !sameCreativeOwnerResponseAdoptionCommand(checked.data.command, command)
      || adoptionId !== undefined && !sameId(checked.data.id, adoptionId)) throw new CreativeOwnerResponseAdoptionError("原采用回执与固定请求不一致 请只读核对", 502);
    return checked.data;
  }
  return {
    async workspace(): Promise<CreativeOwnerResponseAdoptionWorkspace> {
      const checked = CreativeOwnerResponseAdoptionWorkspaceSchema.safeParse(await json(await request("/owner-response-adoption")));
      current();
      if (!checked.success || !sameId(checked.data.executionId, executionId)
        || expected && (checked.data.kind !== expected.kind || checked.data.stepKey !== expected.stepKey
          || checked.data.parentExecutionId !== expected.parentExecutionId || checked.data.source.inputFingerprint !== expected.inputFingerprint)
        || fixedOwner && (checked.data.kind !== fixedOwner.kind || checked.data.stepKey !== fixedOwner.stepKey
          || checked.data.ownerId !== fixedOwner.ownerId || checked.data.parentId !== fixedOwner.parentId || checked.data.parentExecutionId !== fixedOwner.parentExecutionId
          || checked.data.identityStamp !== fixedOwner.identityStamp || checked.data.source.inputFingerprint !== fixedOwner.source.inputFingerprint)
        || checked.data.requests.some(item => !creativeOwnerResponseRequestBelongs(item, checked.data)))
        throw new CreativeOwnerResponseAdoptionError("原归档证据与执行编号不一致 未采用替代数据", 502);
      fixedOwner = checked.data;
      return checked.data;
    },
    async preview(workspace: CreativeOwnerResponseAdoptionWorkspace): Promise<CreativeOwnerResponseAdoptionPreview> {
      current();
      if (!sameId(workspace.executionId, executionId) || !workspace.canInspectOriginal || !workspace.basis || !workspace.source.responseChecksum)
        throw new CreativeOwnerResponseAdoptionError("当前原归档尚不能预览 请先只读核对", 409);
      const response = await request(`/owner-response-adoption/preview?basis=${workspace.basis}`);
      if (response.status !== 200) { await response.body?.cancel().catch(() => undefined); throw failure(response.status); }
      const basis = response.headers.get(CREATIVE_RESPONSE_ADOPTION_BASIS_HEADER), responseChecksum = response.headers.get(CREATIVE_RESPONSE_ADOPTION_CHECKSUM_HEADER),
        artifactChecksum = response.headers.get(CREATIVE_RESPONSE_ADOPTION_ARTIFACT_HEADER), mediaType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (basis !== workspace.basis || responseChecksum !== workspace.source.responseChecksum || !artifactChecksum || !hash.test(artifactChecksum) || !mediaType || !imageTypes.has(mediaType)) {
        await response.body?.cancel().catch(() => undefined); throw new CreativeOwnerResponseAdoptionError("原图预览的版本或校验不匹配 未允许采用", 502);
      }
      const body = await bytes(response, CREATIVE_RESPONSE_ADOPTION_PREVIEW_MAX_BYTES); current();
      if (!body.byteLength) throw new CreativeOwnerResponseAdoptionError("原图预览为空 未允许采用", 502);
      const digest = await crypto.subtle.digest("SHA-256", body); current();
      const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      if (actual !== artifactChecksum) throw new CreativeOwnerResponseAdoptionError("原图字节与归档校验不匹配 未允许采用", 502);
      return { blob: new Blob([body.buffer], { type: mediaType }), basis, responseChecksum, artifactChecksum, mediaType };
    },
    async adopt(input: CreativeResponseAdoptionCommand) {
      const command = CreativeResponseAdoptionCommandSchema.parse(input); current();
      return checkedRequest(await json(await request("/owner-response-adoptions", { method: "POST", body: JSON.stringify(command) })), command);
    },
    async lookup(input: CreativeResponseAdoptionCommand) {
      const command = CreativeResponseAdoptionCommandSchema.parse(input), response = await request(`/owner-response-adoptions/by-request/${encodeURIComponent(command.requestId)}`);
      if (response.status === 404) { await response.body?.cancel().catch(() => undefined); current(); return null; }
      return checkedRequest(await json(response), command);
    },
    async cancel(view: CreativeOwnerResponseAdoptionRequest) {
      const original = CreativeOwnerResponseAdoptionRequestSchema.parse(view);
      if (!sameId(original.executionId, executionId)) throw new CreativeOwnerResponseAdoptionError("原取消请求属于其他执行", 409);
      const body = CreativeResponseAdoptionCommandSchema.parse(original.command); current();
      return checkedRequest(await json(await request(`/owner-response-adoptions/${encodeURIComponent(original.id)}/cancel`, { method: "POST", body: JSON.stringify(body) })), original.command, original.id);
    },
  };
}
