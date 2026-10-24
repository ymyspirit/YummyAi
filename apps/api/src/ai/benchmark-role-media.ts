import { ConflictException } from "@nestjs/common";
import { readAssistResearchImageBytes, type AssistContext } from "@yummyai/ai-core";
import sharp from "sharp";

export const BENCHMARK_RESEARCH_IMAGE_READER = Symbol("BENCHMARK_RESEARCH_IMAGE_READER");
export type BenchmarkResearchImageReader = (url: string) => Promise<Uint8Array>;

/** Publication and its preview encode the same real bytes as the native Worker.
 * No URL remains in a fixed basis, and a failed image never becomes a silent gap. */
export async function freezeBenchmarkRoleMedia(input: AssistContext, read: BenchmarkResearchImageReader = readAssistResearchImageBytes): Promise<AssistContext> {
  const provided = new Set(input.images.map(image => image.sourceId));
  if (input.request.kind === "sku_package" && input.listingMediaIds?.some(id => !provided.has(id)))
    throw new ConflictException("benchmark_media_unavailable");
  if (input.request.kind === "order_review" || input.request.kind === "artwork_preflight") {
    const order = input.data.order as { draft?: { images?: unknown[] } } | undefined;
    if (order?.draft?.images?.slice(0, 6).some((_, index) => !provided.has(`buyer-image:${index}`)))
      throw new ConflictException("benchmark_media_unavailable");
  }
  const images: AssistContext["images"] = [];
  for (const image of input.images) {
    if (image.dataUrl) {
      if (!image.dataUrl.startsWith("data:image/jpeg;base64,") || image.url) throw new ConflictException("benchmark_media_unavailable");
      images.push({ sourceId: image.sourceId, dataUrl: image.dataUrl });
      continue;
    }
    if (!image.url) throw new ConflictException("benchmark_media_unavailable");
    let bytes: Buffer | undefined;
    try {
      bytes = Buffer.from(await read(image.url));
      if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error("image_too_large");
      const encoded = await sharp(bytes, { limitInputPixels: 32_000_000 }).rotate()
        .resize(1024, 1024, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" })
        .jpeg({ quality: 85 }).toBuffer();
      try { images.push({ sourceId: image.sourceId, dataUrl: `data:image/jpeg;base64,${encoded.toString("base64")}` }); }
      finally { encoded.fill(0); }
    } catch { throw new ConflictException("benchmark_media_unavailable"); }
    finally { bytes?.fill(0); }
  }
  return { ...input, images };
}
