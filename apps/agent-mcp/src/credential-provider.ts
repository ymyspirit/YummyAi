/** One personal grant and one token are held for the entire ERP authority fence.
 * Refresh is allowed before a fence, never as an automatic retry of an ERP POST. */
export type AgentMcpCredentialLease = Readonly<{
  accessToken: string;
  assertCurrent(signal?: AbortSignal): Promise<void>;
}>;

export type AgentMcpCredentialProvider = Readonly<{
  acquire(signal: AbortSignal): Promise<AgentMcpCredentialLease>;
}>;
