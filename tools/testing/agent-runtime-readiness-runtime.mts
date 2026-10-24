import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AgentRuntimeQueueSchema, type AgentRuntimeQueue } from "../../packages/contracts/src/ai/agent-runtime-readiness.js";
import { requireAgentRuntimeReadinessEnvironment } from "./require-agent-runtime-readiness-environment.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const queueNames = new Set(AgentRuntimeQueueSchema.options);
const schedulerNames = new Set(["agentLoopScheduler", "agentPlanScheduler"]);
const ownedProxies = new WeakSet<object>();
type LifecycleState = "starting" | "ready" | "stopping" | "stopped" | "error";
type Lifecycle = { type: "worker.lifecycle"; state: LifecycleState; queues: string[]; schedulers: string[]; code?: string; clean?: boolean };
type JobEvent = { type: "worker.job"; queue: AgentRuntimeQueue; state: "completed" | "failed"; jobId: string | null };
export type RuntimeWorkerEvidence = {
  pid: number | null; lifecycle: Lifecycle[]; jobs: JobEvent[]; stdoutBytes: number; stderrBytes: number;
  stdoutSha256: string; stderrSha256: string; stderrCodes: string[]; processExited: boolean;
  exitCode: number | null; exitSignal: string | null; forced: boolean; privateEnvironmentLeaked: boolean;
};
export type AgentRuntimeRedisProxy = Awaited<ReturnType<typeof openAgentRuntimeRedisProxy>>;

