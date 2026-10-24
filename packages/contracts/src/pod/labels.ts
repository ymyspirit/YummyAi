import type { PodExecutableToolKey } from "./pod.js";

export const POD_TOOL_LABELS: Readonly<Record<PodExecutableToolKey, string>> = {
  pattern_crop: "图案裁剪",
  print_extract: "印花图提取",
  background_remove: "一键抠图",
  super_resolution: "超分提质",
  outpaint: "扩图",
  crop_compress: "裁剪压缩",
  vectorize: "转矢量图",
  authorized_watermark_remove: "授权素材去水印",
  rights_risk_scan: "侵权风险检查",
  design_variation: "图裂变",
  product_print_variation: "商品图裂变",
  instruction_edit: "全能改图",
  text_to_image: "文生图",
  element_fusion: "元素融合",
  licensed_brand_fusion: "授权品牌/IP 元素融合",
  series_design: "多联图与系列图",
  style_reference: "风格参考",
  style_transfer: "风格转绘",
  canvas_extend: "尺寸延展",
  seamless_pattern: "连续图生成",
  seamless_stitch: "连续图拼接",
  print_composite: "印花合成",
  meme_print: "梗图印花",
  product_suite: "商品套图",
  title_draft: "标题提取与标题草稿",
  virtual_try_on: "模特试衣",
  background_replace: "换背景",
  product_video: "商品短视频",
  piece_extract: "裁片图提取",
  piece_compose: "裁片图合成",
  uv_layers: "UV 智能分层",
};

export function podToolLabel(key: PodExecutableToolKey, compact = false): string {
  if (compact && key === "seamless_pattern") return "连续图";
  if (compact && key === "title_draft") return "标题草稿";
  return POD_TOOL_LABELS[key];
}
