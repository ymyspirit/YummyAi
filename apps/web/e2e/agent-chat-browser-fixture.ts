import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ErpSessionViewSchema } from "@yummyai/contracts/auth/session";
import { AssistResultSchema, AssistViewSchema } from "@yummyai/contracts/ai/assist";
import { ConfigurationSnapshotSchema } from "@yummyai/contracts/ai/model-configuration";
import { KnowledgeFieldsSchema, type KnowledgeWorkspace } from "@yummyai/contracts/knowledge";
import {
  aiAssistExecutions,
  aiAssistRuns,
  connectDatabase,
  knowledgeEntries,
  modelProviderConfigs,
  modelRoutes,
  withTenant,
} from "@yummyai/database";
import { and, eq, sql } from "drizzle-orm";
import { actors } from "./erp-identity-fixture";
import { requireAgentReadBrowser } from "./agent-read-fixture";
import { centerApi } from "./order-centers-fixture";

type ProviderCall = {
  stream: boolean;
  model: string;
  context: Record<string, unknown>;
  finalSent: boolean;
  released: boolean;
};
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const event = (type: string, fields: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;

/** Only a loopback provider is synthetic. The compiled personal Web, API,
 * current membership, knowledge retrieval, OpenAiProvider, Durable execution,
 * streaming BFF, usage receipt and browser interaction are the real paths. */
export async function agentChatBrowserFixture() {
  const isolated = requireAgentReadBrowser(),
    actor = actors().operator;
  const session = ErpSessionViewSchema.parse(await centerApi("identity/session"));
  if (session.tenantId !== actor.tenantId || session.userId !== actor.userId)
    throw new Error("agent_chat_fixture_personal_actor_mismatch");
  const database = connectDatabase(isolated.url),
    context = session;
  const calls: ProviderCall[] = [],
    holds: ReturnType<typeof latch>[] = [];
  const sockets = new Set<Socket>(),
    responses = new Set<ServerResponse>();
  const providerFailures: string[] = [],
    runIds = new Set<string>();
  const suffix = isolated.nonce.slice(0, 12),
    name = `Synthetic agent chat ${suffix}`;
  const title = `AGENTCHAT-${suffix} 原图规格核对`;
  const modelName = `synthetic-agent-chat-${suffix}`;
  const partial = "首段已收到";
  const firstSummary = `${partial}，先核对顾客原图，再核对已保存规格。`;
  const secondSummary = "延续上一轮原图与规格核对，保留复核记录。";
  let channelId: string | undefined, modelId: string | undefined, cardId: string | undefined;
  let closed = false;
  const server = createServer((request, response) => {
    responses.add(response);
    response.once("close", () => responses.delete(response));
    void (async () => {
      if (
        request.method !== "POST" ||
        request.url !== "/v1/responses" ||
        request.headers.authorization !== "Bearer fixture-chat-key"
      )
        throw new Error("unexpected_provider_request");
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const next = Buffer.from(chunk);
        bytes += next.byteLength;
        if (bytes > 2 * 1024 * 1024) throw new Error("provider_request_too_large");
        chunks.push(next);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        !record(body) ||
        body.stream !== true ||
        body.model !== modelName ||
        !Array.isArray(body.input)
      )
        throw new Error("provider_request_contract_invalid");
      const input = body.input[0];
      if (!record(input) || typeof input.content !== "string")
        throw new Error("provider_input_missing");
      const match = /<untrusted_source_data>\n([\s\S]*)\n<\/untrusted_source_data>/.exec(
        input.content,
      );
      if (!match) throw new Error("provider_untrusted_envelope_missing");
      const source: unknown = JSON.parse(match[1]!);
      if (
        !record(source) ||
        !Array.isArray(source.operatingKnowledge) ||
        !source.operatingKnowledge.length
      )
        throw new Error("provider_actual_knowledge_missing");
      const knowledge = source.operatingKnowledge.find(
        (item) => record(item) && item.title === title,
      );
      if (!record(knowledge) || typeof knowledge.sourceId !== "string")
        throw new Error("provider_pinned_source_missing");
      const index = calls.length;
      if (index > 1) throw new Error("provider_unexpected_repeat_call");
      const held = latch();
      holds.push(held);
      const call: ProviderCall = {
        stream: true,
        model: modelName,
        context: source,
        finalSent: false,
        released: false,
      };
      calls.push(call);
      const summary = index === 0 ? firstSummary : secondSummary;
      const result = AssistResultSchema.parse({
        summary,
        findings: [
          {
            title: "原图与规格核对",
            detail: summary,
            kind: "fact",
            severity: "info",
            evidence: [
              { sourceId: knowledge.sourceId, detail: "本轮实际检索并固定的已发布测试来源" },
            ],
            location: null,
          },
        ],
        directions: [],
        matches: [],
        missingInformation: [],
      });
      const text = JSON.stringify(result),
        prefix =
          '{"summary":' + JSON.stringify(index === 0 ? partial : summary.slice(0, 8)).slice(0, -1);
      if (!text.startsWith(prefix)) throw new Error("provider_stream_prefix_invalid");
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-request-id": `synthetic-agent-chat-${index + 1}`,
      });
      response.flushHeaders();
      response.write(
        event("response.output_text.delta", {
          delta: prefix,
          item_id: `synthetic-msg-${index}`,
          output_index: 0,
          content_index: 0,
        }),
      );
      await held.promise;
      if (response.destroyed) return;
      response.write(
        event("response.output_text.delta", {
          delta: text.slice(prefix.length),
          item_id: `synthetic-msg-${index}`,
          output_index: 0,
          content_index: 0,
        }),
      );
      response.write(
        event("response.completed", {
          response: {
            id: `synthetic-response-${index}`,
            status: "completed",
            model: modelName,
            output: [
              {
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text }],
              },
            ],
            usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
          },
        }),
      );
      call.finalSent = true;
      response.end();
    })().catch((failure: unknown) => {
      providerFailures.push(
        failure instanceof Error && /^[a-z_]+$/.test(failure.message)
          ? failure.message
          : "provider_fixture_failed",
      );
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "synthetic_provider_failed" }));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const release = (index: number) => {
    const held = holds[index];
    if (!held) throw new Error("agent_chat_fixture_hold_missing");
    calls[index]!.released = true;
    held.resolve();
  };
  async function waitTerminal(id: string) {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const run = AssistViewSchema.parse(await centerApi(`ai-assists/runs/${id}`));
      if (["completed", "failed", "cancelled"].includes(run.status)) return run;
      if (Date.now() >= deadline) throw new Error("agent_chat_original_terminal_timeout");
      await delay(100);
    }
  }
  async function card() {
    if (!cardId) return undefined;
    return (await centerApi<KnowledgeWorkspace>("knowledge/workspace")).entries.find(
      (entry) => entry.id === cardId,
    );
  }
  async function close() {
    if (closed) return { alreadyClosed: true };
    closed = true;
    const failures: unknown[] = [];
    for (let index = 0; index < holds.length; index++) release(index);
    for (const id of runIds) {
      try {
        await waitTerminal(id);
      } catch (failure) {
        failures.push(failure);
      }
    }
    let sourceArchived = cardId === undefined,
      providerDeleted = channelId === undefined,
      routeDisabled = modelId === undefined;
    try {
      const entry = await card();
      if (entry)
        await centerApi(`knowledge/${entry.id}/archive`, {
          expectedRevision: entry.revision,
          version: entry.latestVersion,
          requestId: randomUUID(),
          reason: "归档本次一次性浏览器验收来源",
        });
      if (cardId) {
        const [row] = await withTenant(database.db, context, (tx) =>
          tx
            .select({ archivedAt: knowledgeEntries.archivedAt })
            .from(knowledgeEntries)
            .where(eq(knowledgeEntries.id, cardId!)),
        );
        sourceArchived = Boolean(row?.archivedAt);
        if (!sourceArchived) throw new Error("agent_chat_source_archive_unverified");
      }
    } catch (failure) {
      failures.push(failure);
    }
    try {
      if (channelId) {
        const snapshot = ConfigurationSnapshotSchema.parse(
          await centerApi("ai/configuration", { operation: "configuration.get" }),
        );
        const channel = snapshot.channels.find((item) => item.id === channelId);
        if (channel)
          await centerApi("ai/configuration", {
            operation: "channel.remove",
            id: channel.id,
            revision: channel.revision,
          });
        const [provider] = await withTenant(database.db, context, (tx) =>
          tx
            .select({
              status: modelProviderConfigs.status,
              encryptedApiKey: modelProviderConfigs.encryptedApiKey,
            })
            .from(modelProviderConfigs)
            .where(eq(modelProviderConfigs.id, channelId!)),
        );
        providerDeleted = provider?.status === "deleted" && provider.encryptedApiKey === "";
        if (modelId) {
          const [route] = await withTenant(database.db, context, (tx) =>
            tx
              .select({ status: modelRoutes.status })
              .from(modelRoutes)
              .where(eq(modelRoutes.id, modelId!)),
          );
          routeDisabled = route?.status === "disabled";
        }
        if (!providerDeleted || !routeDisabled)
          throw new Error("agent_chat_channel_cleanup_unverified");
      }
    } catch (failure) {
      failures.push(failure);
    }
    try {
      await new Promise<void>((accept, reject) => {
        if (!server.listening) {
          accept();
          return;
        }
        server.close((failure) => (failure ? reject(failure) : accept()));
        server.closeIdleConnections();
        for (const response of responses) response.destroy();
        for (const socket of sockets) socket.destroy();
      });
    } catch (failure) {
      failures.push(failure);
    }
    try {
      await database.client.end();
    } catch (failure) {
      failures.push(failure);
    }
    if (failures.length) throw new AggregateError(failures, "agent_chat_fixture_cleanup_failed");
    return {
      sourceArchived,
      providerDeleted,
      routeDisabled,
      httpClosed: !server.listening,
      databaseClosed: true,
      immutableHistoryRemovedByDisposableRunner: true,
    };
  }
  try {
    const [identity] = await withTenant(database.db, context, (tx) =>
      tx.execute<{ role: string; database: string }>(
        sql`select current_user::text as role, current_database()::text as database`,
      ),
    );
    if (
      identity?.role !== "yummyai_app" ||
      identity.database !== `order_daily_e2e_${isolated.nonce}`
    )
      throw new Error("agent_chat_fixture_non_owner_nonce_required");
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("agent_chat_fixture_server_missing");
    const created = ConfigurationSnapshotSchema.parse(
      await centerApi("ai/configuration", {
        operation: "channel.save",
        name,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "fixture-chat-key",
        textProtocol: "responses",
        models: [],
      }),
    );
    const channel = created.channels.find((item) => item.name === name);
    if (!channel || channel.provider !== "openai")
      throw new Error("agent_chat_fixture_channel_missing");
    channelId = channel.id;
    modelId = (
      await centerApi<{ id: string }>("ai-assists/models", {
        providerConfigId: channelId,
        model: modelName,
        label: `Synthetic stream ${suffix}`,
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
        maxTaskCostUsd: 1,
      })
    ).id;
    const fields = KnowledgeFieldsSchema.parse({
      title,
      summary: "原图与规格核对验收来源",
      body: `${title}。先核对顾客原图，再核对已保存规格，保留复核记录。`,
      topic: "operations",
      platform: "all",
      market: "ALL",
      spuId: null,
      sourceType: "team",
      sourceLabel: "Synthetic agent chat source",
      sourceUrl: "",
      owner: "Synthetic operator",
      verifiedOn: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(
        new Date(),
      ),
      reviewDueOn: "2099-12-31",
      tags: [suffix],
    });
    cardId = (
      await centerApi<{ id: string }>("knowledge/create", {
        fields,
        expectedRevision: 0,
        reason: "本次独立流式浏览器验收来源",
        requestId: randomUUID(),
      })
    ).id;
    for (const operation of ["submit", "publish"]) {
      const entry = await card();
      if (!entry) throw new Error("agent_chat_fixture_source_missing");
      await centerApi(`knowledge/${entry.id}/${operation}`, {
        expectedRevision: entry.revision,
        version: entry.latestVersion,
        reason: "合成来源已核对并明确用于一次性验收",
        requestId: randomUUID(),
      });
    }
    return {
      nonce: isolated.nonce,
      actor,
      modelId,
      title,
      question: title,
      secondQuestion: `${title} 请继续说明复核记录`,
      partial,
      firstSummary,
      secondSummary,
      release,
      waitTerminal,
      calls: () => calls.map((call) => ({ ...call })),
      providerFailures: () => [...providerFailures],
      trackRun(id: string) {
        runIds.add(AssistViewSchema.shape.id.parse(id));
      },
      async nativeRuns() {
        return withTenant(database.db, context, async (tx) => {
          const rows = await tx
            .select({
              id: aiAssistRuns.id,
              status: aiAssistRuns.status,
              inputTokens: aiAssistRuns.inputTokens,
              outputTokens: aiAssistRuns.outputTokens,
              tokenUsage: aiAssistRuns.tokenUsage,
              phase: aiAssistExecutions.phase,
              attemptCount: aiAssistExecutions.attemptCount,
              submissionState: aiAssistExecutions.submissionState,
            })
            .from(aiAssistRuns)
            .innerJoin(
              aiAssistExecutions,
              and(
                eq(aiAssistExecutions.runId, aiAssistRuns.id),
                eq(aiAssistExecutions.tenantId, aiAssistRuns.tenantId),
              ),
            )
            .where(eq(aiAssistRuns.ownerId, actor.userId));
          return rows.filter((row) => runIds.has(row.id)).sort((a, b) => a.id.localeCompare(b.id));
        });
      },
      close,
    };
  } catch (failure) {
    const failures = [failure];
    try {
      await close();
    } catch (cleanupFailure) {
      failures.push(cleanupFailure);
    }
    throw new AggregateError(failures, "agent_chat_fixture_initialization_failed");
  }
}
