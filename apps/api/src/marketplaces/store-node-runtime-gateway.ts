import { createHash, X509Certificate } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { TLSSocket } from "node:tls";

import { Inject, Injectable, Optional, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { ForbiddenError } from "@yummyai/authz";
import { StoreNodeHeartbeatInputSchema, StoreNodeHeartbeatViewSchema, type StoreNodeHeartbeatInput,
  type StoreNodeHeartbeatView } from "@yummyai/contracts/marketplace/store-node";
import { STORE_NODE_EXECUTION_WIRE_BYTES, StoreNodeExecutionClaimInputSchema, StoreNodeExecutionPermitInputSchema, StoreNodeExecutionStepInputSchema,
  StoreNodeExecutionCheckpointInputSchema, StoreNodeExecutionCompleteInputSchema, StoreNodeExecutionCallSchema, StoreNodeExecutionClaimSchema,
  StoreNodeExecutionPermitSchema, StoreNodeExecutionAckSchema, StoreNodeExecutionRuntimeReceiptSchema, StoreNodeExecutionErrorSchema } from "@yummyai/contracts/marketplace/store-node-execution";

import type { StoreNodePki } from "./store-node-pki.js";
import { StoreNodeService } from "./store-node.service.js";
import { StoreNodeCertificateIssuer, type StoreNodePeer } from "./store-node.types.js";
import { StoreNodeExecutionRuntime, type StoreNodeExecutionRpc } from "./store-node-execution.types.js";

const executionInputs = { claim: StoreNodeExecutionClaimInputSchema, permit: StoreNodeExecutionPermitInputSchema, step: StoreNodeExecutionStepInputSchema,
  checkpoint: StoreNodeExecutionCheckpointInputSchema, complete: StoreNodeExecutionCompleteInputSchema, receipt: StoreNodeExecutionCallSchema };
const executionOutputs = { claim: StoreNodeExecutionClaimSchema, permit: StoreNodeExecutionPermitSchema, step: StoreNodeExecutionAckSchema,
  checkpoint: StoreNodeExecutionRuntimeReceiptSchema, complete: StoreNodeExecutionRuntimeReceiptSchema, receipt: StoreNodeExecutionRuntimeReceiptSchema };

/** This listener authenticates the TLS socket itself, never forwarding headers. */
@Injectable()
export class StoreNodeRuntimeGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private server: Server | null = null;
  private readonly sockets = new Set<Duplex>();
  constructor(@Inject(StoreNodeCertificateIssuer) private readonly pki: StoreNodePki,
    @Inject(StoreNodeService) private readonly service: { runtimeHeartbeat(peer: StoreNodePeer, input: StoreNodeHeartbeatInput): Promise<StoreNodeHeartbeatView> },
    @Optional() @Inject(StoreNodeExecutionRuntime) private readonly execution?: StoreNodeExecutionRuntime) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.pki.configuration().enabled) return;
    if (this.server) throw new Error("store_node_runtime_already_started");
    const server = createServer(this.pki.runtimeServerOptions(), (request, response) => { void this.handle(request, response); });
    server.requestTimeout = this.execution ? 20_000 : 10_000; server.headersTimeout = 5_000; server.keepAliveTimeout = 1_000;
    server.maxRequestsPerSocket = 10;
    server.on("connection", socket => { this.sockets.add(socket); socket.once("close", () => this.sockets.delete(socket)); });
    server.on("tlsClientError", (_error, socket) => socket.destroy());
    server.on("clientError", (_error, socket) => socket.destroy());
    this.server = server;
    try {
      const { host, port } = this.pki.runtimeAddress();
      await new Promise<void>((resolve, reject) => {
        const failed = () => reject(new Error("store_node_runtime_unavailable"));
        server.once("error", failed);
        server.listen(port, host, () => { server.off("error", failed); resolve(); });
      });
      server.on("error", () => { for (const socket of this.sockets) socket.destroy(); });
    } catch { this.server = null; server.close(); throw new Error("store_node_runtime_unavailable"); }
  }
  address(): AddressInfo | null { const value = this.server?.address(); return value && typeof value !== "string" ? value : null; }
  async onApplicationShutdown(): Promise<void> {
    const server = this.server; this.server = null;
    if (!server) return;
    const completion = new Promise<void>(resolve => server.close(() => resolve()));
    for (const socket of this.sockets) socket.destroy();
    await completion;
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const match = /^\/v1\/store-nodes\/runtime\/executions\/(claim|permit|step|checkpoint|complete|receipt)$/.exec(request.url ?? "");
    const operation = match?.[1] as StoreNodeExecutionRpc | undefined;
    response.setHeader("Cache-Control", "no-store"); response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Connection", "close");
    try {
      if (request.method !== "POST" || !operation && request.url !== "/v1/store-nodes/runtime/heartbeat") return reply(response, 404, "store_node_route_not_found");
      if (!(request.socket instanceof TLSSocket) || !request.socket.authorized) return reply(response, 401, "store_node_certificate_invalid");
      const certificate = request.socket.getPeerCertificate(true);
      if (!certificate.raw?.length) return reply(response, 401, "store_node_certificate_invalid");
      const leaf = new X509Certificate(certificate.raw);
      if (leaf.ca || leaf.keyUsage?.length !== 1 || leaf.keyUsage[0] !== "1.3.6.1.5.5.7.3.2"
        || new Date(leaf.validFrom).getTime() > Date.now() || new Date(leaf.validTo).getTime() <= Date.now()) return reply(response, 401, "store_node_certificate_invalid");
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "") || request.headers["content-encoding"])
        return reply(response, 400, "store_node_request_invalid");
      const length = request.headers["content-length"];
      const maximum = operation ? STORE_NODE_EXECUTION_WIRE_BYTES : 4096;
      if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) { request.resume(); return reply(response, 413, "store_node_request_too_large"); }
      const bytes = await body(request, maximum, operation ? 20000 : 10000);
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { throw new StoreNodeRuntimeInputError(400, "store_node_request_invalid"); }
      finally { bytes.fill(0); }
      const parsed = operation ? executionInputs[operation].safeParse(raw) : StoreNodeHeartbeatInputSchema.safeParse(raw);
      if (!parsed.success || leaf.subjectAltName !== `URI:urn:yummyai:store-node:${parsed.data.nodeId}`) return reply(response, 400, "store_node_request_invalid");
      const peer: StoreNodePeer = { fingerprintSha256: createHash("sha256").update(leaf.raw).digest("hex"),
        publicKeySpkiSha256: createHash("sha256").update(leaf.publicKey.export({ type: "spki", format: "der" })).digest("hex"), certificatePem: leaf.toString() };
      let view: unknown;
      if (operation) {
        if (!this.execution) return reply(response, 503, "store_node_configuration_invalid");
        view = executionOutputs[operation].parse(await this.execution.execute(peer, operation, parsed.data));
      } else view = StoreNodeHeartbeatViewSchema.parse(await this.service.runtimeHeartbeat(peer, StoreNodeHeartbeatInputSchema.parse(parsed.data)));
      const output = JSON.stringify(view);
      if (Buffer.byteLength(output) > maximum) return reply(response, 503, "store_node_result_too_large");
      response.statusCode = 200; response.end(output);
    } catch (error) {
      if (error instanceof ForbiddenError) { reply(response, 403, operation ? "store_node_authority_changed" : "store_node_authority_rejected"); return; }
      if (error instanceof StoreNodeRuntimeInputError) { reply(response, error.status, error.message); return; }
      const value = error as { getStatus?: () => number; getResponse?: () => unknown; message?: string };
      const status = typeof value?.getStatus === "function" ? value.getStatus() : 503;
      const detail = typeof value?.getResponse === "function" ? value.getResponse() : null;
      const code = detail && typeof detail === "object" && "code" in detail ? (detail as { code: unknown }).code : value?.message;
      const executionCode = operation ? StoreNodeExecutionErrorSchema.safeParse(code) : null;
      reply(response, [400, 401, 403, 404, 409, 413, 422].includes(status) ? status : 503, operation
        ? status === 401 || status === 403 ? "store_node_authority_changed" : executionCode?.success ? executionCode.data : "store_node_execution_failed"
        : typeof code === "string" && /^store_node_[a-z_]{1,80}$/.test(code) ? code : "store_node_runtime_unavailable");
    }
  }
}
class StoreNodeRuntimeInputError extends Error { constructor(readonly status: number, code: string) { super(code); } }
function reply(response: ServerResponse, status: number, code: string): void {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = status; response.end(JSON.stringify({ code, message: code }));
}
async function body(request: IncomingMessage, maximum = 4096, timeout = 10000): Promise<Buffer> {
  const chunks: Buffer[] = []; let length = 0;
  const timer = setTimeout(() => request.destroy(), timeout);
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array); length += bytes.length;
      if (length > maximum) { request.destroy(); throw new StoreNodeRuntimeInputError(413, "store_node_request_too_large"); }
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  } finally { clearTimeout(timer); for (const chunk of chunks) chunk.fill(0); }
}
