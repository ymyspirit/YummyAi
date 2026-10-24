import { performance } from "node:perf_hooks";
import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { authorize, erpPermissionContext, ForbiddenError, intersectPermissionContexts, Permission } from "@yummyai/authz";
import { TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { AgentReadinessFamilySchema, type AgentReadinessFamily } from "@yummyai/contracts/ai/agent-readiness";
import {
  AGENT_RUNTIME_DISPATCH_FRESH_MS, AGENT_RUNTIME_FAMILIES, AGENT_RUNTIME_MAX_VALID_MS,
  AGENT_RUNTIME_PRESENCE_VERSION, AGENT_RUNTIME_READINESS_VERSION,
  AgentRuntimeObservationSchema, AgentRuntimeReadinessSchema,
  type AgentRuntimeObservation, type AgentRuntimeReadiness,
} from "@yummyai/contracts/ai/agent-runtime-readiness";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { loadCurrentMembershipContext, withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import type { RedisAgentRuntimePresence } from "@yummyai/jobs";
import { sql } from "drizzle-orm";
import { DATABASE_CONNECTION } from "../platform.tokens.js";

export const AGENT_RUNTIME_PRESENCE_READER = Symbol("AGENT_RUNTIME_PRESENCE_READER");
const stamp = (context: TenantContext) => erpSessionAuthority(erpPermissionContext(context));

/** Short-lived transport observations; durable task admission remains its owner. */
@Injectable()
export class AgentRuntimeReadinessService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AGENT_RUNTIME_PRESENCE_READER) private readonly presence: Pick<RedisAgentRuntimePresence, "inspect">,
  ) {}

  private async current(tx: TenantTransaction, ceiling: TenantContext) {
    const current = TenantContextSchema.parse(intersectPermissionContexts(
      ceiling, await loadCurrentMembershipContext(tx, ceiling, { lock: true }),
    ));
    authorize(current, Permission.WorkflowRead, { ownerId: ceiling.userId });
    return current;
  }

  async get(context: TenantContext, family: AgentReadinessFamily): Promise<AgentRuntimeReadiness> {
    const parsed = AgentReadinessFamilySchema.safeParse(family);
    if (!parsed.success) throw new BadRequestException({ code: "agent_runtime_readiness_input_invalid" });
    family = parsed.data;
    const initial = await withTenant(this.database.db, context, tx => this.current(tx, context));
    const authority = stamp(initial);
    let canRun = false;
    try { authorize(initial, Permission.WorkflowRun, { ownerId: initial.userId }); canRun = true; }
    catch (error) { if (!(error instanceof ForbiddenError)) throw error; }

    const inspectionStarted = performance.now();
    let observation: AgentRuntimeObservation | undefined;
    if (canRun) {
      try { observation = AgentRuntimeObservationSchema.parse(await this.presence.inspect(AGENT_RUNTIME_FAMILIES[family].queue)); }
      catch { /* Malformed, unavailable or late transport proof grants nothing. */ }
    }
    // Never retain the initial membership transaction while awaiting Redis.
    const checkedAt = await withTenant(this.database.db, context, async tx => {
      if (stamp(await this.current(tx, context)) !== authority) throw new ConflictException({ code: "authority_changed" });
      const [clock] = await tx.execute<{ checkedAt: Date | string }>(sql`select clock_timestamp() as "checkedAt"`);
      if (!clock) throw new Error("agent_runtime_readiness_clock_unavailable");
      return new Date(clock.checkedAt).toISOString();
    });
    const common = {
      version: AGENT_RUNTIME_READINESS_VERSION, family, contextAuthority: authority,
      presenceVersion: AGENT_RUNTIME_PRESENCE_VERSION, executorVersion: AGENT_RUNTIME_FAMILIES[family].executorVersion,
      checkedAt, validUntil: checkedAt, validForMs: 0, metadataOnly: true, advisoryOnly: true,
      notChecked: ["request_budget", "selected_sources", "provider_connection", "business_admission"],
      effects: { modelCalls: 0, queueDispatches: 0, budgetReservations: 0, businessWrites: 0 },
    } as const;
    if (!canRun) return AgentRuntimeReadinessSchema.parse({ ...common, state: "not_checked",
      checks: { consumer: "not_checked", dispatcher: "not_checked", queue: "not_checked" }, reasons: ["workflow_run_permission_missing"] });
    if (!observation || observation.status === "unknown") return AgentRuntimeReadinessSchema.parse({ ...common, state: "unknown",
      checks: { consumer: "unknown", dispatcher: "unknown", queue: "unknown" }, reasons: ["runtime_observation_unknown"] });

    // Deduct the complete inspection + fresh-membership roundtrip conservatively.
    const elapsed = Math.max(0, Math.ceil(performance.now() - inspectionStarted));
    const protocol = AGENT_RUNTIME_FAMILIES[family];
    const rows = observation.observations.filter(row => row.report.queue === protocol.queue && row.expiresInMs > elapsed);
    const compatible = rows.filter(row => row.report.executorVersions.includes(protocol.executorVersion));
    const scored = compatible.map(row => {
      const { report } = row, remaining = row.expiresInMs - elapsed;
      const phaseReady = report.lifecycle === "ready";
      const consumer = phaseReady && report.consumer.running && !report.consumer.paused
        && report.consumer.normalConnection === "ready" && report.consumer.blockingConnection === "ready"
        && observation.connectedWorkerNames.includes(report.workerName);
      const dispatchRemaining = report.dispatcher.lastSuccessAgeMs === null ? 0
        : AGENT_RUNTIME_DISPATCH_FRESH_MS - report.dispatcher.lastSuccessAgeMs - row.observedAgeMs - elapsed;
      const dispatcher = phaseReady && report.dispatcher.name === protocol.scheduler && report.dispatcher.started
        && !report.dispatcher.closing && !report.dispatcher.currentFailure && dispatchRemaining > 0;
      return { consumer, dispatcher, validity: Math.max(0, Math.min(AGENT_RUNTIME_MAX_VALID_MS, remaining, dispatchRemaining)),
        score: Number(consumer) + Number(dispatcher) };
    }).sort((a, b) => b.score - a.score || b.validity - a.validity);
    // A consumer from instance A and dispatcher from B must never form readiness.
    const best = scored[0], queuePaused = observation.queuePaused === true;
    const ready = !!best?.consumer && best.dispatcher && best.validity > 0 && !queuePaused;
    const reasons: AgentRuntimeReadiness["reasons"] = [];
    if (!rows.length) reasons.push("runtime_not_observed");
    else if (!compatible.length) reasons.push("runtime_protocol_unavailable");
    if (!best?.consumer) reasons.push("consumer_unavailable");
    if (!best?.dispatcher) reasons.push("dispatcher_unavailable");
    if (queuePaused) reasons.push("queue_paused");
    const validForMs = ready ? best.validity : 0;
    return AgentRuntimeReadinessSchema.parse({ ...common, state: ready ? "observed_ready" : "unavailable", validForMs,
      validUntil: new Date(Date.parse(checkedAt) + validForMs).toISOString(),
      checks: { consumer: best?.consumer ? "ready" : "unavailable", dispatcher: best?.dispatcher ? "ready" : "unavailable", queue: queuePaused ? "paused" : "open" }, reasons });
  }
}
