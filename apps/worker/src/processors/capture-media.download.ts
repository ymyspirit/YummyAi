import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { knowledgeOfficialUrl, knowledgePublicAddress } from "@yummyai/knowledge-core";
import sharp from "sharp";

export class CaptureMediaError extends Error {
  constructor(readonly code: string, readonly retryable = false) { super(code); }
}
type Address = { address: string; family: number };
type MediaResponse = { status: number; location?: string; mediaType: string; body: Uint8Array };
export interface MediaDownloadTransport {
  resolve(hostname: string): Promise<Address[]>;
  read(url: URL, address: Address, limits: { expires: number; maxBytes: number }): Promise<MediaResponse>;
}
export function captureMediaUrl(value: string, platform: string): URL {
  let url: URL;
  try { url = knowledgeOfficialUrl(value); } catch { throw new CaptureMediaError("MEDIA_URL_UNSAFE"); }
  const roots = platform === "amazon" ? ["media-amazon.com", "ssl-images-amazon.com", "images-amazon.com"]
    : platform === "etsy" ? ["i.etsystatic.com", "v.etsystatic.com"] : [];
  if (!roots.some((root) => url.hostname === root || url.hostname.endsWith(`.${root}`)))
    throw new CaptureMediaError("MEDIA_CDN_UNSUPPORTED");
  return url;
}

export class CaptureMediaDownloader {
  constructor(private readonly transport: MediaDownloadTransport = {
    resolve: (hostname) => lookup(hostname, { all: true }), read: readPinnedMedia,
  }) {}

  async download(sourceUrl: string, platform: string, kind: string) {
    const maxBytes = kind === "video" ? 50 * 1024 * 1024 : 12 * 1024 * 1024;
    const expires = Date.now() + 30_000;
    let url = captureMediaUrl(sourceUrl, platform);
    for (let redirect = 0; redirect <= 3; redirect++) {
      const addresses = await boundedResolve(this.transport.resolve(url.hostname), expires);
      if (!addresses.length || addresses.some(({ address }) => !knowledgePublicAddress(address)))
        throw new CaptureMediaError("MEDIA_ADDRESS_UNSAFE");
      const response = await this.transport.read(url, addresses[0]!, { expires, maxBytes });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.location || redirect === 3) throw new CaptureMediaError("MEDIA_REDIRECT_INVALID");
        url = captureMediaUrl(new URL(response.location, url).href, platform);
        continue;
      }
      if (response.status !== 200)
        throw new CaptureMediaError("MEDIA_HTTP_FAILED", response.status === 429 || response.status >= 500);
      if (!response.body.byteLength || response.body.byteLength > maxBytes)
        throw new CaptureMediaError("MEDIA_SIZE_INVALID");
      return { body: response.body, mediaType: response.mediaType.split(";")[0]!.trim().toLowerCase() };
    }
    throw new CaptureMediaError("MEDIA_REDIRECT_INVALID");
  }
}

export async function inspectCaptureMedia(body: Uint8Array, mediaType: string, kind: string) {
  if (kind === "image") {
    try {
      const image = sharp(body, { limitInputPixels: 16_000_000, failOn: "warning" });
      const metadata = await image.metadata();
      const formats: Record<string, { type: string; extension: string }> = {
        jpeg: { type: "image/jpeg", extension: "jpg" }, png: { type: "image/png", extension: "png" },
        webp: { type: "image/webp", extension: "webp" }, gif: { type: "image/gif", extension: "gif" },
      };
      const detected = metadata.format ? formats[metadata.format] : undefined;
      if (!detected || !metadata.width || !metadata.height || (metadata.pages ?? 1) > 1 || detected.type !== mediaType)
        throw new CaptureMediaError("MEDIA_TYPE_INVALID");
      await image.stats(); // Force bounded decoding; metadata alone accepts truncated images.
      return detected;
    } catch (error) {
      if (error instanceof CaptureMediaError) throw error;
      throw new CaptureMediaError("MEDIA_IMAGE_INVALID");
    }
  }
  const bytes = Buffer.from(body);
  // Video remains a distinct research artifact. These are container/signature checks,
  // not proof of playback, duration, codec compatibility, or production acceptance.
  if (kind === "video" && bytes.length >= 32) {
    if (mediaType === "video/mp4" && bytes.toString("ascii", 4, 8) === "ftyp"
      && bytes.readUInt32BE(0) >= 16 && bytes.readUInt32BE(0) <= bytes.length)
      return { type: mediaType, extension: "mp4" };
    if (mediaType === "video/webm" && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))
      return { type: mediaType, extension: "webm" };
  }
  throw new CaptureMediaError("MEDIA_TYPE_INVALID");
}

async function boundedResolve(pending: Promise<Address[]>, expires: number): Promise<Address[]> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CaptureMediaError("MEDIA_FETCH_TIMEOUT", true)), Math.max(1, expires - Date.now()));
    })]);
  } catch (error) {
    if (error instanceof CaptureMediaError) throw error;
    throw new CaptureMediaError("MEDIA_DNS_FAILED", true);
  } finally { clearTimeout(timer!); }
}

function readPinnedMedia(url: URL, address: Address, limits: { expires: number; maxBytes: number }): Promise<MediaResponse> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: "GET", headers: { Accept: "image/*,video/mp4,video/webm", "Accept-Encoding": "identity", "User-Agent": "YummyAI-Research/1.0" },
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [address]); else callback(null, address.address, address.family);
      },
    }, (res) => {
      if (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") {
        req.destroy(new CaptureMediaError("MEDIA_ENCODING_UNSUPPORTED")); return;
      }
      if (Number(res.headers["content-length"] ?? 0) > limits.maxBytes) {
        req.destroy(new CaptureMediaError("MEDIA_SIZE_INVALID")); return;
      }
      if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
        resolve({ status: res.statusCode!, ...(res.headers.location ? { location: res.headers.location } : {}), mediaType: "", body: new Uint8Array() });
        res.destroy(); return;
      }
      const chunks: Buffer[] = []; let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > limits.maxBytes) req.destroy(new CaptureMediaError("MEDIA_SIZE_INVALID")); else chunks.push(chunk);
      });
      res.once("error", reject);
      res.once("aborted", () => reject(new CaptureMediaError("MEDIA_FETCH_FAILED", true)));
      res.once("end", () => resolve({ status: res.statusCode ?? 0, mediaType: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks) }));
    });
    const timer = setTimeout(() => req.destroy(new CaptureMediaError("MEDIA_FETCH_TIMEOUT", true)), Math.max(1, limits.expires - Date.now()));
    req.once("error", (error) => reject(error instanceof CaptureMediaError ? error : new CaptureMediaError("MEDIA_FETCH_FAILED", true)));
    req.once("close", () => clearTimeout(timer));
    req.end();
  });
}