export async function waitForAgentRuntime<T>(read: () => T | Promise<T>, code: string, timeoutMs = 20_000): Promise<NonNullable<T>> {
  const until = performance.now() + timeoutMs;
  do {
    const result = await read(); if (result) return result as NonNullable<T>;
    await new Promise(done => setTimeout(done, 40));
  } while (performance.now() < until);
  throw new Error(code);
}
async function within<T>(promise: Promise<T>, code: string, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(code)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

/** Actual loopback transport fault only. It forwards the exact disposable Redis
 * byte stream and never substitutes a Worker, presence report or Redis reply. */
export async function openAgentRuntimeRedisProxy() {
  const environment = requireAgentRuntimeReadinessEnvironment(), target = new URL(process.env.REDIS_URL!);
  const sockets = new Set<Socket>(); let cut = false, closed = false;
  const server = createServer(socket => {
    if (cut || closed) { socket.destroy(); return; }
    const remote = connect(Number(target.port || 6379), target.hostname); sockets.add(socket); sockets.add(remote);
    const release = () => { socket.destroy(); remote.destroy(); sockets.delete(socket); sockets.delete(remote); };
    socket.on("error", release); remote.on("error", release); socket.on("close", release); remote.on("close", release);
    socket.pipe(remote); remote.pipe(socket);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("runtime_proxy_address_invalid");
  const endpoint = new URL(target); endpoint.hostname = "127.0.0.1"; endpoint.port = String(address.port);
  const result = { nonce: environment.nonce, url: endpoint.href, port: address.port,
    cut() { cut = true; for (const socket of sockets) socket.destroy(); },
    async close() {
      if (closed) return; closed = true; cut = true; for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>((done, reject) => server.close(error => error ? reject(new Error("runtime_proxy_close_failed")) : done()));
      ownedProxies.delete(result);
    },
  };
  ownedProxies.add(result); return result;
}

/** Imports have no resource side effects. Each child runs the original standard
 * entry point with only the two explicitly selected Harness consumers. */
export async function openAgentRuntimeWorker(input: {
  queues?: readonly AgentRuntimeQueue[]; schedulers?: readonly ("agentLoopScheduler" | "agentPlanScheduler")[];
  proxy?: AgentRuntimeRedisProxy;
} = {}) {
  const isolated = requireAgentRuntimeReadinessEnvironment();
  const queues = input.queues ?? ["agent-loop", "agent-plan"], schedulers = input.schedulers ?? queues.map(queue => queue === "agent-loop" ? "agentLoopScheduler" as const : "agentPlanScheduler" as const);
  if (!queues.length || new Set(queues).size !== queues.length || queues.some(queue => !queueNames.has(queue))
    || new Set(schedulers).size !== schedulers.length || schedulers.some(name => !schedulerNames.has(name) || !queues.includes(name === "agentLoopScheduler" ? "agent-loop" : "agent-plan")))
    throw new Error("runtime_worker_selection_invalid");
  if (input.proxy && (!ownedProxies.has(input.proxy) || input.proxy.nonce !== isolated.nonce)) throw new Error("runtime_proxy_not_owned");
  const temp = resolve(isolated.lane, "qa", isolated.nonce, "worker-" + randomUUID()); await mkdir(temp, { recursive: true });
  const environment: Record<string, string> = { NODE_ENV: "production", TSX_DISABLE_CACHE: "1", TEMP: temp, TMP: temp,
    DATABASE_URL: isolated.url, REDIS_URL: input.proxy?.url ?? process.env.REDIS_URL!, WORKER_QUEUES: queues.join(","),
    WORKER_SCHEDULERS: schedulers.length ? schedulers.join(",") : "none", WORKER_STARTUP_TIMEOUT_MS: "10000", WORKER_SHUTDOWN_TIMEOUT_MS: "10000" };
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_PRIVATE_BUCKET"])
    if (process.env[name]) environment[name] = process.env[name]!;
  for (const [index, name] of ["MODEL_CREDENTIAL_ENCRYPTION_KEY", "INTEGRATION_SECRET_ENCRYPTION_KEY", "ORDER_PII_ENCRYPTION_KEY"].entries())
    environment[name] = Buffer.alloc(32, 100 + index).toString("base64url");
  const child = spawn(process.execPath, ["--import", pathToFileURL(resolve(root, "apps/api/node_modules/tsx/dist/loader.mjs")).href,
    resolve(root, "apps/worker/src/run.ts")], { cwd: root, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const evidence: RuntimeWorkerEvidence = { pid: child.pid ?? null, lifecycle: [], jobs: [], stdoutBytes: 0, stderrBytes: 0, stdoutSha256: "", stderrSha256: "",
    stderrCodes: [], processExited: false, exitCode: null, exitSignal: null, forced: false, privateEnvironmentLeaked: false };
  const stdoutHash = createHash("sha256"), stderrHash = createHash("sha256"), codes = new Set<string>();
  const secrets = [environment.S3_SECRET_ACCESS_KEY, ...Object.entries(environment).filter(([key]) => key.endsWith("_ENCRYPTION_KEY")).map(([, value]) => value)].filter((value): value is string => !!value);
  let stdoutTail = "", stderrTail = "", spawnFailed = false;
  function accept(message: unknown) {
    if (!message || typeof message !== "object") return;
    const value = message as Record<string, unknown>;
    if (value.type === "worker.lifecycle" && ["starting", "ready", "stopping", "stopped", "error"].includes(String(value.state))
      && Array.isArray(value.queues) && value.queues.every(queue => queueNames.has(queue)) && Array.isArray(value.schedulers)
      && value.schedulers.every(name => schedulerNames.has(name))) {
      if (evidence.lifecycle.length < 100) evidence.lifecycle.push({ type: "worker.lifecycle", state: value.state as LifecycleState,
        queues: value.queues as string[], schedulers: value.schedulers as string[],
        ...(typeof value.code === "string" && /^(?:WORKER_[A-Z_]+|signal|parent_shutdown|shutdown|consumer_failed|startup_failed)$/.test(value.code) ? { code: value.code } : {}),
        ...(typeof value.clean === "boolean" ? { clean: value.clean } : {}) });
    } else if (value.type === "worker.job" && queueNames.has(value.queue as AgentRuntimeQueue) && ["completed", "failed"].includes(String(value.state))
      && (value.jobId === null || typeof value.jobId === "string" && /^[0-9a-f-]{36}$/i.test(value.jobId))) {
      if (evidence.jobs.length < 100) evidence.jobs.push({ type: "worker.job", queue: value.queue as AgentRuntimeQueue, state: value.state as JobEvent["state"], jobId: value.jobId as string | null });
    }
  }
  child.on("message", accept);
  child.stdout?.on("data", (chunk: Buffer) => {
    evidence.stdoutBytes += chunk.byteLength; stdoutHash.update(chunk); const text = stdoutTail + chunk.toString("utf8");
    evidence.privateEnvironmentLeaked ||= secrets.some(secret => text.includes(secret));
    const lines = text.split(/\r?\n/); stdoutTail = (lines.pop() ?? "").slice(-8192);
    for (const line of lines) if (line.length <= 8192) { try { const parsed: unknown = JSON.parse(line); if (parsed && typeof parsed === "object" && "type" in parsed && parsed.type === "worker.job") accept(parsed); } catch { /* Raw stdout never enters proof. */ } }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    evidence.stderrBytes += chunk.byteLength; stderrHash.update(chunk); const text = stderrTail + chunk.toString("utf8");
    evidence.privateEnvironmentLeaked ||= secrets.some(secret => text.includes(secret));
    const lines = text.split(/\r?\n/); stderrTail = (lines.pop() ?? "").slice(-8192);
    for (const line of lines) if (/^(?:WORKER_[A-Z_]+|Agent (?:loop|plan) dispatch unavailable|Queue transport unavailable)$/.test(line)) codes.add(line);
  });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveDone => {
    child.once("error", () => { spawnFailed = true; });
    child.once("close", (code, signal) => {
      evidence.processExited = true; evidence.exitCode = code; evidence.exitSignal = signal;
      evidence.stdoutSha256 = stdoutHash.digest("hex"); evidence.stderrSha256 = stderrHash.digest("hex"); evidence.stderrCodes = [...codes];
      stdoutTail = ""; stderrTail = ""; resolveDone({ code, signal });
    });
  });
  async function ready() {
    return waitForAgentRuntime(() => {
      if (spawnFailed || evidence.processExited) throw new Error("runtime_standard_worker_exited_before_ready");
      return evidence.lifecycle.find(event => event.state === "ready");
    }, "runtime_standard_worker_ready_deadline", 20_000);
  }
  async function stop(mode: "graceful" | "kill" = "graceful") {
    if (!evidence.processExited) {
      if (mode === "graceful" && child.connected) child.send({ type: "worker.shutdown" }, () => undefined);
      else { evidence.forced = true; child.kill("SIGKILL"); }
    }
    const value = await within(done, "runtime_standard_worker_close_deadline", 15_000);
    if (evidence.privateEnvironmentLeaked) throw new Error("runtime_standard_worker_secret_leaked");
    return value;
  }
  return { child: child as ChildProcess, evidence, done, ready, stop };
}
