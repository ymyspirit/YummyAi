import { ConflictException } from "@nestjs/common";

export function assertSkuSpecCompatible(
  skuCode: string,
  attributes: Record<string, string>,
  spec: { id: string; aspectWidth: number; aspectHeight: number },
) {
  if (attributes.canvas_print_spec_version_id) {
    if (attributes.canvas_print_spec_version_id !== spec.id) throw new ConflictException(`SKU ${skuCode} is bound to a different canvas print specification`);
    return;
  }
  const expectedRatio = spec.aspectWidth / spec.aspectHeight;
  if (attributes.canvas_aspect_ratio) {
    const [width, height] = attributes.canvas_aspect_ratio.split(":").map(Number);
    if (width && height && Math.abs(width / height - expectedRatio) / expectedRatio <= 0.02) return;
  }
  const widthMm = Number(attributes.canvas_width_mm);
  const heightMm = Number(attributes.canvas_height_mm);
  if (widthMm > 0 && heightMm > 0 && Math.abs(widthMm / heightMm - expectedRatio) / expectedRatio <= 0.02) return;
  throw new ConflictException(`SKU ${skuCode} is missing compatible canvas print specification attributes`);
}
