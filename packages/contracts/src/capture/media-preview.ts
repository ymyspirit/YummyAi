import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { CaptureMediaArchiveViewSchema, CaptureStatusSchema } from "@yummyai/contracts/capture";

export const CaptureMediaFailureCodeSchema = z.enum([
  "MEDIA_URL_UNSAFE",
  "MEDIA_CDN_UNSUPPORTED",
  "MEDIA_ADDRESS_UNSAFE",
  "MEDIA_REDIRECT_INVALID",
  "MEDIA_HTTP_FAILED",
  "MEDIA_SIZE_INVALID",
  "MEDIA_TYPE_INVALID",
  "MEDIA_IMAGE_INVALID",
  "MEDIA_FETCH_TIMEOUT",
  "MEDIA_DNS_FAILED",
  "MEDIA_ENCODING_UNSUPPORTED",
  "MEDIA_FETCH_FAILED",
  "MEDIA_SCAN_INFECTED",
  "MEDIA_SCAN_UNAVAILABLE",
  "MEDIA_STORAGE_IDENTITY_INVALID",
  "MEDIA_ACCESS_REVOKED",
  "MEDIA_RESEARCH_UNAVAILABLE",
  "MEDIA_ARCHIVE_UNAVAILABLE",
  "MEDIA_ATTEMPTS_EXHAUSTED",
  "MEDIA_LEASE_EXPIRED",
  "MEDIA_QUEUE_UNAVAILABLE",
  "MEDIA_FAILED",
]);
export function captureMediaFailureCode(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = CaptureMediaFailureCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : "MEDIA_FAILED";
}
export function captureMediaFailureMessage(value: unknown): string | null {
  const code = captureMediaFailureCode(value);
  if (!code) return null;
  return (
    {
      MEDIA_URL_UNSAFE: "原媒体地址未通过安全检查",
      MEDIA_CDN_UNSUPPORTED: "当前不支持此媒体来源",
      MEDIA_ADDRESS_UNSAFE: "媒体来源的网络地址未通过安全检查",
      MEDIA_REDIRECT_INVALID: "媒体来源的跳转未通过检查",
      MEDIA_HTTP_FAILED: "公开来源暂未返回可用媒体",
      MEDIA_SIZE_INVALID: "媒体大小超限或内容长度无效",
      MEDIA_TYPE_INVALID: "媒体类型与文件内容不符或暂不支持",
      MEDIA_IMAGE_INVALID: "图片无法安全解码",
      MEDIA_FETCH_TIMEOUT: "读取公开来源超时",
      MEDIA_DNS_FAILED: "暂时无法解析媒体来源",
      MEDIA_ENCODING_UNSUPPORTED: "媒体来源使用了不支持的传输编码",
      MEDIA_FETCH_FAILED: "媒体传输未完成",
      MEDIA_SCAN_INFECTED: "文件未通过病毒扫描",
      MEDIA_SCAN_UNAVAILABLE: "扫描服务暂不可用 等待后台恢复",
      MEDIA_STORAGE_IDENTITY_INVALID: "归档文件身份校验未通过",
      MEDIA_ACCESS_REVOKED: "原采集人的权限或资料范围已变化",
      MEDIA_RESEARCH_UNAVAILABLE: "原研究资料已归档或暂不可用",
      MEDIA_ARCHIVE_UNAVAILABLE: "归档服务暂不可用",
      MEDIA_ATTEMPTS_EXHAUSTED: "已达到归档尝试次数上限",
      MEDIA_LEASE_EXPIRED: "上次归档中断 等待后台核对",
      MEDIA_QUEUE_UNAVAILABLE: "已保存媒体记录 等待后台派发",
      MEDIA_FAILED: "媒体归档未完成 请核对原资料后重新采集",
    } as Record<string, string>
  )[code]!;
}
export const CaptureMediaPreviewSchema = CaptureMediaArchiveViewSchema.omit({
  sourceUrl: true,
  failureReason: true,
}).extend({
  failureReason: CaptureMediaFailureCodeSchema.nullable(),
  sourceIndex: z.int().nonnegative().nullable(),
});
export const CaptureMediaPageSchema = z
  .object({
    snapshotId: EntityIdSchema,
    researchItemId: EntityIdSchema,
    captureStatus: z.enum(["normalizing", "complete", "partial", "failed"]),
    fieldCaptureStatus: CaptureStatusSchema.nullable(),
    archivedItem: z.boolean(),
    canReadArchive: z.boolean(),
    counts: z.object({
      queued: z.int().nonnegative(),
      processing: z.int().nonnegative(),
      archived: z.int().nonnegative(),
      excluded: z.int().nonnegative(),
      failed: z.int().nonnegative(),
    }),
    kinds: z.object({ image: z.int().nonnegative(), video: z.int().nonnegative() }),
    total: z.int().nonnegative(),
    nextCursor: EntityIdSchema.nullable(),
    media: z.array(CaptureMediaPreviewSchema).max(100),
  })
  .refine(
    (value) =>
      Object.values(value.counts).reduce((sum, count) => sum + count, 0) === value.total &&
      value.kinds.image + value.kinds.video === value.total &&
      value.media.length <= value.total,
    "Media totals do not match",
  );
export const CaptureMediaReadLeaseSchema = z.object({
  url: z.url(),
  expiresInSeconds: z.literal(60),
  mediaType: z.enum([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "video/mp4",
    "video/webm",
  ]),
  byteSize: z
    .int()
    .positive()
    .max(50 * 1024 * 1024),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CaptureMediaPreview = z.infer<typeof CaptureMediaPreviewSchema>;
export type CaptureMediaPage = z.infer<typeof CaptureMediaPageSchema>;
