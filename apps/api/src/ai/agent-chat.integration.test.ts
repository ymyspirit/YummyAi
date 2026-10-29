import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ModelResponseCheckpointSchema, OpenAiProvider } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId } from "@yummyai/contracts";
import {
  AgentChatEventSchema,
  type AgentChatEvent,
  type CreateAgentChatTurn,
} from "@yummyai/contracts/ai/agent-chat";
import { AssistResultSchema, type AssistView } from "@yummyai/contracts/ai/assist";
import {
  aiAssistExecutions,
  aiAssistRuns,
  connectDatabase,
  modelRoutes,
  withTenant,
} from "@yummyai/database";
import { eq } from "drizzle-orm";
import { AgentChatService } from "./agent-chat.service.js";
import {
  agentReadFixture,
  allAgentPermissions,
  bounded,
  deferred,
  requireAgentReadEnvironment,
} from "./agent-read.test-fixture.js";

// The dedicated config and this exact nonce guard run before any connection.
const database = connectDatabase(requireAgentReadEnvironment()),
  f = agentReadFixture(database);
const allScopes = () =>
  Object.fromEntries(allAgentPermissions.map((bit) => [bit, "tenant" as const]));
type Gate = ReturnType<typeof deferred>;
type ResponsePlan = { summary: string; gate?: Gate; truncate?: boolean; usage?: boolean };
const plans = new Map<string, ResponsePlan>(),
  gates = new Set<Gate>();
const running = new Set<Promise<void>>(),
  ownedRuns = new Set<string>();
const requests: Array<{ runId: string; body: Record<string, unknown> }> = [];
let chat: AgentChatService, modelId: string, sourceQuestion: string;
const encoder = new TextEncoder();
const sse = (type: string, fields: Record<string, unknown>) =>
  `event: ${type}\r\ndata: ${JSON.stringify({ type, ...fields })}\r\n\r\n`;

function gate() {
  const value = deferred();
  gates.add(value);
  return value;
}
async function current() {
  return f.current(f.a);
}
function input(
  message = sourceQuestion,
  scopeId: string = randomUUID(),
  previousRunId: string | null = null,
): CreateAgentChatTurn {
  return { requestId: randomUUID(), scopeId, previousRunId, modelId, message };
}
async function create(raw = input(), plan: Partial<ResponsePlan> = {}) {
  const value = await chat.create(await current(), raw);
  ownedRuns.add(value.id);
  plans.set(value.id, { summary: "Synthetic chat answer", ...plan });
  return { run: value, input: raw };
}
function proof(run: AssistView) {
  return { requestId: run.request!.requestId, inputFingerprint: run.inputFingerprint };
}
function observe(run: AssistView, execute = true, controller = new AbortController()) {
  const events: AgentChatEvent[] = [],
    firstDelta = deferred(),
    firstEvent = deferred();
  const promise = current().then((context) =>
    chat.stream(
      context,
      run.id,
      execute ? proof(run) : undefined,
      async (raw) => {
        const event = AgentChatEventSchema.parse(raw);
        events.push(event);
        firstEvent.resolve();
        if (event.type === "text_delta") firstDelta.resolve();
      },
      controller.signal,
    ),
  );
  running.add(promise);
  void promise.then(
    () => running.delete(promise),
    () => running.delete(promise),
  );
  return { events, promise, firstDelta, firstEvent, controller };
}
async function terminal(id: string) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await f.assists.get(await current(), id, { purgeExpired: false });
    if (["completed", "failed", "cancelled"].includes(value.status)) return value;
    if (Date.now() >= deadline) throw new Error("synthetic_chat_terminal_timeout");
    await delay(20);
  }
}
async function stored(id: string) {
  return withTenant(database.db, f.seed(f.a), async (tx) => {
    const [execution] = await tx
      .select()
      .from(aiAssistExecutions)
      .where(eq(aiAssistExecutions.runId, id));
    const [run] = await tx.select().from(aiAssistRuns).where(eq(aiAssistRuns.id, id));
    return { execution, run };
  });
}

