import { authorize, ForbiddenError, Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import type { StoredAsset } from "./asset-policy.js";

declare const permitBrand: unique symbol;
export type FactoryReadPermit = { readonly [permitBrand]: true };
type PermitState = {
  tenantId: string;
  userId: string;
  asset: StoredAsset;
  maxBytes: number;
  deadline: number;
  assertCurrent: () => Promise<void>;
};
const permits = new WeakMap<FactoryReadPermit, PermitState>();
function sameAsset(context: TenantContext, asset: StoredAsset) {
  return (
    asset.tenantId === context.tenantId &&
    asset.assetDomain === "order" &&
    asset.objectKey.startsWith(`tenants/${context.tenantId}/order/`)
  );
}
/** Server-only closure supplied by the authenticated assignment owner, never a transport value. */
export async function createFactoryReadPermit(
  context: TenantContext,
  asset: StoredAsset,
  input: { maxBytes: number; assertCurrent: () => Promise<void> },
): Promise<FactoryReadPermit> {
  authorize(context, Permission.FactoryTaskRead);
  if (
    !sameAsset(context, asset) ||
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes < 1 ||
    input.maxBytes > 64 * 1024 * 1024
  )
    throw new ForbiddenError(Permission.FactoryTaskRead, "outside_data_scope");
  await input.assertCurrent();
  const permit = Object.freeze({}) as FactoryReadPermit;
  permits.set(permit, {
    tenantId: context.tenantId,
    userId: context.userId,
    asset: Object.freeze({ ...asset }),
    maxBytes: input.maxBytes,
    deadline: performance.now() + 60_000,
    assertCurrent: input.assertCurrent,
  });
  return permit;
}
export async function assertFactoryReadPermit(
  context: TenantContext,
  asset: StoredAsset,
  permit: FactoryReadPermit,
) {
  authorize(context, Permission.FactoryTaskRead);
  const state = permits.get(permit);
  if (
    !state ||
    state.tenantId !== context.tenantId ||
    state.userId !== context.userId ||
    state.asset.id !== asset.id ||
    state.asset.tenantId !== asset.tenantId ||
    state.asset.assetDomain !== asset.assetDomain ||
    state.asset.objectKey !== asset.objectKey ||
    !sameAsset(context, asset) ||
    performance.now() > state.deadline
  )
    throw new ForbiddenError(Permission.FactoryTaskRead, "outside_data_scope");
  await state.assertCurrent();
  return state.maxBytes;
}
