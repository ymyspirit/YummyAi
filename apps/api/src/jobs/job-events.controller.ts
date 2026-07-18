import { Controller, Headers, Inject, Injectable, Req, Sse, type MessageEvent } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { jobProgressEvents, type DatabaseConnection, withTenant } from "@yummyai/database";
import { asc, eq } from "drizzle-orm";
import { Observable } from "rxjs";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { DATABASE_CONNECTION, JOB_EVENT_REPOSITORY } from "../platform.tokens.js";

export interface JobProgressEvent { id: string; jobId: string; state: "queued" | "running" | "completed" | "failed" | "cancelled"; progress: number; message?: string; occurredAt: string }
export interface JobEventRepository { listAfter(context: TenantContext, lastEventId?: string): Promise<JobProgressEvent[]>; }

@Controller()
export class JobEventsController {
  constructor(@Inject(JOB_EVENT_REPOSITORY) private readonly repository: JobEventRepository) {}
  @Sse("v1/job-events") @RequiresPermission(Permission.JobRead)
  stream(@Req() request: AuthenticatedRequest, @Headers("last-event-id") lastEventId?: string): Observable<MessageEvent> {
    const context = requireContext(request); authorize(context, Permission.JobRead);
    return createJobEventStream(this.repository, context, lastEventId);
  }
}

@Injectable()
export class DrizzleJobEventRepository implements JobEventRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection) {}
  async listAfter(context: TenantContext, lastEventId?: string) {
    const rows = await withTenant(this.database.db, context, (tx) => tx.select().from(jobProgressEvents).where(context.dataScope === "self" ? eq(jobProgressEvents.requestedBy, context.userId) : undefined).orderBy(asc(jobProgressEvents.occurredAt), asc(jobProgressEvents.id)).limit(2_000));
    const start = lastEventId ? rows.findIndex((row) => row.id === lastEventId) + 1 : 0;
    return rows.slice(Math.max(start, 0)).map((row) => ({ id: row.id, jobId: row.jobId, state: row.state as JobProgressEvent["state"], progress: row.progress, message: row.message ?? undefined, occurredAt: row.occurredAt.toISOString() }));
  }
}

export function createJobEventStream(repository: JobEventRepository, context: TenantContext, initialLastEventId?: string, timing: { pollMs?: number; heartbeatMs?: number } = {}) {
  return new Observable<MessageEvent>((subscriber) => {
    let lastEventId = initialLastEventId; let polling = false;
    const poll = async () => {
      if (polling) return; polling = true;
      try { const events = await repository.listAfter(context, lastEventId); for (const event of events) { lastEventId = event.id; subscriber.next({ id: event.id, type: "job-progress", data: event }); } }
      catch (error) { subscriber.error(error); }
      finally { polling = false; }
    };
    void poll();
    const pollTimer = setInterval(() => void poll(), timing.pollMs ?? 2_000);
    const heartbeatTimer = setInterval(() => subscriber.next({ type: "heartbeat", data: { occurredAt: new Date().toISOString() } }), timing.heartbeatMs ?? 20_000);
    return () => { clearInterval(pollTimer); clearInterval(heartbeatTimer); };
  });
}

function requireContext(request: AuthenticatedRequest) { if (!request.tenantContext) throw new Error("Tenant context is required"); return request.tenantContext; }
