import type { SecretVault } from "@yummyai/ai-core";
import { createEntityId, ProductionEditorExportOptionsSchema, type TenantContext } from "@yummyai/contracts";
import { productionRenderDispatchTenants, productionEditorProjects as projects, productionEditorRenders as renders, withTenant, type DatabaseConnection } from "@yummyai/database";
import { createQueue, createTraceId, enqueueJob, QueueName } from "@yummyai/jobs";
import { decryptProductionBytes } from "@yummyai/production-editor";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Queue } from "bullmq";

type Delivery = { renderId: string; tenantId: string; requestedBy: string };

const due = () => and(
  sql`${renders.nextDispatchAt} <= clock_timestamp()`,
  sql`((${renders.status}='queued' AND ${renders.updatedAt}<clock_timestamp()-interval '10 seconds')
    OR (${renders.status}='failed' AND ${renders.errorCode}='queue_unavailable')
    OR (${renders.status}='processing' AND coalesce(${renders.leaseUntil},${renders.updatedAt}+interval '2 minutes')<=clock_timestamp()))`,
);

/** Original database intents own idempotency. Redis holds disposable deliveries.
 * Only order formal exports and catalog deterministic exports are recovered;
 * paid image submissions and unrelated editor owners are never replayed here. */
export async function dispatchApprovedProductionRenders(database: DatabaseConnection, vault: SecretVault, enqueue: (input: Delivery) => Promise<void>) {
  let tenantCursor: string | undefined;
  let delivered = 0;
  for (;;) {
    const tenants = await database.db.transaction(async tx => {
      await tx.execute(sql.raw("set local role yummyai_app"));
      return tx.select().from(productionRenderDispatchTenants).where(tenantCursor ? gt(productionRenderDispatchTenants.tenantId, tenantCursor) : undefined).orderBy(asc(productionRenderDispatchTenants.tenantId)).limit(50);
    });
    if (!tenants.length) break;
    for (const tenant of tenants) {
      const scope: TenantContext = { tenantId: tenant.tenantId, userId: tenant.tenantId, dataScope: "tenant", permissions: [] };
      let renderCursor: string | undefined;
      for (;;) {
        const pending = await withTenant(database.db, scope, tx => tx.select({ render: renders, project: projects }).from(renders)
          .innerJoin(projects, eq(projects.id, renders.projectId))
          .where(and(due(), sql`(${projects.sourceWorkItemId} is not null OR (${projects.sourceSalesRecipeId} is not null AND ${projects.sourceSalesSkuId} is not null))`, renderCursor ? gt(renders.id, renderCursor) : undefined))
          .orderBy(asc(renders.id)).limit(50));
        if (!pending.length) break;
        for (const { render, project } of pending) {
          if (!project.encryptedDataKey) continue;
          let key: Buffer | undefined;
          try {
            key = vault.withSecret(project.encryptedDataKey, value => Buffer.from(value, "base64"));
            const options = ProductionEditorExportOptionsSchema.safeParse(JSON.parse(Buffer.from(decryptProductionBytes(key, Buffer.from(render.encryptedOptions, "base64"))).toString("utf8")));
            if (!options.success || project.sourceWorkItemId && options.data.purpose !== "production") continue;
            const [reserved] = await withTenant(database.db, scope, tx => tx.update(renders)
              .set({ nextDispatchAt: sql`clock_timestamp()+interval '1 minute'` })
              .where(and(eq(renders.id, render.id), due())).returning({ id: renders.id, requestedBy: renders.requestedBy }));
            if (!reserved) continue;
            await enqueue({ tenantId: scope.tenantId, requestedBy: reserved.requestedBy, renderId: reserved.id });
            delivered++;
          } catch {
            // A corrupt snapshot or unavailable transport must not starve other
            // tenants. Keep the original intent; never log decrypted options.
            process.stderr.write("Production render delivery unavailable; original intent retained\n");
          } finally { key?.fill(0); }
        }
        renderCursor = pending.at(-1)!.render.id;
      }
    }
    tenantCursor = tenants.at(-1)!.tenantId;
  }
  return delivered;
}

export class RedisProductionRenderDispatcher {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<number>;
  constructor(private readonly database: DatabaseConnection, private readonly vault: SecretVault, private readonly queue: Queue = createQueue(QueueName.ProductionEditorRender)) {}
  dispatch() {
    if (this.pending) return this.pending;
    const pending = dispatchApprovedProductionRenders(this.database, this.vault, async input => {
      const deliveryId = createEntityId();
      await enqueueJob(this.queue, "production-editor.render", { attempt: 0, correlationId: input.renderId, idempotencyKey: deliveryId, jobId: deliveryId, maxAttempts: 3,
        payload: { renderId: input.renderId }, requestedAt: new Date().toISOString(), requestedBy: input.requestedBy, tenantId: input.tenantId, traceId: createTraceId() }, { backoff: { type: "exponential", delay: 5000 } });
    });
    this.pending = pending;
    void pending.finally(() => { if (this.pending === pending) this.pending = undefined; }).catch(() => undefined);
    return pending;
  }
  start() {
    const tick = () => void this.dispatch().catch(() => process.stderr.write("Production render recovery unavailable\n"));
    if (this.timer) return;
    tick();
    this.timer = setInterval(tick, 15_000);
    this.timer.unref();
  }
  async close() { clearInterval(this.timer); await this.pending; await this.queue.close(); }
}
