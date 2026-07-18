import type { TenantContext } from "@yummyai/contracts";

import type { BudgetLedger } from "./budget.js";
import {
  ModelExecutionCancelledError,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
  ProviderTimeoutError,
  isRetryableProviderError,
} from "./provider.js";

export interface ModelRouteTarget {
  providerId: string;
  providerModel: string;
  timeoutMs: number;
}

export interface ModelRouteResolver {
  resolve(tenantId: string, modelKey: string, taskType: string): Promise<readonly ModelRouteTarget[]>;
}

export class ModelRouteNotFoundError extends Error {
  constructor(modelKey: string) {
    super(`No enabled provider route exists for model key ${modelKey}`);
    this.name = "ModelRouteNotFoundError";
  }
}

export class ModelRouter {
  private readonly providers: ReadonlyMap<string, ModelProvider>;

  constructor(
    providers: readonly ModelProvider[],
    private readonly routes: ModelRouteResolver,
    private readonly budgets: BudgetLedger,
  ) {
    this.providers = new Map(providers.map((provider) => [provider.providerId, provider]));
  }

  async execute<T>(
    context: Pick<TenantContext, "tenantId" | "userId">,
    request: ModelRequest<T>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ModelResult<T>> {
    if (signal.aborted) throw new ModelExecutionCancelledError();
    const targets = await this.routes.resolve(context.tenantId, request.modelKey, request.taskType);
    if (targets.length === 0) throw new ModelRouteNotFoundError(request.modelKey);

    let lastError: unknown;
    for (const target of targets) {
      if (signal.aborted) throw new ModelExecutionCancelledError();
      const provider = this.providers.get(target.providerId);
      if (!provider) continue;
      const resolvedRequest = { ...request, providerModel: target.providerModel };
      const estimate = await provider.estimate(resolvedRequest);
      const reservation = await this.budgets.reserve({
        tenantId: context.tenantId,
        taskType: request.taskType,
        requestCapUsd: request.maxCostUsd,
        estimatedCostUsd: estimate.costUsd,
      });

      try {
        const result = await executeWithTimeout(provider, resolvedRequest, target.timeoutMs, signal);
        await reservation.commit(result.costUsd);
        return result;
      } catch (error) {
        await reservation.release();
        if (signal.aborted || error instanceof ModelExecutionCancelledError) {
          throw new ModelExecutionCancelledError();
        }
        lastError = error;
        if (!isRetryableProviderError(error)) throw error;
      }
    }

    throw lastError ?? new ModelRouteNotFoundError(request.modelKey);
  }
}

async function executeWithTimeout<T>(
  provider: ModelProvider,
  request: Parameters<ModelProvider["generate"]>[0] & ModelRequest<T>,
  timeoutMs: number,
  callerSignal: AbortSignal,
): Promise<ModelResult<T>> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cancelListener: (() => void) | undefined;

  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new ProviderTimeoutError(provider.providerId, timeoutMs));
      controller.abort();
    }, timeoutMs);
  });
  const cancellation = new Promise<never>((_, reject) => {
    cancelListener = () => {
      controller.abort();
      reject(new ModelExecutionCancelledError());
    };
    callerSignal.addEventListener("abort", cancelListener, { once: true });
  });

  try {
    return await Promise.race([provider.generate(request, controller.signal), deadline, cancellation]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (cancelListener) callerSignal.removeEventListener("abort", cancelListener);
  }
}
