/** Framework-free preservation of an original domain owner's public error.
 * API adapters translate this back to the matching HTTP exception; workers
 * preserve status/code without importing a web application or logging bodies. */
export class OriginalOwnerError extends Error {
  readonly name = "OriginalOwnerError";
  constructor(readonly status: 400 | 401 | 403 | 404 | 408 | 409 | 422 | 429 | 500 | 502 | 503 | 504,
    readonly response: string | Record<string, unknown>) {
    super(typeof response === "string" ? response : typeof response.message === "string" ? response.message : "original_owner_error");
  }
  getStatus() { return this.status; }
  getResponse() { return this.response; }
}
