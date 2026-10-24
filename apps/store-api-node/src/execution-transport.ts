import { request } from "node:https";
import type { StoreNodeEnrollmentResult } from "@yummyai/contracts/marketplace/store-node";
import { STORE_NODE_EXECUTION_WIRE_BYTES, StoreNodeExecutionErrorSchema } from "@yummyai/contracts/marketplace/store-node-execution";
import { StoreNodeError, nodeCheck } from "./error.js";
import { storeNodeOrigin } from "./config.js";

export type StoreNodeExecutionRpc = "claim" | "permit" | "step" | "checkpoint" | "complete" | "receipt";
export class StoreNodeExecutionRpcError extends StoreNodeError { constructor(code: string, readonly unknownOutcome: boolean) { super(code); } }
export class StoreNodeExecutionTransport {
  constructor(private readonly options: { identity: StoreNodeEnrollmentResult; encryptedPrivateKeyPem: string; passphrase: string; signal?: AbortSignal }) {}
  async call(operation: StoreNodeExecutionRpc, raw: unknown): Promise<unknown> {
    nodeCheck(["claim", "permit", "step", "checkpoint", "complete", "receipt"].includes(operation), "store_node_policy_rejected");
    const options = this.options; options.signal?.throwIfAborted();
    const bytes = Buffer.from(JSON.stringify(raw)); nodeCheck(bytes.length <= STORE_NODE_EXECUTION_WIRE_BYTES, "store_node_result_too_large");
    try {
      return await new Promise((resolve, reject) => {
        let completed = false;
        const done = (error: Error | null, value?: unknown) => { if (completed) return; completed = true; clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); if (error) reject(error); else resolve(value); };
        const req = request(new URL(`/v1/store-nodes/runtime/executions/${operation}`, storeNodeOrigin(options.identity.runtimeOrigin)), {
          method: "POST", minVersion: "TLSv1.3", rejectUnauthorized: true, allowPartialTrustChain: true, agent: false,
          ca: options.identity.caCertificatePem, cert: options.identity.certificatePem, key: options.encryptedPrivateKeyPem, passphrase: options.passphrase,
          headers: { "content-type": "application/json", "content-length": bytes.length, connection: "close" },
        }, response => {
          const maximum = response.statusCode === 200 ? STORE_NODE_EXECUTION_WIRE_BYTES : 8192;
          const chunks: Buffer[] = []; let total = 0;
          const length = response.headers["content-length"];
          if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers["content-type"] ?? "") || response.headers["content-encoding"]
            || length && (!/^\d+$/.test(length) || Number(length) > maximum)) { response.destroy(); done(new StoreNodeExecutionRpcError("store_node_execution_failed", true)); return; }
          response.on("data", (chunk: Buffer) => { total += chunk.length; if (total > maximum) { response.destroy(); done(new StoreNodeExecutionRpcError("store_node_result_too_large", true)); } else chunks.push(chunk); });
          response.once("error", () => { for (const chunk of chunks) chunk.fill(0); done(new StoreNodeExecutionRpcError("store_node_operation_unknown", true)); });
          response.once("end", () => {
            const body = Buffer.concat(chunks); for (const chunk of chunks) chunk.fill(0);
            try {
              const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
              if (response.statusCode !== 200) {
                const code = StoreNodeExecutionErrorSchema.safeParse((parsed as { code?: unknown } | null)?.code);
                done(new StoreNodeExecutionRpcError(code.success ? code.data : response.statusCode === 401 || response.statusCode === 403 ? "store_node_authority_changed" : "store_node_execution_failed", (response.statusCode ?? 500) >= 500));
              } else done(null, parsed);
            } catch { done(new StoreNodeExecutionRpcError("store_node_operation_unknown", true)); } finally { body.fill(0); }
          });
        });
        const cancel = () => { req.destroy(); done(new StoreNodeExecutionRpcError("store_node_operation_unknown", true)); };
        const timer = setTimeout(cancel, 20000); req.once("error", () => done(new StoreNodeExecutionRpcError("store_node_operation_unknown", true)));
        options.signal?.addEventListener("abort", cancel, { once: true }); if (options.signal?.aborted) cancel(); else req.end(bytes);
      });
    } finally { bytes.fill(0); }
  }
}
