import type { CustomizationDefinition, AmazonReportFileView } from "@yummyai/contracts";
import { ORDER_WORK_IMAGE_PENDING_USAGE, type OrderWorkDraft } from "@yummyai/contracts/order/workspace";

/** An unsaved starting selection, never a replacement for a saved decision. */
export function defaultOrderWorkImages(
  files: readonly AmazonReportFileView[],
  customization?: CustomizationDefinition,
): OrderWorkDraft["images"] {
  const imageFields = customization?.fields.filter(field => field.type === "image") ?? [];
  const usage = imageFields.length === 1 ? imageFields[0]!.key : ORDER_WORK_IMAGE_PENDING_USAGE;
  const seen = new Set<string>();
  return files.filter(file => {
    if (file.role !== "buyer_image" || !file.originalFileKey || !file.mediaType.startsWith("image/") || seen.has(file.key)) return false;
    seen.add(file.key);
    return true;
  }).slice(0, 30).map(file => ({ origin: "report", key: file.key, usage }));
}
