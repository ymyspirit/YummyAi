import { Socket } from "node:net";

import type { RecordCustomizationFileScanInput } from "@yummyai/contracts";

import type { MalwareScanner } from "../processors/customization-file-scan.processor.js";

export class ClamAvScanner implements MalwareScanner {
  readonly engine = "clamav-clamd";
  private versionPromise?: Promise<string>;

  constructor(
    private readonly host = process.env.CLAMAV_HOST ?? "127.0.0.1",
    private readonly port = Number.parseInt(process.env.CLAMAV_PORT ?? "3310", 10),
    private readonly timeoutMs = Number.parseInt(process.env.CLAMAV_TIMEOUT_MS ?? "30000", 10),
  ) {}

  async scan(input: { body: Uint8Array; fileName: string; mediaType: string }): Promise<RecordCustomizationFileScanInput> {
    const [response, signatureVersion] = await Promise.all([
      this.request(streamParts(input.body)),
      this.version(),
    ]);
    const normalized = response.replace(/\0/g, "").trim();
    const result = normalized.endsWith("FOUND") ? "infected" : normalized.endsWith("OK") ? "clean" : "failed";
    return { result, engine: this.engine, signatureVersion, scannedAt: new Date().toISOString() };
  }

  private version(): Promise<string> {
    this.versionPromise ??= this.request([Buffer.from("zVERSION\0")])
      .then((value) => value.replace(/\0/g, "").trim().slice(0, 160) || "unknown")
      .catch(() => "unavailable");
    return this.versionPromise;
  }

  private request(parts: readonly Uint8Array[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const chunks: Buffer[] = [];
      let responseBytes = 0;
      socket.setTimeout(this.timeoutMs);
      socket.on("data", (chunk: Buffer) => {
        responseBytes += chunk.byteLength;
        if (responseBytes > 16_384) {
          socket.destroy(new Error("ClamAV response exceeded the evidence limit"));
          return;
        }
        chunks.push(chunk);
      });
      socket.once("timeout", () => socket.destroy(new Error("ClamAV scan timed out")));
      socket.once("error", reject);
      socket.once("close", (hadError) => {
        if (!hadError) resolve(Buffer.concat(chunks).toString("utf8"));
      });
      socket.connect(this.port, this.host, () => {
        for (const part of parts) socket.write(part);
        socket.end();
      });
    });
  }
}

function streamParts(body: Uint8Array): Uint8Array[] {
  const parts: Uint8Array[] = [Buffer.from("zINSTREAM\0")];
  for (let offset = 0; offset < body.byteLength; offset += 64 * 1024) {
    const chunk = body.subarray(offset, Math.min(offset + 64 * 1024, body.byteLength));
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(chunk.byteLength);
    parts.push(length, chunk);
  }
  parts.push(Buffer.alloc(4));
  return parts;
}
