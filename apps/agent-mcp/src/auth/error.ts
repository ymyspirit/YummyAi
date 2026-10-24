export type AgentMcpAuthErrorCode =
  | "mcp_auth_profile_invalid" | "mcp_auth_required" | "mcp_auth_cache_invalid"
  | "mcp_auth_storage_unavailable" | "mcp_auth_cancelled" | "mcp_auth_timeout"
  | "mcp_auth_login_failed" | "mcp_auth_flow_invalid" | "mcp_auth_identity_changed"
  | "mcp_auth_session_changed" | "mcp_auth_refresh_pending" | "mcp_auth_refresh_unknown"
  | "mcp_auth_token_too_short";

/** Never retain an IdP error description, callback, token, or subprocess output. */
export class AgentMcpAuthError extends Error {
  constructor(readonly code: AgentMcpAuthErrorCode) {
    super(code);
    this.name = "AgentMcpAuthError";
  }
}

export function authCheck(condition: unknown, code: AgentMcpAuthErrorCode): asserts condition {
  if (!condition) throw new AgentMcpAuthError(code);
}

export function authAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AgentMcpAuthError("mcp_auth_cancelled");
}
