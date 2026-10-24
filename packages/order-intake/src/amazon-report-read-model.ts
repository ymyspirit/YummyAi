import sharp from "sharp";
import type { AmazonReportDetailView } from "@yummyai/contracts";
import type { AmazonCustomDocument } from "./amazon-custom-archive.js";
import type { ParsedAmazonReportLine } from "./amazon-report-parser.js";

export type StoredFile = {
  key: string;
  name: string;
  mediaType: string;
  role: "preview" | "buyer_image" | "source";
  contentBase64: string;
  byteSize: number;
  originalFileKey?: string;
  width?: number;
  height?: number;
};
export type StoredDocument = {
  parserRevision?: number;
  document: AmazonCustomDocument;
  files: StoredFile[];
};
export type StoredSource = { line: ParsedAmazonReportLine; marketplaceId: string; warnings: string[] };
export type ReviewMetadata = Pick<AmazonReportDetailView, "surfaces" | "files" | "warnings">;
export type ReadModel = { metadata: ReviewMetadata; thumbnails: StoredFile[] };

export async function createAmazonReportReadModel(stored: StoredDocument): Promise<ReadModel> {
    const metadata: ReviewMetadata = {
      surfaces: stored.document.surfaces,
      warnings: stored.document.warnings,
      files: stored.files.map(
        ({ key, name, mediaType, role, byteSize, originalFileKey, width, height }) => ({
          key,
          name,
          mediaType,
          role,
          byteSize,
          originalFileKey,
          width,
          height,
        }),
      ),
    };
    const thumbnails: StoredFile[] = [];
    for (const file of stored.files) {
      if (!["preview", "buyer_image"].includes(file.role) || file.mediaType !== "image/png")
        continue;
      const { data, info } = await sharp(Buffer.from(file.contentBase64, "base64"))
        .resize({ width: 320, height: 320, fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer({ resolveWithObject: true });
      thumbnails.push({
        ...file,
        contentBase64: data.toString("base64"),
        byteSize: data.length,
        width: info.width,
        height: info.height,
      });
    }
    return { metadata, thumbnails };
  }


