import { performance } from "node:perf_hooks";
import { Queue, RedisConnection, type RedisClient, type RedisOptions } from "bullmq";
import {
  AGENT_RUNTIME_IO_TIMEOUT_MS, AGENT_RUNTIME_LEASE_MS, AGENT_RUNTIME_MAX_INSTANCES,
  AgentRuntimeObservationSchema, AgentRuntimePresenceReportSchema, AgentRuntimeQueueSchema,
  agentRuntimeWorkerName, type AgentRuntimeObservation, type AgentRuntimePresenceReport, type AgentRuntimeQueue,
} from "@yummyai/contracts/ai/agent-runtime-readiness";
import { redisConnection } from "./queue.js";

const namespace = "yummyai:agent-runtime-presence:v1:";
const unavailable = () => new Error("AGENT_RUNTIME_PRESENCE_UNAVAILABLE");
const nowLua = "local t=redis.call('TIME'); return tostring(tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000))";
const publishLua = `
local t=redis.call('TIME')
local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
if now>tonumber(ARGV[4]) or now<tonumber(ARGV[5]) or redis.call('EXISTS',KEYS[3])==1 then return 0 end
local age=tonumber(ARGV[6])+now-tonumber(ARGV[5])
if age>=${AGENT_RUNTIME_LEASE_MS} then return 0 end
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now)
if not redis.call('ZSCORE',KEYS[1],ARGV[1]) and redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[3]) then return 0 end
redis.call('SET',KEYS[2],tostring(now-age)..'\\n'..ARGV[2],'PX',${AGENT_RUNTIME_LEASE_MS}-age)
redis.call('ZADD',KEYS[1],now+${AGENT_RUNTIME_LEASE_MS}-age,ARGV[1])
redis.call('PEXPIRE',KEYS[1],${AGENT_RUNTIME_LEASE_MS})
return 1`;
const withdrawLua = `
redis.call('SET',KEYS[3],'withdrawn','PX',${AGENT_RUNTIME_LEASE_MS})
redis.call('DEL',KEYS[2])
redis.call('ZREM',KEYS[1],ARGV[1])
return 1`;
const inspectLua = `
local t=redis.call('TIME')
local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
local ids=redis.call('ZRANGEBYSCORE',KEYS[1],now+1,'+inf','LIMIT',0,${AGENT_RUNTIME_MAX_INSTANCES + 1})
if #ids>${AGENT_RUNTIME_MAX_INSTANCES} then return {tostring(now),'overflow'} end
local result={tostring(now)}
for _,id in ipairs(ids) do
  if #id~=36 then return {tostring(now),'invalid'} end
  local key=ARGV[1]..id
  local value=redis.call('GET',key)
  local ttl=redis.call('PTTL',key)
  if value and ttl>0 then
    table.insert(result,id)
    table.insert(result,value)
    table.insert(result,tostring(ttl))
  end
end
return result`;

function indexKey(queue: AgentRuntimeQueue) { return namespace + queue + ":index"; }
function recordPrefix(queue: AgentRuntimeQueue) { return namespace + queue + ":instance:"; }
function keys(queue: AgentRuntimeQueue, instanceId: string) {
  return [indexKey(queue), recordPrefix(queue) + instanceId, namespace + queue + ":withdrawn:" + instanceId];
}
function number(value: unknown): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw unavailable();
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw unavailable();
  return result;
}
function unknownObservation(): AgentRuntimeObservation {
  return { status: "unknown", checkedAt: new Date().toISOString(), queuePaused: null, connectedWorkerNames: [], observations: [] };
}

/** Ephemeral process evidence only. No job is read, dispatched, retried or paid. */
export class RedisAgentRuntimePresence {
  private readonly options: RedisOptions;
  private connection?: RedisConnection;
  private readonly queues = new Map<AgentRuntimeQueue, Queue>();
  private readonly prepared = new WeakSet<object>();
  private readonly owned = new Map<string, { instanceId: string; queue: AgentRuntimeQueue }>();
  private readonly sealed = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private closing?: Promise<void>;

  constructor(redisUrl?: string) {
    this.options = { ...(redisConnection(redisUrl) as RedisOptions), connectTimeout: AGENT_RUNTIME_IO_TIMEOUT_MS,
      commandTimeout: AGENT_RUNTIME_IO_TIMEOUT_MS, maxRetriesPerRequest: 1,
      enableOfflineQueue: false, autoResendUnfulfilledCommands: false };
  }

