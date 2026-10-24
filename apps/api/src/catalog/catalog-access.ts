import { ConflictException, NotFoundException } from "@nestjs/common";
import { CatalogAccessNotFoundError, CatalogAuthorityChangedError, CatalogError } from "@yummyai/catalog-core";
import { withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import type { TenantContext } from "@yummyai/contracts";

/** Keep shared domain errors compatible with the API's public error contract. */
export async function withCatalogTenant<T>(
  database: DatabaseConnection["db"],
  context: TenantContext,
  operation: (tx: TenantTransaction) => Promise<T>,
  options?: { isolationLevel: "repeatable read"; accessMode: "read only" },
): Promise<T> {
  try {
    return await withTenant(database, context, operation, options);
  } catch (error) {
    throwCatalogFailure(error);
  }
}

/** Catalog functions may participate in another owner's transaction without opening a nested one. */
export function throwCatalogFailure(error: unknown): never {
  if (error instanceof CatalogAccessNotFoundError) throw new NotFoundException(error.message);
  if (error instanceof CatalogAuthorityChangedError) throw new ConflictException(error.message);
  if (error instanceof CatalogError && error.status === 409) throw new ConflictException(error.message);
  const code = (error as { code?: string; cause?: { code?: string } })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
  if (code === "40P01" || code === "40001") throw new ConflictException("并发更新中断 请先核对当前记录再操作");
  throw error;
}
