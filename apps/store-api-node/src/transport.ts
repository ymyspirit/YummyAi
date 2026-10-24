import { request } from "node:https";
import { storeNodeOrigin } from "./config.js";
import { nodeCheck, StoreNodeError } from "./error.js";

export interface StoreNodeHttpOptions { origin: string; path: "/v1/store-nodes/enroll" | "/v1/store-nodes/runtime/heartbeat";
  caCertificatePem: string; body: unknown; certificatePem?: string; encryptedPrivateKeyPem?: string; passphrase?: string; signal?: AbortSignal }
export async function storeNodePost(options: StoreNodeHttpOptions): Promise<unknown> {
  const origin = storeNodeOrigin(options.origin); options.signal?.throwIfAborted();
  nodeCheck(Boolean(options.certificatePem) === Boolean(options.encryptedPrivateKeyPem)
    && Boolean(options.certificatePem) === Boolean(options.passphrase), "store_node_identity_invalid");
  const bytes = Buffer.from(JSON.stringify(options.body)); nodeCheck(bytes.length <= 16384, "store_node_request_invalid");
  try {
    return await new Promise<unknown>((resolve, reject) => {
      let completed = false;
      const finish = (error: StoreNodeError | null, value?: unknown) => {
        if (completed) return; completed = true; clearTimeout(timer); options.signal?.removeEventListener("abort", cancel);
        if (error) reject(error); else resolve(value);
      };
      const req = request(new URL(options.path, origin), { method: "POST", ca: options.caCertificatePem, minVersion: "TLSv1.3", allowPartialTrustChain: true,
        rejectUnauthorized: true, ...(options.certificatePem && options.encryptedPrivateKeyPem ? { cert: options.certificatePem,
          key: options.encryptedPrivateKeyPem, passphrase: options.passphrase } : {}),
        agent: false, headers: { "Content-Type": "application/json", "Content-Length": bytes.length, Connection: "close" } }, response => {
        const chunks: Buffer[] = []; let total = 0;
        if (response.statusCode !== 200 && response.statusCode !== 201) {
          response.resume(); finish(new StoreNodeError(response.statusCode === 409 ? "store_node_reissue_required"
            : response.statusCode === 401 || response.statusCode === 403 ? "store_node_authority_rejected" : "store_node_response_unknown")); return;
        }
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers["content-type"] ?? "")
          || response.headers["content-encoding"] || (response.headers["content-length"] && (!/^\d+$/.test(response.headers["content-length"])
            || Number(response.headers["content-length"]) > 65536))) { response.destroy(); finish(new StoreNodeError("store_node_response_invalid")); return; }
        response.on("data", (chunk: Buffer) => { total += chunk.length; if (total > 65536) { response.destroy(); finish(new StoreNodeError("store_node_response_invalid")); } else chunks.push(chunk); });
        response.once("error", () => { for (const chunk of chunks) chunk.fill(0); finish(new StoreNodeError("store_node_response_unknown")); });
        response.once("end", () => {
          const body = Buffer.concat(chunks); for (const chunk of chunks) chunk.fill(0);
          try { const value: unknown = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(body)); finish(null, value); }
          catch { finish(new StoreNodeError("store_node_response_invalid")); } finally { body.fill(0); }
        });
      });
      const cancel = () => { req.destroy(); finish(new StoreNodeError("store_node_cancelled")); };
      const timer = setTimeout(() => { req.destroy(); finish(new StoreNodeError("store_node_response_unknown")); }, 10000);
      options.signal?.addEventListener("abort", cancel, { once: true });
      req.once("error", () => finish(new StoreNodeError("store_node_response_unknown")));
      if (options.signal?.aborted) cancel(); else req.end(bytes);
    });
  } finally { bytes.fill(0); }
}
