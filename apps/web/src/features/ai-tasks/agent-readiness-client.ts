import {
  AgentReadinessFamilySchema,
  AgentReadinessSchema,
  type AgentReadiness,
  type AgentReadinessFamily,
} from "@yummyai/contracts/ai/agent-readiness";
import {
  AGENT_RUNTIME_FAMILIES,
  AgentRuntimeReadinessSchema,
  type AgentRuntimeReadiness,
} from "@yummyai/contracts/ai/agent-runtime-readiness";

export class AgentReadinessRequestError extends Error {
  constructor(readonly status: number, readonly code: "authority_changed" | null = null) {
    super(code === "authority_changed"
      ? "当前身份或授权范围已变化 请重新核对启动条件"
      : status === 401 ? "请重新登录自己的运营账户后读取启动诊断"
        : status === 403 || status === 404 ? "当前无法读取这类任务的启动诊断"
          : "启动诊断读取失败 未判定为可启动 请只读刷新后核对");
  }
}

/** Metadata only. This request never creates, resumes or stops a task. */
export async function readAgentReadiness(
  family: AgentReadinessFamily,
  authority: string,
  signal?: AbortSignal,
): Promise<AgentReadiness> {
  const selected = AgentReadinessFamilySchema.safeParse(family);
  if (!selected.success) throw new AgentReadinessRequestError(400);
  if (!authority) throw new AgentReadinessRequestError(401);
  const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]);
  let response: Response;
  try {
    response = await fetch("/api/agent-readiness/" + selected.data, {
      method: "GET", cache: "no-store", credentials: "same-origin", signal: requestSignal,
      headers: { "x-yummyai-context-authority": authority },
    });
  } catch { throw new AgentReadinessRequestError(0); }
  const reader = response.body?.getReader();
  if (!reader) throw new AgentReadinessRequestError(response.ok ? 502 : response.status);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const limit = response.ok ? 512 * 1024 : 8192;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error("size"); }
      chunks.push(part.value);
    }
  } catch { throw new AgentReadinessRequestError(response.ok ? 502 : response.status); }
  finally { reader.releaseLock(); }
  let raw: unknown;
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { throw new AgentReadinessRequestError(response.ok ? 502 : response.status); }
  if (!response.ok) {
    const changed = response.status === 409 && raw !== null && typeof raw === "object" && "code" in raw && raw.code === "authority_changed";
    throw new AgentReadinessRequestError(response.status, changed ? "authority_changed" : null);
  }
  if (requestSignal.aborted) throw new AgentReadinessRequestError(0);
  if (response.headers.get("x-yummyai-context-authority") !== authority)
    throw new AgentReadinessRequestError(409, "authority_changed");
  const parsed = AgentReadinessSchema.safeParse(raw);
  if (response.status !== 200 || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json") || !parsed.success || parsed.data.family !== selected.data)
    throw new AgentReadinessRequestError(502);
  if (parsed.data.contextAuthority !== authority)
    throw new AgentReadinessRequestError(409, "authority_changed");
  return parsed.data;
}

export class AgentRuntimeReadinessRequestError extends Error {
  constructor(readonly status: number, readonly code: "authority_changed" | null = null) {
    super(code === "authority_changed"
      ? "当前身份或授权范围已变化 原执行服务观察已失效"
      : status === 401 ? "请重新登录自己的运营账户后核对执行服务"
        : status === 403 || status === 404 ? "当前无法读取这类任务的执行服务观察"
          : "执行服务诊断读取失败 当前没有有效就绪证明 新付费提交不可用");
  }
}

/** Independent metadata read. It does not dispatch or resume existing tasks. */
export async function readAgentRuntimeReadiness(
  family: AgentReadinessFamily,
  authority: string,
  signal?: AbortSignal,
): Promise<AgentRuntimeReadiness> {
  const selected = AgentReadinessFamilySchema.safeParse(family);
  if (!selected.success) throw new AgentRuntimeReadinessRequestError(400);
  if (!authority) throw new AgentRuntimeReadinessRequestError(401);
  const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(8_000)]);
  let response: Response;
  try {
    response = await fetch("/api/agent-runtime-readiness/" + selected.data, {
      method: "GET", cache: "no-store", credentials: "same-origin", redirect: "error", signal: requestSignal,
      headers: { "x-yummyai-context-authority": authority },
    });
  } catch { throw new AgentRuntimeReadinessRequestError(0); }
  const reader = response.body?.getReader();
  if (!reader) throw new AgentRuntimeReadinessRequestError(response.ok ? 502 : response.status);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const limit = response.ok ? 512 * 1024 : 8192;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error("size"); }
      chunks.push(part.value);
    }
  } catch { throw new AgentRuntimeReadinessRequestError(response.ok ? 502 : response.status); }
  finally { reader.releaseLock(); }
  let raw: unknown;
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { throw new AgentRuntimeReadinessRequestError(response.ok ? 502 : response.status); }
  if (!response.ok) {
    const changed = response.status === 409 && raw !== null && typeof raw === "object" && "code" in raw && raw.code === "authority_changed";
    throw new AgentRuntimeReadinessRequestError(response.status, changed ? "authority_changed" : null);
  }
  if (requestSignal.aborted) throw new AgentRuntimeReadinessRequestError(0);
  if (response.headers.get("x-yummyai-context-authority") !== authority)
    throw new AgentRuntimeReadinessRequestError(409, "authority_changed");
  const parsed = AgentRuntimeReadinessSchema.safeParse(raw);
  if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
    || !parsed.success || parsed.data.family !== selected.data || parsed.data.executorVersion !== AGENT_RUNTIME_FAMILIES[selected.data].executorVersion)
    throw new AgentRuntimeReadinessRequestError(502);
  if (parsed.data.contextAuthority !== authority)
    throw new AgentRuntimeReadinessRequestError(409, "authority_changed");
  return parsed.data;
}
