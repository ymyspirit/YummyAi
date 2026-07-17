import { authorize, ForbiddenError, Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";

export type AssetDomain = "research" | "authorized";

export interface StoredAsset {
  id: string;
  tenantId: string;
  assetDomain: AssetDomain;
  objectKey: string;
}

export function objectKey(input: {
  tenantId: string;
  domain: AssetDomain;
  sha256: string;
  fileName: string;
}): string {
  const sha256 = input.sha256.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("A lowercase SHA-256 checksum is required");

  const replacedName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeName = replacedName === "." || replacedName === ".." || !replacedName ? "file" : replacedName;
  return `tenants/${input.tenantId}/${input.domain}/${sha256}/${safeName}`;
}

export function assertAssetAccess(
  context: TenantContext,
  asset: StoredAsset,
  requiredDomain: AssetDomain,
): void {
  authorize(context, Permission.AssetRead);
  const expectedPrefix = `tenants/${context.tenantId}/${asset.assetDomain}/`;

  if (
    asset.tenantId !== context.tenantId ||
    asset.assetDomain !== requiredDomain ||
    !asset.objectKey.startsWith(expectedPrefix)
  ) {
    throw new ForbiddenError(Permission.AssetRead, "outside_data_scope");
  }
}

export function isSignedUrlExpired(url: string, now = new Date()): boolean {
  const parsed = new URL(url);
  const signedAt = parsed.searchParams.get("X-Amz-Date");
  const expires = Number(parsed.searchParams.get("X-Amz-Expires"));
  if (!signedAt || !Number.isFinite(expires)) return true;

  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(signedAt);
  if (!match) return true;
  const [, year, month, day, hour, minute, second] = match;
  const signedAtMs = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
  return now.getTime() > signedAtMs + expires * 1000;
}