async function receipt(id: string, requestId: string) {
  const original = await stored(id);
  if (!original.execution?.encryptedResponse || !original.run)
    throw new Error("synthetic_original_receipt_missing");
  expect(original.run.requestId).toBe(requestId);
  expect(original.execution.runId).toBe(original.run.id);
  expect(original.execution.inputFingerprint).toBe(original.run.inputFingerprint);
  const checkpoint = f.vault.withSecret(original.execution.encryptedResponse, (raw) => {
    expect(createHash("sha256").update(raw).digest("hex")).toBe(
      original.execution!.responseChecksum,
    );
    return ModelResponseCheckpointSchema.parse((JSON.parse(raw) as { response: unknown }).response);
  });
  expect(checkpoint).toMatchObject({
    providerId: "openai",
    modelKey: "synthetic-chat-unlimited",
    providerRequestId: `synthetic-chat-request-${id}`,
    inputTokens: 11,
    outputTokens: 7,
    costUsd: null,
    tokenUsage: { totalTokens: 18, totalTokensBasis: "provider" },
  });
  expect(original.execution.providerRequestId).toBe(checkpoint.providerRequestId);
  expect(checkpoint.payload).toMatchObject({
    id: `synthetic-chat-response-${id}`,
    usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
  });
  return checkpoint;
}

