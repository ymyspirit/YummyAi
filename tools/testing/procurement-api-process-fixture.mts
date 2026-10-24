/** Actual API with disposable-only commit/response barriers. No owner result is mocked. */
import { createRequire } from "node:module";
import type { NestExpressApplication } from "../../apps/api/node_modules/@nestjs/platform-express/index.js";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

requireDisposableIntegrationEnvironment();
if (process.env.E2E_PROCUREMENT_PROCESS_ISOLATED !== "1" || !process.connected)
  throw new Error("Procurement-process barriers require their independent disposable IPC suite");
const gate = process.env.PROCUREMENT_FIXTURE_GATE ?? "none";
const action = process.env.PROCUREMENT_FIXTURE_ACTION ?? "execute";
const commandId = process.env.PROCUREMENT_FIXTURE_COMMAND_ID;
const requestKey = process.env.PROCUREMENT_FIXTURE_REQUEST_KEY;
if (!["none", "before_commit", "after_commit"].includes(gate) || !["prepare", "execute"].includes(action)
  || gate !== "none" && (action === "prepare"
    ? !/^synthetic-procurement-command-[a-f0-9-]{36}$/.test(requestKey ?? "")
    : !/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(commandId ?? "")))
  throw new Error("Invalid isolated procurement-process barrier");

const apiRequire = createRequire(new URL("../../apps/api/package.json", import.meta.url));
apiRequire("reflect-metadata");
const { NestFactory } = apiRequire("@nestjs/core") as typeof import("../../apps/api/node_modules/@nestjs/core/index.js");
const { mergeMap } = apiRequire("rxjs");
const { sql } = apiRequire("drizzle-orm") as typeof import("../../apps/api/node_modules/drizzle-orm/index.js");
const { AppModule } = await import("../../apps/api/src/app.module.js");
const { AuditService } = await import("../../apps/api/src/audit/audit.service.js");
const send = (event: unknown) => { if (process.connected) process.send?.(event); };
const watchdog = setTimeout(() => process.exit(92), 180_000); watchdog.unref();
const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false, cors: false });
const hold = (phase: string, id: string) => {
  send({ type: "procurement.fixture.barrier", phase, action, commandId: id, pid: process.pid });
  return new Promise<never>(() => {});
};
if (gate === "before_commit") {
  const audit = app.get(AuditService), original = audit.recordInTransaction.bind(audit);
  audit.recordInTransaction = async (tx, context, event) => {
    const result = await original(tx, context, event);
    if (event.action !== `procurement.command.${action}`) return result;
    if (action === "execute" && typeof commandId === "string" && event.resourceId === commandId) await hold("before_commit", commandId);
    if (action === "prepare") {
      // Match the real inserted row in this same uncommitted transaction.
      const [row] = await tx.execute<{ id: string }>(sql`select id from inventory_procurement_commands
        where id=${event.resourceId}::uuid and request_key=${requestKey}`);
      if (row) await hold("before_commit", row.id);
    }
    return result;
  };
}
if (gate === "after_commit") app.useGlobalInterceptors({ intercept(context, next) {
  const request = context.switchToHttp().getRequest<{ method: string; url: string }>();
  return next.handle().pipe(mergeMap(async (value: unknown) => {
    if (request.method !== "POST" || !value || typeof value !== "object" || !("id" in value)
      || typeof value.id !== "string" || !("status" in value)) return value;
    if (action === "execute" && request.url === `/v1/procurement/commands/${commandId}/execute`
      && value.id === commandId && value.status === "succeeded") await hold("after_commit", value.id);
    if (action === "prepare" && request.url === "/v1/procurement/commands" && value.status === "prepared"
      && "original" in value && value.original && typeof value.original === "object"
      && "input" in value.original && value.original.input && typeof value.original.input === "object"
      && "idempotencyKey" in value.original.input && value.original.input.idempotencyKey === requestKey)
      await hold("after_commit", value.id);
    return value;
  }));
} });
app.useBodyParser("json", { limit: "256kb" });
await app.listen(0, "127.0.0.1");
const address = app.getHttpServer().address();
if (!address || typeof address === "string") throw new Error("Isolated procurement API address missing");
send({ type: "procurement.fixture.ready", url: `http://127.0.0.1:${address.port}`, pid: process.pid });
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true; await app.close();
  send({ type: "procurement.fixture.closed", pid: process.pid }); process.exit(0);
};
process.on("message", message => { if (message === "shutdown") void close(); });
process.on("disconnect", () => { void close(); });
