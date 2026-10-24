export class CatalogError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.statusCode = status;
  }
}
export interface CatalogErrors {
  notFound(message: string): Error;
  conflict(message: string): Error;
  unprocessable(message: string | Record<string, unknown>): Error;
}
export const catalogErrors: CatalogErrors = {
  notFound: (message) => new CatalogError("CATALOG_NOT_FOUND", 404, message),
  conflict: (message) => new CatalogError("CATALOG_CONFLICT", 409, message),
  unprocessable: (message) =>
    new CatalogError(
      "CATALOG_VALIDATION_FAILED",
      422,
      typeof message === "string" ? message : "Product package is incomplete",
    ),
};
