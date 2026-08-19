import { z } from "zod";
import { describe, expect, it } from "vitest";

import { BudgetExceededError, InMemoryBudgetLedger, type BudgetPolicySource } from "./budget.js";
import {
  ModelExecutionCancelledError,
  type ModelProvider,
  type ModelResult,
  ProviderError,
  type ResolvedModelRequest,
} from "./provider.js";
import { ModelRouter, type ModelRouteResolver } from "./router.js";

const outputSchema = z.object({ answer: z.string() });
const context = { tenantId: "0198fbef-4a10-7000-8000-000000000001", userId: "0198fbef-4a10-7000-8000-000000000002" };
const request = {
  modelKey: "copywriter.fast",
  taskType: "listing-copy",
  systemInstructions: "Return evidence-backed copy.",
  untrustedSourceData: { title: "Example" },
  outputSchema,
  maxCostUsd: 1,
};

describe("ModelRouter", () => {
  it("returns the primary provider result", async () => {
    const primary = provider("primary", async (input) => result(input, "primary"));
    const fallback = provider("fallback", async (input) => result(input, "fallback"));

    await expect(router([primary, fallback]).execute(context, request)).resolves.toMatchObject({ providerId: "primary" });
    expect(fallback.generateCalls).toBe(0);
  });

  it("falls back after a retryable provider failure", async () => {
    const primary = provider("primary", async () => {
      throw new ProviderError("upstream unavailable", "primary", true, 503);
    });
    const fallback = provider("fallback", async (input) => result(input, "fallback"));

    await expect(router([primary, fallback]).execute(context, request)).resolves.toMatchObject({ providerId: "fallback" });
    expect(primary.generateCalls).toBe(1);
    expect(fallback.generateCalls).toBe(1);
  });

  it("falls back when the primary provider times out", async () => {
    const primary = provider("primary", (_, signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const fallback = provider("fallback", async (input) => result(input, "fallback"));

    await expect(router([primary, fallback], 5).execute(context, request)).resolves.toMatchObject({ providerId: "fallback" });
  });

  it("does not fall back after a non-retryable provider error", async () => {
    const primary = provider("primary", async () => {
      throw new ProviderError("invalid request", "primary", false, 400);
    });
    const fallback = provider("fallback", async (input) => result(input, "fallback"));

    await expect(router([primary, fallback]).execute(context, request)).rejects.toMatchObject({ statusCode: 400 });
    expect(fallback.generateCalls).toBe(0);
  });

  it("rejects a request cap before calling any provider", async () => {
    const primary = provider("primary", async (input) => result(input, "primary"));

    await expect(router([primary]).execute(context, { ...request, maxCostUsd: 0.001 })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(primary.generateCalls).toBe(0);
  });

  it("rejects a tenant task cap before calling any provider", async () => {
    const primary = provider("primary", async (input) => result(input, "primary"));

    await expect(router([primary], 100, 0.001).execute(context, request)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(primary.generateCalls).toBe(0);
  });

  it("cancels without invoking a fallback", async () => {
    const primary = provider("primary", (_, signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const fallback = provider("fallback", async (input) => result(input, "fallback"));
    const controller = new AbortController();
    const pending = router([primary, fallback], 1_000).execute(context, request, controller.signal);
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(ModelExecutionCancelledError);
    expect(fallback.generateCalls).toBe(0);
  });
});

function router(providers: ModelProvider[], timeoutMs = 100, taskCapUsd = 10): ModelRouter {
  const routes: ModelRouteResolver = {
    resolve: async () => providers.map((item) => ({ providerId: item.providerId, providerModel: `${item.providerId}-model`, timeoutMs })),
  };
  const policies: BudgetPolicySource = {
    getPolicy: async () => ({ monthlyCapUsd: 100, defaultTaskCapUsd: taskCapUsd }),
  };
  return new ModelRouter(providers, routes, new InMemoryBudgetLedger(policies));
}

function provider(
  providerId: string,
  implementation: (request: ResolvedModelRequest<unknown>, signal: AbortSignal) => Promise<ModelResult<unknown>>,
): FakeProvider {
  return new FakeProvider(providerId, implementation);
}

function result<T>(request: ResolvedModelRequest<T>, providerId: string): ModelResult<T> {
  return {
    providerId,
    modelKey: request.modelKey,
    value: request.outputSchema.parse({ answer: providerId }),
    costUsd: 0.005,
    inputTokens: 10,
    outputTokens: 5,
    completedAt: new Date(),
  };
}

class FakeProvider implements ModelProvider {
  generateCalls = 0;

  constructor(
    readonly providerId: string,
    private readonly implementation: (
      request: ResolvedModelRequest<unknown>,
      signal: AbortSignal,
    ) => Promise<ModelResult<unknown>>,
  ) {}

  estimate = async () => ({ costUsd: 0.01, estimatedInputTokens: 10, maxOutputTokens: 10 });

  async generate<T>(request: ResolvedModelRequest<T>, signal: AbortSignal): Promise<ModelResult<T>> {
    this.generateCalls += 1;
    return this.implementation(request as ResolvedModelRequest<unknown>, signal) as Promise<ModelResult<T>>;
  }

  healthCheck = async () => ({ available: true, checkedAt: new Date() });
}
