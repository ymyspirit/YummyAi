/** Synthetic fixtures for the compiled personal browser only. No public test
 * control route, queue consumer, model, or external business action. */
import "../../apps/api/node_modules/reflect-metadata/Reflect.js";
import { TenantContextSchema } from "../../packages/contracts/src/index.js";
import { connectDatabase, type DatabaseConnection } from "../../packages/database/src/index.js";
import { createOrderSummaryFixture, OrderSummaryCasePinsSchema, type OrderSummaryCase,
  type OrderSummaryCaseKind } from "../../apps/api/src/orders/order-summary-availability.test-fixture.js";
import { requireOrderSummaryEnvironment } from "./require-order-summary-availability-environment.mjs";

const send = (message: object) => new Promise<void>((resolve, reject) => {
  if (!process.connected || !process.send) { reject(new Error("summary_browser_ipc_required")); return; }
  process.send(message, error => error ? reject(error) : resolve());
});
const safePins = (value: OrderSummaryCase) => OrderSummaryCasePinsSchema.parse({
  kind: value.kind, accountId: value.accountId, orderId: value.orderId, lineId: value.lineId,
  reportLineId: value.reportLineId, reportVersionId: value.reportVersionId,
  externalOrderId: value.externalOrderId, externalLineId: value.externalLineId,
  revision: value.revision, projectionVersion: value.projectionVersion,
});
let database: DatabaseConnection | undefined;
let fixture: Awaited<ReturnType<typeof createOrderSummaryFixture>> | undefined;
let phase = "environment";
try {
  const isolated = requireOrderSummaryEnvironment(process.env, true), mode = process.argv[2];
  if (!process.connected || !["mixed", "late", "transition"].includes(mode ?? "")) throw new Error("summary_browser_mode_invalid");
  // Install before the first asynchronous identity request so an early parent
  // message is retained rather than lost while the original actor is checked.
  const transitionMessage = mode === "transition" ? new Promise<unknown>(resolve => process.once("message", resolve)) : null;
  phase = "identity";
  const response = await fetch(new URL("/v1/identity/session", process.env.API_BASE_URL), {
    headers: { authorization: "Bearer " + process.env.API_ACCESS_TOKEN }, redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== 200) throw new Error("summary_browser_identity_unavailable");
  const context = TenantContextSchema.parse(await response.json());
  const actor = JSON.parse(process.env.ERP_FIXTURE_ACTORS!).operator;
  if (context.userId !== actor.userId || context.tenantId !== actor.tenantId) throw new Error("summary_browser_original_actor_mismatch");
  database = connectDatabase(isolated.url);
  fixture = await createOrderSummaryFixture({ database, context });
  if (mode === "transition") {
    phase = "transition_admission";
    const message = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("summary_browser_transition_timeout")), 15_000);
      transitionMessage!.then(value => { clearTimeout(timer); resolve(value); }, reject);
    });
    if (!message || typeof message !== "object" || !("nonce" in message) || message.nonce !== isolated.nonce
      || !("action" in message) || message.action !== "anonymize" || !("case" in message)
      || Object.keys(message).some(key => !["nonce", "action", "case"].includes(key)))
      throw new Error("summary_browser_transition_invalid");
    const value = await fixture.registerCase(message.case);
    phase = "original_anonymization";
    await fixture.anonymize(value);
    const { items } = await fixture.work.summaries(await fixture.current(), { ids: [value.lineId] });
    if (items.length !== 1 || items[0]!.availability !== "cleared" || items[0]!.fields.length
      || items[0]!.images.length || items[0]!.instructions !== "") throw new Error("summary_browser_original_clear_missing");
    phase = "cleanup"; await fixture.close(); fixture = undefined; database = undefined;
    await send({ type: "summary.browser.transitioned", nonce: isolated.nonce, orderId: value.orderId,
      lineId: value.lineId, action: "anonymize", availability: "cleared", resourcesClosed: true });
  } else {
    phase = "seed";
    const kinds: OrderSummaryCaseKind[] = mode === "mixed"
      ? ["healthy_saved", "healthy_no_work", "anonymized", "expired", "purged", "archived"] : ["healthy_saved"];
    const cases = [];
    for (const kind of kinds) {
      const value = await fixture.createCase(kind), [facts] = await fixture.facts([value]);
      if (!facts || facts.orderId !== value.orderId) throw new Error("summary_browser_original_pins_missing");
      cases.push(safePins({ ...value, revision: facts.work?.revision ?? value.revision,
        projectionVersion: facts.work?.projectionVersion ?? value.projectionVersion }));
    }
    const query = fixture.groupKey;
    phase = "cleanup"; await fixture.close(); fixture = undefined; database = undefined;
    await send({ type: "summary.browser.seeded", mode, nonce: isolated.nonce, query, cases,
      resourcesClosed: true, modelCalls: 0, workerProcesses: 0 });
  }
} catch (error) {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : null;
  await send({ type: "summary.browser.failed", phase, errorName: error instanceof Error ? error.name : "Error", code }).catch(() => {});
  process.exitCode = 1;
} finally {
  try { if (fixture) await fixture.close(); else await database?.client.end(); }
  catch { process.exitCode = 1; }
  if (process.connected) process.disconnect();
}
