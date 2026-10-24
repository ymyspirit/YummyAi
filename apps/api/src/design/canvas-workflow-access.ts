import { ConflictException, NotFoundException } from "@nestjs/common";
import * as shared from "@yummyai/catalog-core";

export const creativeOwnerFilter = shared.creativeOwnerFilter;
export const printSpecOwner = shared.printSpecOwner;
export const requireReferenceAuthority = shared.requireReferenceAuthority;
async function apiPolicy<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch(error) {
    if(error instanceof Error && "status" in error && error.status === 404) throw new NotFoundException(error.message);
    if(error instanceof Error && "status" in error && error.status === 409) throw new ConflictException(error.message);
    throw error;
  }
}
export function requirePrintSpecAccess(...args: Parameters<typeof shared.requirePrintSpecAccess>) {
  return apiPolicy(() => shared.requirePrintSpecAccess(...args));
}

export function requireBatchAccess(...args: Parameters<typeof shared.requireBatchAccess>) {
  return apiPolicy(() => shared.requireBatchAccess(...args));
}

export function requireCreativeVersionAccess(...args: Parameters<typeof shared.requireCreativeVersionAccess>) {
  return apiPolicy(() => shared.requireCreativeVersionAccess(...args));
}

export function requireBatchInputs(...args: Parameters<typeof shared.requireBatchInputs>) {
  return apiPolicy(() => shared.requireBatchInputs(...args));
}

export function requireProductTargets(...args: Parameters<typeof shared.requireProductTargets>) {
  return apiPolicy(() => shared.requireProductTargets(...args));
}

export function currentCreativeWorkspaceAuthority(...args: Parameters<typeof shared.currentCreativeWorkspaceAuthority>) {
  return apiPolicy(() => shared.currentCreativeWorkspaceAuthority(...args));
}
