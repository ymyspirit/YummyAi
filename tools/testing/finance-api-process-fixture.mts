/** Real API; commit/response barriers are available only in a disposable IPC child. */
import { createRequire } from "node:module";
import type { NestExpressApplication } from "../../apps/api/node_modules/@nestjs/platform-express/index.js";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

requireDisposableIntegrationEnvironment();
if (process.env.E2E_FINANCE_COMMAND_ISOLATED !== "1" || process.env.E2E_FINANCE_COMMAND_PROCESS_ISOLATED !== "1" || !process.connected)
  throw new Error("Finance command process barriers require their independent disposable IPC suite");
const gate = process.env.FINANCE_FIXTURE_GATE ?? "none", action = process.env.FINANCE_FIXTURE_ACTION ?? "execute";
const commandId = process.env.FINANCE_FIXTURE_COMMAND_ID, requestKey = process.env.FINANCE_FIXTURE_REQUEST_KEY;
const commandIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
if (!["none", "before_commit", "after_commit"].includes(gate) || !["prepare", "execute"].includes(action)
  || gate !== "none" && (action === "prepare" ? !/^synthetic-finance-command-[a-f0-9-]{36}$/.test(requestKey ?? "") : !commandIdPattern.test(commandId ?? "")))
  throw new Error("Invalid isolated finance command process barrier");

// AppModule and every connection-capable import occur after the exact guards.
const requireApi = createRequire(new URL("../../apps/api/package.json", import.meta.url));
requireApi("reflect-metadata");
const { NestFactory } = requireApi("@nestjs/core") as typeof import("../../apps/api/node_modules/@nestjs/core/index.js");
const { mergeMap } = requireApi("rxjs");
const { sql } = requireApi("drizzle-orm") as typeof import("../../apps/api/node_modules/drizzle-orm/index.js");
const { AppModule } = await import("../../apps/api/src/app.module.js");
const { AuditService } = await import("../../apps/api/src/audit/audit.service.js");
const send = (event: unknown) => { if (process.connected) process.send?.(event); };
const watchdog = setTimeout(() => process.exit(92), 180_000); watchdog.unref();
const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false, cors: false });
const hold = (phase: string, id: string) => {
  send({ type: "finance.fixture.barrier", phase, action, commandId: id, pid: process.pid });
  return new Promise<never>(() => {});
};
if (gate === "before_commit") {
  const audit = app.get(AuditService), record = audit.recordInTransaction.bind(audit);
  audit.recordInTransaction = async (tx, context, event) => {
    const result = await record(tx, context, event);
    if (event.action !== `finance.command.${action}`) return result;
    if (action === "execute" && event.resourceId === commandId) await hold("before_commit", commandId!);
    if (action === "prepare") {
      const [row] = await tx.execute<{ id: string }>(sql`select id from finance_commands where id=${event.resourceId}::uuid and request_key=${requestKey}`);
      if (row) await hold("before_commit", row.id);
    }
    return result;
  };
}
if (gate === "after_commit") app.useGlobalInterceptors({ intercept(context, next) {
  const request = context.switchToHttp().getRequest<{ method: string; url: string }>();
  return next.handle().pipe(mergeMap(async (value: unknown) => {
    if (request.method !== "POST" || !value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" || !("status" in value)) return value;
    if (action === "execute" && request.url === `/v1/finance/commands/${commandId}/execute` && value.id === commandId && value.status === "succeeded")
      await hold("after_commit", value.id);
    if (action === "prepare" && request.url === "/v1/finance/commands" && value.status === "prepared" && "requestKey" in value && value.requestKey === requestKey)
      await hold("after_commit", value.id);
    return value;
  }));
} });
// Match the actual Finance API, including complete reports larger than 1MiB.
app.useBodyParser("json", { limit: "28mb" });
await app.listen(0, "127.0.0.1");
const address = app.getHttpServer().address();
if (!address || typeof address === "string") throw new Error("Isolated finance API address missing");
send({ type: "finance.fixture.ready", url: `http://127.0.0.1:${address.port}`, pid: process.pid });
let closing = false;
const close = async () => {
  if (closing) return; closing = true; await app.close();
  send({ type: "finance.fixture.closed", pid: process.pid }); process.exit(0);
};
process.on("message", message => { if (message === "shutdown") void close(); });
process.on("disconnect", () => { void close(); });
