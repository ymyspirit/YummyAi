/** Disposable-process barriers only. Never imported by a product entry point. */
import { createRequire } from "node:module";
import type { NestExpressApplication } from "../../apps/api/node_modules/@nestjs/platform-express/index.js";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

requireDisposableIntegrationEnvironment();
const apiRequire = createRequire(new URL("../../apps/api/package.json", import.meta.url));
apiRequire("reflect-metadata");
const { NestFactory } = apiRequire("@nestjs/core") as typeof import("../../apps/api/node_modules/@nestjs/core/index.js");
const { mergeMap } = apiRequire("rxjs");
const { AppModule } = await import("../../apps/api/src/app.module.js");
const { AuditService } = await import("../../apps/api/src/audit/audit.service.js");
const commandId = process.env.INCOMING_FIXTURE_COMMAND_ID;
const gate = process.env.INCOMING_FIXTURE_GATE ?? "none";
if (!["none", "before_commit", "after_commit"].includes(gate) || gate !== "none" && !/^[a-f0-9-]{14}7[a-f0-9-]{21}$/.test(commandId ?? ""))
  throw new Error("Invalid isolated incoming-process barrier");
const send = (event: unknown) => { if (process.connected) process.send?.(event); };
const watchdog = setTimeout(() => process.exit(92), 180_000); watchdog.unref();
const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false, cors: false });
const hold = (phase: string) => { send({ type: "incoming.fixture.barrier", phase, commandId, pid: process.pid }); return new Promise<never>(() => {}); };
if (gate === "before_commit") {
  const audit = app.get(AuditService), original = audit.recordInTransaction.bind(audit);
  audit.recordInTransaction = async (tx, context, event) => {
    const result = await original(tx, context, event);
    if (event.action === "procurement.incoming.command.execute" && event.resourceId === commandId) await hold("before_commit");
    return result;
  };
}
if (gate === "after_commit") app.useGlobalInterceptors({ intercept(context, next) {
  const request = context.switchToHttp().getRequest<{ method: string; url: string }>();
  return next.handle().pipe(mergeMap(async (value: unknown) => {
    if (request.method === "POST" && request.url === `/v1/procurement/incoming/commands/${commandId}/execute` &&
      value && typeof value === "object" && "status" in value && value.status === "succeeded") await hold("after_commit");
    return value;
  }));
} });
app.useBodyParser("json", { limit: "256kb" });
await app.listen(0, "127.0.0.1");
const address = app.getHttpServer().address();
if (!address || typeof address === "string") throw new Error("Isolated API address missing");
send({ type: "incoming.fixture.ready", url: `http://127.0.0.1:${address.port}`, pid: process.pid });
let closing = false;
const close = async () => { if (closing) return; closing = true; await app.close(); send({ type: "incoming.fixture.closed", pid: process.pid }); process.exit(0); };
process.on("message", message => { if (message === "shutdown") void close(); });
process.on("disconnect", () => { void close(); });
