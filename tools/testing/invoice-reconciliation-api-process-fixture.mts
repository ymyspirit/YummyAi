/** Reuse the real API's same-transaction audit and post-commit response barriers. */
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

requireDisposableIntegrationEnvironment();
if (process.env.E2E_INVOICE_RECONCILIATION_ISOLATED !== "1" || process.env.E2E_PROCUREMENT_PROCESS_ISOLATED !== "1" || !process.connected)
  throw new Error("Invoice reconciliation process barriers require disposable IPC ownership");
await import("./procurement-api-process-fixture.mjs");