describe.sequential(
  "Interactive Agent uses original durable knowledge dialogue and actual Responses SSE parsing",
  () => {
    beforeAll(async () => {
      await f.initialize();
      const source = await f.knowledgeRequest();
      if (source.kind !== "knowledge_answer")
        throw new Error("synthetic_knowledge_source_required");
      sourceQuestion = source.search.query;
      // Synthetic provider/route admission only. No model result, receipt or
      // approval is inserted; every execution below uses the real native owner.
      modelId = createEntityId();
      await withTenant(database.db, f.a.context, async (tx) => {
        const [priced] = await tx.select().from(modelRoutes).where(eq(modelRoutes.id, f.modelId));
        if (!priced?.targets[0]) throw new Error("synthetic_source_route_missing");
        await tx.insert(modelRoutes).values({
          id: modelId,
          tenantId: f.a.tenantId,
          modelKey: "Synthetic unlimited chat " + modelId,
          taskType: "studio_analysis",
          targets: [
            {
              providerConfigId: priced.targets[0].providerConfigId,
              providerModel: "synthetic-chat-unlimited",
              timeoutMs: 120_000,
            },
          ],
        });
      });
      chat = new AgentChatService(
        database,
        f.vault,
        f.modelVault,
        f.assists,
        f.answers,
        (_provider, key, run) =>
          new OpenAiProvider({
            apiKey: key,
            endpoint: "https://synthetic-chat.invalid/v1",
            pricing: null,
            fetch: async (_url, init) => {
              const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
              requests.push({ runId: run.id, body });
              const plan = plans.get(run.id);
              if (!plan) throw new Error("synthetic_chat_plan_missing");
              const result = AssistResultSchema.parse({
                summary: plan.summary,
                findings: [],
                directions: [],
                matches: [],
                missingInformation: [],
              });
              const json = JSON.stringify(result),
                split = Math.max(1, plan.summary.indexOf(" ") + 1);
              const prefix = '{"summary":"' + plan.summary.slice(0, split),
                rest = json.slice(prefix.length);
              const response = {
                id: `synthetic-chat-response-${run.id}`,
                model: run.modelSnapshot.model,
                status: "completed",
                output: [
                  {
                    type: "message",
                    status: "completed",
                    content: [{ type: "output_text", text: json }],
                  },
                ],
                ...(plan.usage === false
                  ? {}
                  : {
                      usage: {
                        input_tokens: 11,
                        output_tokens: 7,
                        total_tokens: 18,
                        input_tokens_details: { cached_tokens: 0 },
                      },
                    }),
              };
              return new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(
                      encoder.encode(sse("response.output_text.delta", { delta: prefix })),
                    );
                    void (async () => {
                      await plan.gate?.promise;
                      if (!plan.truncate) {
                        controller.enqueue(
                          encoder.encode(sse("response.output_text.delta", { delta: rest })),
                        );
                        controller.enqueue(encoder.encode(sse("response.completed", { response })));
                      }
                      controller.close();
                    })().catch((error) => controller.error(error));
                  },
                }),
                {
                  headers: {
                    "content-type": "text/event-stream; charset=utf-8",
                    "x-request-id": `synthetic-chat-request-${run.id}`,
                  },
                },
              );
            },
          }),
      );
    });

    afterEach(async () => {
      for (const held of gates) held.resolve();
      gates.clear();
      const failures: unknown[] = [];
      try {
        await f.scopes(f.a, allScopes());
        f.a.context = await current();
      } catch (error) {
        failures.push(error);
      }
      for (const task of [...running])
        try {
          await bounded(task, "synthetic_chat_stream_teardown_timeout");
        } catch (error) {
          failures.push(error);
        }
      for (const id of ownedRuns)
        try {
          await terminal(id);
        } catch (error) {
          failures.push(error);
        }
      if (failures.length)
        throw new AggregateError(failures, "synthetic_chat_owned_teardown_failed");
    });
    afterAll(async () => {
      f.close();
      await database.client.end();
    });

    it("emits a short real delta before completion, then persists one exact receipt and provider token totals with no imposed token cap", async () => {
      const hold = gate(),
        created = await create(input(), { summary: "First streamed answer", gate: hold }),
        offset = requests.length;
      const stream = observe(created.run);
      try {
        await bounded(stream.firstDelta.promise, "synthetic_short_delta_not_visible_before_final");
        expect(stream.events.some((event) => event.type === "completed")).toBe(false);
        expect(
          stream.events
            .filter((event) => event.type === "text_delta")
            .map((event) => (event.type === "text_delta" ? event.text : ""))
            .join(""),
        ).toBe("First ");
        expect((await stored(created.run.id)).execution?.receivedAt).toBeNull();
      } finally {
        hold.resolve();
      }
      await stream.promise;
      const final = await terminal(created.run.id),
        original = await stored(created.run.id);
      expect(final).toMatchObject({
        status: "completed",
        maxTaskCostUsd: null,
        inputTokens: 11,
        outputTokens: 7,
        costUsd: null,
        tokenUsage: { totalTokens: 18, totalTokensBasis: "provider" },
        result: { summary: "First streamed answer" },
      });
      expect(final.usageSummary).toMatchObject({
        callCount: 1,
        reportedCalls: 1,
        unknownCalls: 0,
        totalTokens: 18,
      });
      expect(original.execution).toMatchObject({
        submissionState: "received",
        phase: "completed",
      });
      await receipt(created.run.id, created.input.requestId);
      expect(requests.length - offset).toBe(1);
      expect(requests.at(-1)?.body).toMatchObject({ stream: true, store: false });
      expect(requests.at(-1)?.body).not.toHaveProperty("max_output_tokens");
      expect(stream.events.at(-1)).toMatchObject({
        type: "completed",
        runId: final.id,
        requestId: created.input.requestId,
      });
      expect(stream.events.map((event) => event.sequence)).toEqual(
        stream.events.map((_event, index) => index + 1),
      );
    });

    it("continues a third turn with both original answers and full prior questions while rejecting a different conversation scope", async () => {
      const first = await create(input(sourceQuestion + " first original question"), {
        summary: "First original answer",
      });
      await observe(first.run).promise;
      const second = await create(
        input("Second full original question", first.input.scopeId, first.run.id),
        { summary: "Second original answer" },
      );
      await observe(second.run).promise;
      const third = await create(input("Third question", first.input.scopeId, second.run.id), {
        summary: "Third original answer",
      });
      await observe(third.run).promise;
      const packet = JSON.stringify(
        requests.find((request) => request.runId === third.run.id)?.body,
      );
      for (const text of [
        first.input.message,
        "First original answer",
        second.input.message,
        "Second original answer",
        "Third question",
      ])
        expect(packet).toContain(text);
      const history = await chat.history(await current(), first.input.scopeId);
      expect(history.turns.map((run) => run.id)).toEqual([
        first.run.id,
        second.run.id,
        third.run.id,
      ]);
      expect(history.hasMore).toBe(false);
      const before = requests.length;
      await expect(
        chat.create(await current(), input("Different scope", randomUUID(), first.run.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(requests).toHaveLength(before);
    });

    it("deduplicates simultaneous creates and stream observers against one original paid execution", async () => {
      const raw = input("Synthetic concurrent question"),
        hold = gate(),
        before = requests.length;
      const pair = await Promise.all([
        chat.create(await current(), raw),
        chat.create(await current(), raw),
      ]);
      expect(pair[0]!.id).toBe(pair[1]!.id);
      const run = pair[0]!;
      ownedRuns.add(run.id);
      plans.set(run.id, { summary: "Concurrent streamed answer", gate: hold });
      const first = observe(run),
        second = observe(run);
      let observer: ReturnType<typeof observe> | undefined;
      try {
        await bounded(first.firstDelta.promise, "synthetic_concurrent_first_delta_timeout");
        observer = observe(run, false);
        await bounded(observer.firstEvent.promise, "synthetic_concurrent_observer_start_timeout");
      } finally {
        hold.resolve();
      }
      if (!observer) throw new Error("synthetic_concurrent_observer_missing");
      await Promise.all([first.promise, second.promise, observer.promise]);
      expect(requests.length - before).toBe(1);
      for (const stream of [first, second, observer])
        expect(stream.events.at(-1)).toMatchObject({ type: "completed", runId: run.id });
      expect((await stored(run.id)).execution?.attemptCount).toBe(1);
      expect((await terminal(run.id)).usageSummary).toMatchObject({
        callCount: 1,
        totalTokens: 18,
      });
    });

    it("keeps GET observation read-only before execution and after final response without creating a replacement call", async () => {
      const created = await create(input("Synthetic original read-only recovery")),
        before = requests.length;
      const queued = observe(created.run, false);
      await queued.promise;
      expect(requests).toHaveLength(before);
      expect(queued.events.at(-1)).toMatchObject({ type: "error", code: "result_unknown" });
      expect((await stored(created.run.id)).execution?.submissionState).toBe("not_submitted");
      await observe(created.run).promise;
      const savedCalls = requests.length,
        restored = observe(created.run, false);
      await restored.promise;
      expect(restored.events.at(-1)).toMatchObject({ type: "completed", runId: created.run.id });
      expect(requests).toHaveLength(savedCalls);
    });

    it("preserves an unknown original submission after an upstream truncated stream and never automatically retries it", async () => {
      const created = await create(input("Synthetic truncated original"), {
          summary: "Unfinished streamed answer",
          truncate: true,
        }),
        before = requests.length;
      await observe(created.run).promise;
      const failed = await terminal(created.run.id),
        saved = await stored(created.run.id);
      expect(failed).toMatchObject({
        status: "failed",
        result: null,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
      });
      expect(failed.usageSummary).toMatchObject({
        callCount: 1,
        reportedCalls: 0,
        unknownCalls: 1,
        totalTokens: null,
      });
      expect(saved.execution).toMatchObject({
        phase: "uncertain",
        submissionState: "submitted",
        receivedAt: null,
        encryptedResponse: null,
      });
      await observe(created.run, false).promise;
      await observe(created.run, true).promise;
      expect(requests.length - before).toBe(1);
      expect((await stored(created.run.id)).execution?.attemptCount).toBe(
        saved.execution?.attemptCount,
      );
    });

    it("keeps the submitted task running after browser disconnect and records its receipt before GET-only recovery", async () => {
      const hold = gate(),
        created = await create(input("Synthetic disconnected operator"), {
          summary: "Disconnect preserved answer",
          gate: hold,
        }),
        before = requests.length;
      const stream = observe(created.run);
      try {
        await bounded(stream.firstDelta.promise, "synthetic_disconnect_first_delta_timeout");
        stream.controller.abort();
        await stream.promise;
      } finally {
        hold.resolve();
      }
      const final = await terminal(created.run.id);
      expect(final).toMatchObject({
        status: "completed",
        result: { summary: "Disconnect preserved answer" },
        inputTokens: 11,
        outputTokens: 7,
      });
      expect(stream.events.some((event) => event.type === "completed")).toBe(false);
      const recovered = observe(created.run, false);
      await recovered.promise;
      expect(recovered.events.at(-1)).toMatchObject({ type: "completed", runId: final.id });
      expect(requests.length - before).toBe(1);
    });

    it("keeps another actor or tenant from reading or streaming the private conversation", async () => {
      const created = await create(input("Synthetic private conversation"));
      await observe(created.run).promise;
      const before = requests.length;
      for (const actor of [f.second, f.foreign]) {
        expect((await chat.history(await f.current(actor), created.input.scopeId)).turns).toEqual(
          [],
        );
        const events: AgentChatEvent[] = [];
        await expect(
          chat.stream(
            await f.current(actor),
            created.run.id,
            undefined,
            async (event) => {
              events.push(event);
            },
            new AbortController().signal,
          ),
        ).rejects.toBeDefined();
        expect(events).toEqual([]);
      }
      expect(requests).toHaveLength(before);
    });

    it("rejects a mismatched original proof and sensitive text after the retrieval prefix before dispatch", async () => {
      const created = await create(input("Synthetic proof mismatch")),
        before = requests.length;
      await expect(
        chat.stream(
          await current(),
          created.run.id,
          { ...proof(created.run), inputFingerprint: "0".repeat(64) },
          async () => {},
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      const count = (await f.state()).tables.ai_assist_runs!.count;
      await expect(
        chat.create(await current(), input("a".repeat(350) + " synthetic@example.invalid")),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect((await f.state()).tables.ai_assist_runs!.count).toBe(count);
      expect(requests).toHaveLength(before);
      await observe(created.run).promise;
    });

    it("sends an opaque revocation event while retaining incurred provider usage without adopting a private answer", async () => {
      const hold = gate(),
        created = await create(input("Synthetic revoked active stream"), {
          summary: "Revocation private answer",
          gate: hold,
        });
      const stream = observe(created.run);
      try {
        await bounded(stream.firstDelta.promise, "synthetic_revocation_first_delta_timeout");
        const scopes = allScopes();
        delete scopes[Permission.WorkflowRead];
        await f.scopes(f.a, scopes);
        await bounded(stream.promise, "synthetic_revocation_stream_close_timeout");
        const error = stream.events.at(-1);
        expect(error?.type).toBe("error");
        expect(error).not.toHaveProperty("run");
        expect(error).not.toHaveProperty("text");
        hold.resolve();
        const deadline = Date.now() + 15_000;
        for (;;) {
          const retained = await stored(created.run.id);
          if (retained.execution?.receivedAt && retained.run?.status === "failed") break;
          if (Date.now() > deadline) throw new Error("synthetic_revoked_receipt_timeout");
          await delay(20);
        }
        expect((await stored(created.run.id)).execution?.submissionState).toBe("received");
        await receipt(created.run.id, created.input.requestId);
      } finally {
        hold.resolve();
        await f.scopes(f.a, allScopes());
        f.a.context = await current();
      }
      const final = await terminal(created.run.id);
      expect(final.result).toBeNull();
      expect(final.status).toBe("failed");
    });
  },
);
