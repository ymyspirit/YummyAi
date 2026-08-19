import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export interface ObservabilityContext {
  traceId: string;
  tenantId?: string;
  userId?: string;
  jobId?: string;
  correlationId?: string;
}

const contextStorage = new AsyncLocalStorage<Readonly<ObservabilityContext>>();

export function initializeOpenTelemetry(environment: NodeJS.ProcessEnv = process.env) {
  return Object.freeze({
    serviceName: environment.OTEL_SERVICE_NAME ?? "yummyai-api",
    serviceVersion: environment.APP_VERSION ?? "0.0.0",
    exporterEndpoint: environment.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318",
    environment: environment.APP_ENV ?? environment.NODE_ENV ?? "development",
    enabled: environment.OTEL_SDK_DISABLED !== "true",
  });
}

export function withObservabilityContext<T>(input: Omit<ObservabilityContext, "traceId"> & { traceId?: string }, callback: () => T): T {
  return contextStorage.run(Object.freeze({ ...input, traceId: normalizeTraceId(input.traceId) }), callback);
}

export function currentObservabilityContext(): Readonly<ObservabilityContext> | undefined { return contextStorage.getStore(); }

export function observabilityLogFields(overrides: Partial<ObservabilityContext> = {}) {
  const merged = { ...contextStorage.getStore(), ...overrides };
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined));
}

export function traceparent(traceId = currentObservabilityContext()?.traceId ?? newTraceId(), spanId = randomBytes(8).toString("hex")) { return `00-${normalizeTraceId(traceId)}-${spanId}-01`; }
function newTraceId() { return randomBytes(16).toString("hex"); }
function normalizeTraceId(value?: string) { return value && /^[a-f0-9]{32}$/i.test(value) ? value.toLowerCase() : newTraceId(); }
