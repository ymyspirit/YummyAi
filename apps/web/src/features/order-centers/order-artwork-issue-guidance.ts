import type { ProductionEditorPreflightIssue } from "@yummyai/contracts/pod/production-editor";

export type ArtworkIssueGuidance = {
  title: string;
  instruction: string;
  location: string;
  inspector: "layer" | "process" | "confirm";
};

const guidanceByCode: Record<string, ArtworkIssueGuidance> = {
  insufficient_image_resolution: {
    title: "图片清晰度不足",
    instruction:
      "此项检查当前图层使用的素材，可能是处理后的图片，并非直接评判顾客原图。保持订单尺寸和图案比例，替换为内容一致、经核验的高清素材；暂无合格素材时交还制图者处理。修改 DPI 标签不会增加真实像素。",
    location: "生产编辑器 → 图层 → 替换所选图片 → 上传并替换／应用替换",
    inspector: "layer",
  },
  physical_size_unconfirmed: {
    title: "实际尺寸尚未确认",
    instruction:
      "按本单固定工厂要求核对实际尺寸与尺寸口径。有确认依据后，再勾选“实际尺寸与尺寸口径已由工厂确认”。",
    location: "生产编辑器 → 预检确认 → 生产前确认",
    inspector: "confirm",
  },
  white_border_unconfirmed: {
    title: "白边与黑裁线规则尚未确认",
    instruction:
      "按本单固定工厂要求核对当前稿的缝边白边与黑裁线，检查实际宽度及图案是否完整。确认符合要求后，再勾选“白边与黑裁线规则已确认”；切换工艺后的旧确认不能直接沿用。",
    location: "生产编辑器 → 预检确认 → 生产前确认",
    inspector: "confirm",
  },
  barcode_rule_unconfirmed: {
    title: "条码框尺寸与底部位置尚未确认",
    instruction:
      "按本单固定工厂要求核对空白条码框的宽、高，并检查是否连接主体最下方。尺寸或位置不符时先到“工艺”修正；确认符合要求后，再勾选“条码框宽、高、位置已确认”。",
    location: "生产编辑器 → 预检确认 → 生产前确认",
    inspector: "confirm",
  },
  visual_review_required: {
    title: "当前图稿尚未完成看图确认",
    instruction:
      "查看当前版本的后台预览，核对图案、文字、裁剪及正反片，再勾选“已查看当前图稿的后台校对预览”。尚无预览时先生成原尺寸待审稿。",
    location: "生产编辑器 → 预检确认 → 生产前确认",
    inspector: "confirm",
  },
  narrow_parts_unconfirmed: {
    title: "细窄部位尚未确认",
    instruction:
      "先核对“最细部位计量口径”，按已确认的工厂口径检查细窄部位不少于 50 mm，再到“预检确认”勾选“已按工厂口径人工检查最细部位”。不能降低最细部位要求来通过检查。",
    location: "生产编辑器 → 工艺 → 最细部位计量口径",
    inspector: "process",
  },
  back_text_unconfirmed: {
    title: "背片工艺与文字方向尚未确认",
    instruction:
      "检查双面稿的背片与文字方向，照片内的文字也需目视核对。发现反字先修图；确认符合要求后，勾选“背片工艺与文字阅读方向已确认”。",
    location: "生产编辑器 → 预检确认 → 生产前确认",
    inspector: "confirm",
  },
  manual_size_basis: {
    title: "尺寸口径提醒",
    instruction:
      "这是非阻断提醒，核对后仍可能保留。文件几何不能推断缝制后的实物尺寸，请按本单固定工厂口径留意，无需为清除此提示修改图稿。",
    location: "生产编辑器 → 工艺 → 尺寸口径",
    inspector: "process",
  },
  manual_factory_preflight: {
    title: "工厂工艺提醒",
    instruction:
      "这是非阻断提醒，核对后仍会保留。自动检查不能代替工厂对缝边、尺寸、细窄部位和缝制结果的确认，无需为清除此提示修改图稿。",
    location: "生产编辑器 → 工艺 → 工艺与尺寸",
    inspector: "process",
  },
  size_basis_unconfirmed: {
    title: "订单尺寸或测量口径未填写完整",
    instruction:
      "核对买家订单及固定工厂要求，填写“订单标称最长边（mm）”并确认“尺寸口径”。保持订单要求的尺寸，不凭估计选择口径。",
    location: "生产编辑器 → 工艺 → 尺寸口径／订单标称最长边（mm）",
    inspector: "process",
  },
  factory_size_basis: {
    title: "尺寸口径与工厂标准不符",
    instruction:
      "本单工厂标准按主体最长边确定尺寸，缝边、裁线和条码框另加。核对实际图案尺寸后，将“尺寸口径”设为“图案尺寸”；仅改选项不能代替尺寸核验。",
    location: "生产编辑器 → 工艺 → 尺寸口径",
    inspector: "process",
  },
};

/** Guidance never changes severity or marks a preflight issue as resolved. */
export function artworkIssueGuidance(issue: ProductionEditorPreflightIssue): ArtworkIssueGuidance {
  const guidance = Object.hasOwn(guidanceByCode, issue.code) ? guidanceByCode[issue.code] : undefined;
  return guidance
    ? { ...guidance }
    : {
        title: "检查结果",
        instruction: "按上方提示核查当前版本；无法判断时交还制图者处理，修改后重新检查生产参数。",
        location: "生产编辑器 → 预检与出图 → 检查生产参数",
        inspector: "confirm",
      };
}
