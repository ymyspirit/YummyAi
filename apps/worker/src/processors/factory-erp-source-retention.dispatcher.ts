import {
  claimFactoryErpSourcePurges,
  factoryErpRetentionContext,
  failFactoryErpSourcePurge,
  finishFactoryErpSourcePurge,
  organizations,
  redactExpiredFactoryErpSources,
  withTenant,
  type DatabaseConnection,
  type FactoryErpPurgeTicket,
} from "@yummyai/database";
import type { FactoryErpSourcePurger } from "@yummyai/storage";
import { asc } from "drizzle-orm";
import type { RetentionBatch } from "./input-retention-scheduler.js";

export type FactoryErpRetentionBatch = RetentionBatch & {
  claimed: number;
  purged: number;
  deletedVersions: number;
  leaseLost: number;
};
export type FactoryErpPurgeStorage = Pick<FactoryErpSourcePurger, "purge" | "close">;
const empty = (): FactoryErpRetentionBatch => ({ tenants: 0, redacted: 0, failures: 0,
  claimed: 0, purged: 0, deletedVersions: 0, leaseLost: 0 });

/** Database leases own work; network operations never hold a tenant transaction. */
export class FactoryErpSourceRetentionDispatcher {
  private stopping = false;
  private closed = false;
  private pending?: Promise<FactoryErpRetentionBatch>;
  private readonly active = new Map<AbortController, Promise<void>>();
  private readonly perTenant: number;
  private readonly leaseMs: number;
  private readonly purgeTimeoutMs: number;

  constructor(private readonly database: DatabaseConnection, private readonly storage: FactoryErpPurgeStorage,
    options: { perTenant?: number; leaseMs?: number; purgeTimeoutMs?: number } = {}) {
    this.perTenant = options.perTenant ?? 5;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.purgeTimeoutMs = options.purgeTimeoutMs ?? 20_000;
    if (!Number.isSafeInteger(this.perTenant) || this.perTenant < 1 || this.perTenant > 25 ||
        !Number.isSafeInteger(this.leaseMs) || this.leaseMs < 60_000 || this.leaseMs > 300_000 ||
        !Number.isSafeInteger(this.purgeTimeoutMs) || this.purgeTimeoutMs < 1 || this.purgeTimeoutMs > 20_000)
      throw new RangeError("Invalid factory ERP retention limits");
  }

  dispatch(): Promise<FactoryErpRetentionBatch> {
    if (this.stopping) return Promise.resolve(empty());
    if (this.pending) return this.pending;
    const work = this.cycle();
    this.pending = work;
    void work.finally(() => { if (this.pending === work) this.pending = undefined; }).catch(() => undefined);
    return work;
  }

  async stop() {
    // Mark terminal before any await so timer ticks cannot acquire more work.
    this.stopping = true;
    for (const controller of this.active.keys()) controller.abort();
    try {
      if (this.pending) await this.pending.catch(() => undefined);
      await Promise.allSettled([...this.active.values()]);
    } finally {
      if (!this.closed) { this.closed = true; this.storage.close(); }
    }
  }

  private async cycle() {
    const result = empty();
    let tenants: Array<{ id: string }>;
    try { tenants = await this.database.db.select({ id: organizations.id }).from(organizations).orderBy(asc(organizations.id)); }
    catch { result.failures++; return result; }
    for (const tenant of tenants) {
      if (this.stopping) break;
      const context = factoryErpRetentionContext(tenant.id);
      let tickets: FactoryErpPurgeTicket[];
      try {
        const claimed = await withTenant(this.database.db, context, async tx => {
          const redacted = await redactExpiredFactoryErpSources(tx);
          const tickets = await claimFactoryErpSourcePurges(tx, { limit: this.perTenant, leaseMs: this.leaseMs });
          return { redacted, tickets };
        });
        result.tenants++; result.redacted += claimed.redacted;
        tickets = claimed.tickets; result.claimed += tickets.length;
      } catch { result.failures++; continue; }
      // All tickets start together: five sequential 20s requests could outlive a
      // 60s lease before the final ticket even begins its storage operation.
      await Promise.all(tickets.map(ticket => this.process(ticket, result)));
    }
    return result;
  }

  private async process(ticket: FactoryErpPurgeTicket, result: FactoryErpRetentionBatch) {
    const context = factoryErpRetentionContext(ticket.tenantId);
    if (this.stopping) {
      await this.defer(ticket, "storage_delete_failed", result);
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.purgeTimeoutMs);
    const operation = (async () => {
      let proof: Awaited<ReturnType<FactoryErpSourcePurger["purge"]>>;
      try { proof = await this.storage.purge(ticket, { signal: controller.signal }); }
      catch (error) {
        const code = error && typeof error === "object" && "code" in error && error.code === "absence_unconfirmed"
          ? "absence_unconfirmed" : "storage_delete_failed";
        await this.defer(ticket, code, result);
        return;
      }
      try {
        // No synthesized success on a lost commit response. The same token is
        // idempotent, or a later lease verifies the already absent bytes again.
        await withTenant(this.database.db, context, tx => finishFactoryErpSourcePurge(tx, ticket, proof));
        result.purged++; result.deletedVersions += proof.deletedVersions;
      } catch { result.failures++; result.leaseLost++; }
    })();
    this.active.set(controller, operation);
    try { await operation; }
    finally { clearTimeout(timeout); this.active.delete(controller); }
  }

  private async defer(ticket: FactoryErpPurgeTicket, code: "storage_delete_failed" | "absence_unconfirmed", result: FactoryErpRetentionBatch) {
    result.failures++;
    try {
      const retained = await withTenant(this.database.db, factoryErpRetentionContext(ticket.tenantId),
        tx => failFactoryErpSourcePurge(tx, ticket, code));
      if (!retained) result.leaseLost++;
    } catch { result.leaseLost++; }
  }
}
