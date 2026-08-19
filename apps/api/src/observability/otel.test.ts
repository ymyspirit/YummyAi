import { describe, expect, it } from "vitest";
import { currentObservabilityContext, initializeOpenTelemetry, observabilityLogFields, traceparent, withObservabilityContext } from "./otel.js";

describe("observability context", () => {
  it("correlates request and job fields without leaking between async flows", async () => {
    const traceId = "a".repeat(32);
    await withObservabilityContext({ traceId, tenantId: "tenant-a", userId: "user-a", jobId: "job-a", correlationId: "correlation-a" }, async () => {
      await Promise.resolve(); expect(currentObservabilityContext()).toMatchObject({ traceId, tenantId: "tenant-a", jobId: "job-a" });
      expect(observabilityLogFields()).toEqual({ traceId, tenantId: "tenant-a", userId: "user-a", jobId: "job-a", correlationId: "correlation-a" });
      expect(traceparent()).toMatch(/^00-a{32}-[a-f0-9]{16}-01$/);
    });
    expect(currentObservabilityContext()).toBeUndefined();
  });
  it("exposes deterministic exporter configuration", () => { expect(initializeOpenTelemetry({ OTEL_SERVICE_NAME: "api", OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel:4318" })).toMatchObject({ serviceName: "api", exporterEndpoint: "http://otel:4318", enabled: true }); });
});
