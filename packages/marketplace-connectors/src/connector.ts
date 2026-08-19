import type {
  MarketplaceCapability,
  MarketplaceHealthStatus,
  MarketplacePlatform,
  MarketplaceRegion,
} from "@yummyai/contracts";

export interface MarketplaceConnectorContext {
  accountId: string;
  tenantId: string;
  platform: MarketplacePlatform;
  externalAccountId: string | null;
  region: MarketplaceRegion;
  marketplaceIds: readonly string[];
}

export interface MarketplaceCredentialAccessor {
  withCredential<T>(callback: (credential: Readonly<Record<string, string>>) => Promise<T>): Promise<T>;
}

export interface ConnectorHealthResult {
  status: Exclude<MarketplaceHealthStatus, "not_checked">;
  checkedAt: string;
  latencyMs: number;
  errorCode?: string;
}

export interface ConnectorCapabilityResult {
  capabilities: readonly MarketplaceCapability[];
  sourceVersion: string;
  syncedAt: string;
}

export interface MarketplacePublishInput {
  idempotencyKey: string;
  listingId: string;
  listingVersionId: string;
  marketplaceId: string;
  payload: unknown;
}

export interface MarketplacePublishResult {
  externalListingId: string;
  externalState: string;
  submittedAt: string;
  issues: readonly MarketplaceIssue[];
}

export interface MarketplaceIssue {
  code: string;
  message: string;
  path?: string;
  severity: "blocker" | "warning" | "info";
}

export interface MarketplaceConnector {
  readonly platform: MarketplacePlatform;
  healthCheck(context: MarketplaceConnectorContext, credentials: MarketplaceCredentialAccessor, signal: AbortSignal): Promise<ConnectorHealthResult>;
  syncCapabilities(context: MarketplaceConnectorContext, credentials: MarketplaceCredentialAccessor, signal: AbortSignal): Promise<ConnectorCapabilityResult>;
  createDraft(context: MarketplaceConnectorContext, credentials: MarketplaceCredentialAccessor, input: MarketplacePublishInput, signal: AbortSignal): Promise<MarketplacePublishResult>;
  uploadMedia(context: MarketplaceConnectorContext, credentials: MarketplaceCredentialAccessor, externalListingId: string, media: readonly Uint8Array[], signal: AbortSignal): Promise<void>;
  activate(context: MarketplaceConnectorContext, credentials: MarketplaceCredentialAccessor, externalListingId: string, signal: AbortSignal): Promise<MarketplacePublishResult>;
  getStatus(context: MarketplaceConnectorContext, credentials: MarketplaceCredentialAccessor, externalListingId: string, signal: AbortSignal): Promise<MarketplacePublishResult>;
}
