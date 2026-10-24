import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import type { z } from "zod";
import { parseAgentMcpApiUrl, type AgentMcpConfig } from "./config.js";
import type { AgentMcpCredentialLease, AgentMcpCredentialProvider } from "./credential-provider.js";

export type AgentMcpErrorCode =
  | "mcp_cancelled" | "mcp_deadline_exceeded" | "mcp_http_failed" | "mcp_identity_required"
  | "mcp_authority_changed" | "mcp_response_invalid" | "mcp_policy_denied"
  | "mcp_input_invalid" | "mcp_submission_unknown" | "mcp_result_unavailable";

export class AgentMcpHttpError extends Error {
  constructor(readonly code: AgentMcpErrorCode, readonly status = 0,
    readonly recovery: Readonly<Record<string, string>> | null = null) {
    super(code); this.name = "AgentMcpHttpError";
  }
}

type Fetch = typeof globalThis.fetch;
type BoundRequest = <T>(method: "GET" | "POST", path: string, schema: z.ZodType<T>,
  options?: { body?: unknown; status?: number; submitted?: boolean; recovery?: Readonly<Record<string, string>> }) => Promise<T>;
export type AgentMcpHttpScope = Readonly<{ authority: string; request: BoundRequest; throwIfCancelled(): void }>;

/** No cookies, redirects, global environment loading, or arbitrary destinations. */
export class AgentMcpHttpClient {
  private readonly origin: string;
  private readonly token: string;
  constructor(config: AgentMcpConfig, private readonly fetcher: Fetch = globalThis.fetch,
    private readonly credentials?: AgentMcpCredentialProvider) {
    this.origin = parseAgentMcpApiUrl(config.apiUrl);
    this.token = config.accessToken;
  }