  private async client(): Promise<RedisClient> {
    if (!this.connection) {
      this.connection = new RedisConnection(this.options, { shared: false, blocking: false });
      this.connection.on("error", () => undefined);
    }
    const client = await this.connection.client;
    this.prepare(client);
    return client;
  }
  private prepare(client: RedisClient) {
    if (this.prepared.has(client)) return;
    client.defineCommand("yummyaiAgentRuntimeClock", { numberOfKeys: 0, lua: nowLua, readOnly: true });
    client.defineCommand("yummyaiAgentRuntimePublish", { numberOfKeys: 3, lua: publishLua });
    client.defineCommand("yummyaiAgentRuntimeWithdraw", { numberOfKeys: 3, lua: withdrawLua });
    client.defineCommand("yummyaiAgentRuntimeInspect", { numberOfKeys: 1, lua: inspectLua, readOnly: true });
    this.prepared.add(client);
  }
  private queue(name: AgentRuntimeQueue) {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.options, skipMetasUpdate: true });
      queue.on("error", () => undefined);
      this.queues.set(name, queue);
    }
    return queue;
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(operation);
    this.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }
  private async bounded<T>(operation: (check: () => void) => Promise<T>): Promise<T> {
    let expired = false;
    const check = () => { if (expired) throw unavailable(); };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(() => operation(check)), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { expired = true; reject(unavailable()); }, AGENT_RUNTIME_IO_TIMEOUT_MS);
        timer.unref();
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  publish(raw: AgentRuntimePresenceReport): Promise<void> {
    const began = performance.now();
    const report = AgentRuntimePresenceReportSchema.parse(raw), pair = report.queue + "/" + report.instanceId;
    if (this.closed || this.sealed.has(pair)) return Promise.reject(unavailable());
    this.owned.set(pair, { instanceId: report.instanceId, queue: report.queue });
    return this.bounded(check => this.serial(async () => {
      check();
      if (this.closed || this.sealed.has(pair)) throw unavailable();
      const client = await this.client(); check();
      const time: unknown = await client.runCommand("yummyaiAgentRuntimeClock", []); check();
      if (this.closed || this.sealed.has(pair)) throw unavailable();
      // The server rejects a delayed mutation after its bounded dispatch window.
      // Together with the withdrawal tombstone this fences an uncertain old write.
      const result: unknown = await client.runCommand("yummyaiAgentRuntimePublish", [
        ...keys(report.queue, report.instanceId), report.instanceId, JSON.stringify(report),
        AGENT_RUNTIME_MAX_INSTANCES, number(time) + AGENT_RUNTIME_IO_TIMEOUT_MS,
        number(time), Math.ceil(performance.now() - began),
      ]);
      check(); if (result !== 1) throw unavailable();
    }));
  }

  withdraw(instanceId: string, rawQueue: AgentRuntimeQueue): Promise<void> {
    const queue = AgentRuntimeQueueSchema.parse(rawQueue);
    agentRuntimeWorkerName(instanceId);
    const pair = queue + "/" + instanceId;
    this.sealed.add(pair);
    if (this.closed) return this.closing ?? Promise.resolve();
    return this.remove(instanceId, queue);
  }
  private remove(instanceId: string, queue: AgentRuntimeQueue): Promise<void> {
    return this.bounded(check => this.serial(async () => {
      check(); const client = await this.client(); check();
      await client.runCommand("yummyaiAgentRuntimeWithdraw", [...keys(queue, instanceId), instanceId]);
      check();
    }));
  }

  async inspect(rawQueue: AgentRuntimeQueue): Promise<AgentRuntimeObservation> {
    const queueName = AgentRuntimeQueueSchema.parse(rawQueue);
    if (this.closed) return unknownObservation();
    try {
      return await this.bounded(async check => {
        check(); if (this.closed) throw unavailable();
        const began = performance.now(), queue = this.queue(queueName);
        const [workers, queuePaused, client] = await Promise.all([queue.getWorkers(), queue.isPaused(), queue.client]);
        check(); if (this.closed) throw unavailable(); this.prepare(client);
        const raw: unknown = await client.runCommand("yummyaiAgentRuntimeInspect", [indexKey(queueName), recordPrefix(queueName)]);
        check(); if (this.closed || !Array.isArray(raw) || (raw.length - 1) % 3 !== 0) throw unavailable();
        const checkedAt = number(raw[0]);
        const names = new Set<string>();
        for (const worker of workers) {
          // BullMQ replaces `name` with the queue name; `rawname` retains SETNAME.
          if (typeof worker.rawname !== "string") throw unavailable();
          const suffix = worker.rawname.split(":w:");
          if (suffix.length !== 2 || !suffix[1]!.startsWith("yummyai-agent-runtime-")) continue;
          const name = suffix[1]!, instanceId = name.slice("yummyai-agent-runtime-".length);
          if (agentRuntimeWorkerName(instanceId) !== name) throw unavailable();
          names.add(name);
        }
        if (names.size > AGENT_RUNTIME_MAX_INSTANCES) throw unavailable();
        const elapsed = Math.ceil(performance.now() - began);
        const observations: AgentRuntimeObservation["observations"] = [];
        for (let i = 1; i < raw.length; i += 3) {
          const instanceId = raw[i], stored = raw[i + 1];
          if (typeof instanceId !== "string" || typeof stored !== "string" || stored.length > 8192) throw unavailable();
          const separator = stored.indexOf("\n");
          if (separator < 1) throw unavailable();
          const observedAt = number(stored.slice(0, separator));
          const report = AgentRuntimePresenceReportSchema.parse(JSON.parse(stored.slice(separator + 1)) as unknown);
          if (report.instanceId !== instanceId || report.queue !== queueName) throw unavailable();
          const expiresInMs = number(raw[i + 2]) - elapsed, observedAgeMs = checkedAt - observedAt + elapsed;
          if (expiresInMs <= 0 || observedAgeMs > AGENT_RUNTIME_LEASE_MS) continue;
          observations.push({ report, expiresInMs, observedAgeMs });
        }
        return AgentRuntimeObservationSchema.parse({ status: "known", checkedAt: new Date(checkedAt).toISOString(), queuePaused,
          connectedWorkerNames: [...names].sort(), observations });
      });
    } catch { return unknownObservation(); }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const pair of this.owned.keys()) this.sealed.add(pair);
    this.closing = (async () => {
      try { await Promise.allSettled([...this.owned.values()].map(({ instanceId, queue }) => this.remove(instanceId, queue))); }
      finally {
        await Promise.allSettled([...this.queues.values()].map(queue => this.bounded(async () => { await queue.disconnect(); await queue.close(); })));
        if (this.connection) await this.bounded(async () => { await this.connection!.close(true); }).catch(() => undefined);
      }
    })();
    return this.closing;
  }
}
