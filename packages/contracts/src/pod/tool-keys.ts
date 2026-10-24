import { z } from "zod";

export const PodP1ExecutableToolKeySchema = z.enum([
  "pattern_crop",
  "print_extract",
  "background_remove",
  "super_resolution",
  "outpaint",
  "crop_compress",
  "vectorize",
  "authorized_watermark_remove",
  "rights_risk_scan",
]);

export const PodP2ExecutableToolKeySchema = z.enum([
  "design_variation",
  "product_print_variation",
  "instruction_edit",
  "text_to_image",
  "element_fusion",
  "licensed_brand_fusion",
  "series_design",
  "style_reference",
  "style_transfer",
  "canvas_extend",
  "seamless_pattern",
  "seamless_stitch",
  "print_composite",
  "meme_print",
  "product_suite",
  "title_draft",
  "virtual_try_on",
  "background_replace",
]);

export const PodP3ExecutableToolKeySchema = z.enum([
  "product_video",
  "piece_extract",
  "piece_compose",
  "uv_layers",
]);

export const PodExecutableToolKeySchema = z.enum([
  ...PodP1ExecutableToolKeySchema.options,
  ...PodP2ExecutableToolKeySchema.options,
  ...PodP3ExecutableToolKeySchema.options,
]);