  async withAuthority<T>(action: (scope: AgentMcpHttpScope) => Promise<T>, signal?: AbortSignal): Promise<{ authority: string; value: T }> {
    const deadline = AbortSignal.timeout(120_000);
    const readSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const readAbortCode = () => signal?.aborted ? "mcp_cancelled" as const : "mcp_deadline_exceeded" as const;
    const deadlineCode = () => "mcp_deadline_exceeded" as const;
    const throwIfCancelled = () => {
      if (signal?.aborted) throw new AgentMcpHttpError("mcp_cancelled");
      if (deadline.aborted) throw new AgentMcpHttpError("mcp_deadline_exceeded");
    };
    throwIfCancelled();
    let lease: AgentMcpCredentialLease | undefined;
    try { lease = await this.credentials?.acquire(readSignal); }
    catch { throwIfCancelled(); throw new AgentMcpHttpError("mcp_identity_required", 401); }
    const token = lease?.accessToken ?? this.token;
    if (token.length > 32_768 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
      throw new AgentMcpHttpError("mcp_identity_required", 401);
    const assertGrant = async (guardSignal = readSignal) => {
      try { await lease?.assertCurrent(guardSignal); }
      catch { throw new AgentMcpHttpError("mcp_identity_required", 401); }
    };
    await assertGrant();
    const authority = await this.session(token, readSignal, readAbortCode);
    let submitted = false;
    let submissionRecovery: Readonly<Record<string, string>> | null = null;
    const request: BoundRequest = async (method, path, schema, options = {}) => {
      throwIfCancelled();
      await assertGrant();
      if (options.submitted) { submitted = true; submissionRecovery = options.recovery ?? null; }
      return this.json(method, path, schema, {
        ...options, authority, token,
        // Losing the MCP connection must not cancel an already submitted write.
        signal: options.submitted ? deadline : readSignal,
        abortCode: options.submitted ? deadlineCode : readAbortCode,
      });
    };
    let outcome: { ok: true; value: T } | { ok: false; error: AgentMcpHttpError };
    try { outcome = { ok: true, value: await action({ authority, request, throwIfCancelled }) }; }
    catch (error) {
      // A failed result is never returned as private data. Known HTTP errors
      // remain safe; an uncertain submission carries identifiers only.
      outcome = { ok: false, error: error instanceof AgentMcpHttpError ? error :
        signal?.aborted && !submitted ? new AgentMcpHttpError("mcp_cancelled") :
          new AgentMcpHttpError(submitted ? "mcp_submission_unknown" : "mcp_response_invalid", 0, submissionRecovery) };
    }
    try {
      await assertGrant(submitted ? deadline : readSignal);
      const after = await this.session(token, submitted ? deadline : readSignal, submitted ? deadlineCode : readAbortCode);
      if (after !== authority) throw new AgentMcpHttpError("mcp_authority_changed", 409);
      await assertGrant(submitted ? deadline : readSignal);
      throwIfCancelled();
    } catch (failure) {
      const error = failure instanceof AgentMcpHttpError ? failure : new AgentMcpHttpError("mcp_http_failed");
      // The authority fence always discards the private result. A committed or
      // uncertain write still has its original identifier-only recovery route.
      throw new AgentMcpHttpError(error.code, error.status, submissionRecovery);
    }
    if (!outcome.ok) throw outcome.error;
    return { authority, value: outcome.value };
  }

  private async session(token: string, signal: AbortSignal, abortCode: () => AgentMcpErrorCode): Promise<string> {
    const session = await this.json("GET", "/v1/identity/session", ErpSessionViewSchema, { signal, abortCode, token });
    if (!session.authenticated || !session.canUseErp || !session.permissionScopes || !session.teamAuthority || !session.teamIds)
      throw new AgentMcpHttpError("mcp_identity_required", 401);
    return erpSessionAuthority(session);
  }

  private async json<T>(method: "GET" | "POST", path: string, schema: z.ZodType<T>, options: {
    signal: AbortSignal; token: string; authority?: string; body?: unknown; status?: number; submitted?: boolean;
    recovery?: Readonly<Record<string, string>>; abortCode?: () => AgentMcpErrorCode;
  }): Promise<T> {
    if (!path.startsWith("/v1/") || path.startsWith("//") || path.includes("#") || path.includes("\\"))
      throw new AgentMcpHttpError("mcp_input_invalid", 400);
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin || url.username || url.password || url.hash)
      throw new AgentMcpHttpError("mcp_input_invalid", 400);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method, cache: "no-store", credentials: "omit", redirect: "error", signal: options.signal,
        headers: { accept: "application/json", authorization: "Bearer " + options.token,
          ...(options.authority ? { "x-yummyai-context-authority": options.authority } : {}),
          ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch {
      if (options.submitted) throw new AgentMcpHttpError("mcp_submission_unknown", 0, options.recovery ?? null);
      if (options.signal.aborted) throw new AgentMcpHttpError(options.abortCode?.() ?? "mcp_cancelled");
      throw new AgentMcpHttpError("mcp_http_failed");
    }
    let raw: unknown;
    try { raw = await boundedJson(response, response.ok ? 8 * 1024 * 1024 : 8192); }
    catch {
      if (options.submitted) throw new AgentMcpHttpError("mcp_submission_unknown", response.status, options.recovery ?? null);
      if (options.signal.aborted) throw new AgentMcpHttpError(options.abortCode?.() ?? "mcp_cancelled");
      throw new AgentMcpHttpError("mcp_response_invalid", response.ok ? 502 : response.status);
    }
    if (!response.ok) {
      const authorityChanged = response.status === 409 && raw !== null && typeof raw === "object" &&
        "code" in raw && raw.code === "authority_changed";
      if (authorityChanged) throw new AgentMcpHttpError("mcp_authority_changed", 409,
        options.submitted ? options.recovery ?? null : null);
      // Server errors cannot prove a write was rolled back. Never send again.
      if (options.submitted && response.status >= 500)
        throw new AgentMcpHttpError("mcp_submission_unknown", response.status, options.recovery ?? null);
      throw new AgentMcpHttpError(response.status === 401 ? "mcp_identity_required" : "mcp_http_failed", response.status);
    }
    const parsed = schema.safeParse(raw);
    if (response.status !== (options.status ?? 200) || !parsed.success) {
      if (options.submitted) throw new AgentMcpHttpError("mcp_submission_unknown", response.status, options.recovery ?? null);
      throw new AgentMcpHttpError("mcp_response_invalid", 502);
    }
    if (options.authority && (parsed.data === null || typeof parsed.data !== "object" ||
      !("contextAuthority" in parsed.data) || parsed.data.contextAuthority !== options.authority))
      throw new AgentMcpHttpError("mcp_authority_changed", 409,
        options.submitted ? options.recovery ?? null : null);
    return parsed.data;
  }
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
    await response.body?.cancel(); throw new Error("json");
  }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > limit)) {
    await response.body?.cancel(); throw new Error("size");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("body");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error("size"); }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } finally { reader.releaseLock(); }
}
