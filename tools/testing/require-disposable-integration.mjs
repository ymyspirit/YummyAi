import process from "node:process";
import { URL } from "node:url";

/** Integration runners must supply their own database before any .env fallback or connection. */
export function requireDisposableIntegrationEnvironment(environment = process.env) {
  const value = environment.DATABASE_URL;
  if (environment.E2E_ISOLATED_DAILY !== "1" || !value) throw new Error("Database integration requires the disposable acceptance runner");
  let url;
  try { url = new URL(value); } catch { throw new Error("Disposable database URL is invalid"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(url.pathname))
    throw new Error("Database integration refuses a non-disposable database");
  return value;
}

/** Wait for every workspace even after a failure; never recurse into the root runner. */
export function workspaceIntegrationArgs(extra = []) {
  return ["-r", "--workspace-concurrency=1", "--no-bail", "--filter=!yummyai-erp", "--if-present", "test:integration", "--cache=false", ...extra];
}
