import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";

import { Injectable } from "@nestjs/common";
import type { RecordCustomizationFileScanInput } from "@yummyai/contracts";
import { ClamAvScanner } from "@yummyai/storage";

export const MAX_AMAZON_ARCHIVE_BYTES = 20 * 1024 * 1024;
export class AmazonArchiveAccessError extends Error {
  constructor(readonly code: string) { super(code); this.name = "AmazonArchiveAccessError"; }
}

export abstract class AmazonReportArchiveGateway {
  abstract download(url: string): Promise<Uint8Array>;
  abstract scan(body: Uint8Array): Promise<RecordCustomizationFileScanInput>;
}

@Injectable()
export class HttpAmazonReportArchiveGateway extends AmazonReportArchiveGateway {
  private readonly scanner = new ClamAvScanner();

  scan(body: Uint8Array) { return this.scanner.scan({ body, fileName: "customization.zip", mediaType: "application/zip" }); }

  async download(value: string): Promise<Uint8Array> {
    let url = safeAmazonArchiveUrl(value);
    const deadline = Date.now() + 30_000;
    for (let hop = 0; hop < 4; hop++) {
      let addresses: { address: string; family: number }[];
      try { addresses = await lookup(url.hostname, { all: true, verbatim: true }); }
      catch { throw new AmazonArchiveAccessError("download_failed"); }
      if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) throw new AmazonArchiveAccessError("unsafe_url");
      const address = addresses[0]!;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new AmazonArchiveAccessError("download_timeout");
      const result = await new Promise<{ body?: Uint8Array; location?: string }>((resolve, reject) => {
        const timer = setTimeout(() => req.destroy(new AmazonArchiveAccessError("download_timeout")), remaining);
        const req = request(url, {
          method: "GET", headers: { accept: "application/zip, application/octet-stream" },
          family: address.family,
          // Pin the validated address so a second DNS resolution cannot reach a private host.
          lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
        }, (response) => {
          const status = response.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status)) {
            response.resume(); resolve({ location: response.headers.location }); return;
          }
          if (status !== 200) {
            response.resume(); reject(new AmazonArchiveAccessError([401, 403, 404, 410].includes(status) ? "link_unavailable" : "download_failed")); return;
          }
          const length = Number(response.headers["content-length"] ?? 0);
          if (length > MAX_AMAZON_ARCHIVE_BYTES) { response.destroy(); reject(new AmazonArchiveAccessError("archive_too_large")); return; }
          const chunks: Buffer[] = [];
          let total = 0;
          response.on("data", (chunk: Buffer) => {
            total += chunk.byteLength;
            if (total > MAX_AMAZON_ARCHIVE_BYTES) { response.destroy(new AmazonArchiveAccessError("archive_too_large")); return; }
            chunks.push(chunk);
          });
          response.once("error", reject);
          response.once("end", () => resolve({ body: Buffer.concat(chunks) }));
        });
        req.once("error", (error) => reject(error instanceof AmazonArchiveAccessError ? error : new AmazonArchiveAccessError("download_failed")));
        req.once("close", () => clearTimeout(timer));
        req.end();
      });
      if (result.body) return result.body;
      if (!result.location) throw new AmazonArchiveAccessError("download_failed");
      url = safeAmazonArchiveUrl(new URL(result.location, url).href, true);
    }
    throw new AmazonArchiveAccessError("download_failed");
  }
}

export function safeAmazonArchiveUrl(value: string, redirect = false): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new AmazonArchiveAccessError("unsafe_url"); }
  const allowed = /^zme-caps\.amazon\.(com|co\.uk|de|fr|it|es|ca|com\.au|co\.jp)$/.test(url.hostname)
    || (redirect && /\.amazonaws\.com$/.test(url.hostname));
  if (!allowed || url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || url.hash) {
    throw new AmazonArchiveAccessError("unsafe_url");
  }
  return url;
}

export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a! >= 224 || (a === 100 && b! >= 64 && b! <= 127)
      || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && (b === 0 || b === 168))
      || (a === 198 && [18, 19, 51].includes(b!)) || (a === 203 && b === 0));
  }
  return version === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(db8|0*0):/i.test(address);
}
