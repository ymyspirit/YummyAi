import { MarketplaceConnectorError } from "@yummyai/marketplace-connectors";

export type CredentialBoundary = { accountStatus: string; platform: string; refreshState: string; useId: string | null; deletedAt: Date | null };

/** Unadapted rotating-token workers cannot race the central refresh owner. */
export function requireWorkerMarketplaceCredential(value: CredentialBoundary | undefined): asserts value is CredentialBoundary {
  if (value?.platform === "etsy")
    throw new MarketplaceConnectorError("etsy", "validation", "ETSY_REFRESH_OWNER_REQUIRED: 此执行入口尚未接入统一凭据刷新 请等待接入后再执行");
  if (!value || value.accountStatus !== "active" || value.refreshState !== "known" || value.useId !== null || value.deletedAt !== null)
    throw new MarketplaceConnectorError("amazon", "conflict", "MARKETPLACE_CREDENTIAL_UNAVAILABLE: 当前店铺执行许可不可用 请核对授权或原任务状态");
}
