import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OpenAiCompatibleProvider } from "./providers/openai-compatible.js";
import { OpenAiProvider } from "./providers/openai.js";
import { decodeModelResponse, type ModelResponseCheckpoint } from "./response-checkpoint.js";

describe("private provider response checkpoints", () => {
  it.each(["openai", "compatible"] as const)(
    "awaits a %s checkpoint before rejecting malformed structured output",
    async (kind) => {
      const payload =
        kind === "openai"
          ? {
              id: "synthetic-response",
              usage: { input_tokens: 10, output_tokens: 20 },
              output_text: "not JSON",
            }
          : {
              id: "synthetic-response",
              usage: { prompt_tokens: 10, completion_tokens: 20 },
              choices: [{ message: { content: "not JSON" } }],
            };
      const transport = vi.fn(async () => Response.json(payload));
      const config = {
        apiKey: "synthetic-test-key",
        pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
        fetch: transport as typeof fetch,
      };
      const provider =
        kind === "openai"
          ? new OpenAiProvider(config)
          : new OpenAiCompatibleProvider({
              ...config,
              providerId: "synthetic-provider",
              endpoint: "https://fixture.invalid",
            });
      let saved: ModelResponseCheckpoint | undefined;
      await expect(
        provider.generate(
          {
            modelKey: "synthetic",
            providerModel: "synthetic",
            taskType: "analysis",
            systemInstructions: "Return JSON",
            untrustedSourceData: {},
            outputSchema: z.object({ answer: z.string() }),
            maxCostUsd: 1,
            onResponseCheckpoint: async (value) => {
              await Promise.resolve();
              saved = value;
            },
          },
          AbortSignal.timeout(5000),
        ),
      ).rejects.toThrow("model_output_invalid_json");
      expect(saved).toMatchObject({
        providerRequestId: "synthetic-response",
        inputTokens: 10,
        outputTokens: 20,
        costUsd: 0.00005,
      });
      expect(transport).toHaveBeenCalledTimes(1);
      expect(() => decodeModelResponse(saved!, z.object({ answer: z.string() }))).toThrow(
        "model_output_invalid_json",
      );
    },
  );

  it("does not interpret or repeat a response when durable checkpoint storage fails", async () => {
    const transport = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: '{"answer":"synthetic"}' } }] }),
    );
    const provider = new OpenAiCompatibleProvider({
      providerId: "fixture",
      apiKey: "synthetic",
      endpoint: "https://fixture.invalid",
      pricing: null,
      fetch: transport as typeof fetch,
    });
    const checkpoint = vi.fn(async (response: ModelResponseCheckpoint) => {
      void response;
      throw new Error("synthetic checkpoint storage failure");
    });
    await expect(
      provider.generate(
        {
          modelKey: "synthetic",
          providerModel: "synthetic",
          taskType: "analysis",
          systemInstructions: "Return JSON",
          untrustedSourceData: {},
          outputSchema: z.object({ answer: z.string() }),
          maxCostUsd: null,
          onResponseCheckpoint: checkpoint,
        },
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow("synthetic checkpoint storage failure");
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(checkpoint.mock.calls[0]?.[0]).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    });
  });
});
