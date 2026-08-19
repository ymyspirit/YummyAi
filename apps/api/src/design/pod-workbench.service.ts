import { Injectable, Optional } from "@nestjs/common";
import {
  PodExecutableToolKeySchema,
  OrderPersonalizationRenderToolSchema,
  PodToolCatalogViewSchema,
  type PodToolCatalogView,
  type PodToolDefinition,
  type PodToolKey,
} from "@yummyai/contracts";

const phaseAvailability = {
  pod_1: "implementation_active",
  pod_2: "definition_ready",
  pod_3: "definition_ready",
} as const;

function tool(
  definition: Omit<PodToolDefinition, "availability">,
): PodToolDefinition {
  return {
    ...definition,
    availability: phaseAvailability[definition.phase],
  };
}

const catalog = PodToolCatalogViewSchema.parse({
  supportedMarketplaces: ["amazon", "etsy"],
  modules: [
    { key: "print_extraction", label: "印花提取", order: 1, phase: "pod_1" },
    { key: "print_design", label: "印花设计", order: 2, phase: "pod_2" },
    { key: "pattern_processing", label: "图案处理", order: 3, phase: "pod_1" },
    { key: "rights_risk", label: "侵权检测", order: 4, phase: "pod_1" },
    { key: "listing_assets", label: "套图&标题", order: 5, phase: "pod_2" },
    { key: "personalization", label: "来图定制", order: 6, phase: "pod_3" },
    { key: "production_artwork", label: "生产图", order: 7, phase: "pod_3" },
  ],
  tools: [
    tool({
      key: "pattern_crop", module: "print_extraction", label: "图案裁剪",
      description: "从 1–100 张已授权商品图中校正透视并裁剪单个或多个图案，逐结果保留范围与文件证据。",
      phase: "pod_1", assetPolicy: "authorized_only", inputKinds: ["image"], outputKinds: ["image", "transparent_image"],
      parameterSummary: ["通用/铁皮画/装饰画", "多图上限", "格式/背景", "留白", "结果标签"],
    }),
    tool({
      key: "print_extract", module: "print_extraction", label: "印花图提取",
      description: "校正透视、褶皱和弯曲并补全遮挡区域，逐文件验证完整度且 AI 推断区域不可取消标记。",
      phase: "pod_1", assetPolicy: "authorized_only", inputKinds: ["image"], outputKinds: ["image", "transparent_image"],
      parameterSummary: ["专项/全能/透明底", "商品场景", "校正强度", "完整度", "AI 区域标记"],
    }),
    tool({
      key: "design_variation", module: "print_design", label: "图裂变",
      description: "基于授权图案生成保持主题或构图约束的多个设计版本。",
      phase: "pod_2", assetPolicy: "authorized_only", inputKinds: ["image", "text"], outputKinds: ["image"],
      parameterSummary: ["参考强度", "创意程度", "比例", "数量"],
    }),
    tool({
      key: "product_print_variation", module: "print_design", label: "商品图裂变",
      description: "从授权商品图提取设计方向并形成适配目标品类的新图案版本。",
      phase: "pod_2", assetPolicy: "authorized_only", inputKinds: ["image", "text"], outputKinds: ["image"],
      parameterSummary: ["目标品类", "参考强度", "创意程度", "数量"],
    }),
    tool({
      key: "instruction_edit", module: "print_design", label: "全能改图",
      description: "使用文字指令替换元素、背景或局部内容，并保留输入和参数版本。",
      phase: "pod_2", assetPolicy: "authorized_only", inputKinds: ["image", "text"], outputKinds: ["image", "transparent_image"],
      parameterSummary: ["编辑指令", "保留区域", "输出比例", "种子"],
    }),
    tool({
      key: "text_to_image", module: "print_design", label: "文生图",
      description: "从提示词生成可追溯的印花设计草案，生成结果必须进入人工审核。",
      phase: "pod_2", assetPolicy: "authorized_only", inputKinds: ["text"], outputKinds: ["image"],
      parameterSummary: ["提示词", "批量提示词", "比例", "数量", "种子"],
    }),
    tool({
      key: "element_fusion", module: "print_design", label: "元素融合",
      description: "融合多份自有或授权元素，并记录每份输入资产的权利来源。",
      phase: "pod_2", assetPolicy: "authorized_only", inputKinds: ["image", "text"], outputKinds: ["image"],
      parameterSummary: ["主体元素", "辅助元素", "融合强度", "数量"],
    }),
    tool({
      key: "licensed_brand_fusion", module: "print_design", label: "授权品牌/IP 元素融合",
      description: "仅在品牌或 IP 授权已批准时融合授权元素，授权状态不合格时阻断任务。",
      phase: "pod_2", assetPolicy: "authorized_only", inputKinds: ["image", "text"], outputKinds: ["image"],
      parameterSummary: ["授权范围", "融合强度", "使用场景", "数量"],
    }),
    tool({
      key: "series_design", module: "print_design", label: "多联图与系列图",
      description: "生成主副图、系列图或情侣图，并维护各结果之间的系列关系。",
      phase: "pod_2", assetPolicy: "authorized_only", inputKinds: ["image", "text"], outputKinds: ["image"],
      parameterSummary: ["系列类型", "联数", "一致性", "数量"],
    }),
    tool({
      key: "style_reference", module: "print_design", label: "风格参考",
      description: "参考授权素材的视觉风格生成新设计，内容与参考来源分别追溯。",
      phase: "pod_2", assetPolicy: "authorized_only", inputKinds: ["image", "text"], outputKinds: ["image"],
      parameterSummary: ["风格强度", "内容提示词", "比例", "数量"],
    }),
    tool({
      key: "style_transfer", module: "print_design", label: "风格转绘",
      description: "在保持主体约束的前提下转换授权图片的绘制风格。",
      phase: "pod_2", assetPolicy: "authorized_only", inputKinds: ["image", "text"], outputKinds: ["image"],
      parameterSummary: ["目标风格", "主体保留", "背景处理", "数量"],
    }),
    tool({
      key: "canvas_extend", module: "print_design", label: "尺寸延展",
      description: "扩展画布并生成衔接内容，保留原始区域和 AI 扩展区域边界。",
      phase: "pod_2", assetPolicy: "authorized_only", inputKinds: ["image"], outputKinds: ["image"],
      parameterSummary: ["目标尺寸", "延展方向", "构图锁定"],
    }),
    tool({
      key: "seamless_pattern", module: "print_design", label: "连续图生成",
      description: "生成四方连续图或二方连续图，并输出可验证的无缝拼接结果。",
      phase: "pod_2", assetPolicy: "authorized_only", inputKinds: ["image", "text"], outputKinds: ["image"],
      parameterSummary: ["连续类型", "元素密度", "底色", "单元尺寸"],
    }),
    tool({
      key: "seamless_stitch", module: "print_design", label: "连续图拼接",
      description: "批量拼接连续图单元并检查接缝、偏移和重复节奏。",
      phase: "pod_2", assetPolicy: "authorized_only", inputKinds: ["image"], outputKinds: ["image"],
      parameterSummary: ["横向数量", "纵向数量", "偏移方式", "画布尺寸"],
    }),
    tool({
      key: "print_composite", module: "print_design", label: "印花合成",
      description: "将授权图案批量合成到目标印花版式并形成可复用配方。",
      phase: "pod_2", assetPolicy: "authorized_only", inputKinds: ["image", "template"], outputKinds: ["image"],
      parameterSummary: ["版式", "比例", "边距", "批量数量"],
    }),
    tool({
      key: "meme_print", module: "print_design", label: "梗图印花",
      description: "组合自有文案与授权视觉元素，生成可审核的梗图印花版本。",
      phase: "pod_2", assetPolicy: "authorized_only", inputKinds: ["image", "text"], outputKinds: ["image"],
      parameterSummary: ["文案", "版式", "字体", "数量"],
    }),
    tool({
      key: "background_remove", module: "pattern_processing", label: "一键抠图",
      description: "提取主体并输出透明通道，保留边缘质量与人工修订状态。",
      phase: "pod_1", assetPolicy: "authorized_only", inputKinds: ["image"], outputKinds: ["transparent_image"],
      parameterSummary: ["主体类型", "边缘细化", "背景色"],
    }),
    tool({
      key: "super_resolution", module: "pattern_processing", label: "超分提质",
      description: "提升授权图案分辨率并记录放大倍数、模型版本和质量检查。",
      phase: "pod_1", assetPolicy: "authorized_only", inputKinds: ["image"], outputKinds: ["image"],
      parameterSummary: ["放大倍数", "降噪强度", "锐化强度", "DPI"],
    }),
    tool({
      key: "outpaint", module: "pattern_processing", label: "扩图",
      description: "扩展图片边界并标记 AI 生成区域，原始输入保持不可变。",
      phase: "pod_1", assetPolicy: "authorized_only", inputKinds: ["image"], outputKinds: ["image"],
      parameterSummary: ["目标比例", "延展方向", "背景约束"],
    }),
    tool({
      key: "crop_compress", module: "pattern_processing", label: "裁剪压缩",
      description: "按目标尺寸裁剪并压缩图片，输出文件大小和格式检查结果。",
      phase: "pod_1", assetPolicy: "authorized_only", inputKinds: ["image"], outputKinds: ["image"],
      parameterSummary: ["宽高", "裁剪锚点", "文件格式", "质量", "DPI", "色彩模式"],
    }),
    tool({
      key: "vectorize", module: "pattern_processing", label: "转矢量图",
      description: "将授权位图转换为可编辑矢量路径并检查节点数量和闭合状态。",
      phase: "pod_1", assetPolicy: "authorized_only", inputKinds: ["image"], outputKinds: ["vector"],
      parameterSummary: ["颜色数量", "细节阈值", "路径平滑", "输出格式"],
    }),
    tool({
      key: "authorized_watermark_remove", module: "pattern_processing", label: "授权素材去水印",
      description: "仅处理自有或明确授权素材，权利来源未批准时阻断任务。",
      phase: "pod_1", assetPolicy: "authorized_only", inputKinds: ["image"], outputKinds: ["image"],
      parameterSummary: ["授权依据", "处理区域", "修复方式"],
    }),
    tool({
      key: "rights_risk_scan", module: "rights_risk", label: "侵权风险检查",
      description: "分开呈现法律风险线索与视觉相似度，输出证据、时间、模型版本和复核状态。",
      phase: "pod_1", assetPolicy: "risk_evidence_allowed", inputKinds: ["image", "text"], outputKinds: ["risk_report"],
      parameterSummary: ["基础过滤", "深度检查", "视觉相似度", "证据范围"],
    }),
    tool({
      key: "product_suite", module: "listing_assets", label: "商品套图",
      description: "生成 Amazon 或 Etsy 商品套图并映射到 Listing 图片槽位。",
      phase: "pod_2", assetPolicy: "authorized_only", inputKinds: ["image", "template", "text"], outputKinds: ["image", "template"],
      parameterSummary: ["平台", "品类", "套图模板", "图片槽位"],
    }),
    tool({
      key: "title_draft", module: "listing_assets", label: "标题提取与标题草稿",
      description: "基于商品事实和授权素材生成 Amazon 或 Etsy 标题草稿，提交前必须审核。",
      phase: "pod_2", assetPolicy: "authorized_only", inputKinds: ["image", "text"], outputKinds: ["text"],
      parameterSummary: ["平台", "语言", "商品事实", "关键词约束"],
    }),
    tool({
      key: "virtual_try_on", module: "listing_assets", label: "模特试衣",
      description: "将授权服装图案生成模特展示图并标记 AI 合成属性。",
      phase: "pod_2", assetPolicy: "authorized_only", inputKinds: ["image", "text"], outputKinds: ["image"],
      parameterSummary: ["模特要求", "场景", "视角", "比例"],
    }),
    tool({
      key: "background_replace", module: "listing_assets", label: "换背景",
      description: "保持商品主体并替换场景背景，结果可进入商品套图流程。",
      phase: "pod_2", assetPolicy: "authorized_only", inputKinds: ["image", "text"], outputKinds: ["image"],
      parameterSummary: ["背景描述", "主体保留", "光影匹配", "比例"],
    }),
    tool({
      key: "product_video", module: "listing_assets", label: "商品短视频",
      description: "从 1–20 张已授权商品图片生成带播放、字幕、音轨许可和输入覆盖证据的短视频。",
      phase: "pod_3", assetPolicy: "authorized_only", inputKinds: ["image", "text"], outputKinds: ["video"],
      parameterSummary: ["镜头与画幅", "H.264 MP4", "字幕安全区", "许可音轨", "AI 运动标记"],
    }),
    tool({
      key: "image_composite", module: "personalization", label: "图片合成",
      description: "将顾客图片编排到个性化模板，同名图片容器复用同一份输入。",
      phase: "pod_3", assetPolicy: "order_context_only", inputKinds: ["template", "order_customization"], outputKinds: ["image"],
      parameterSummary: ["模板", "图片容器", "填充方式", "输出尺寸"],
    }),
    tool({
      key: "group_photo", module: "personalization", label: "合照",
      description: "在订单私有域内组合顾客提供的人像，结果只关联对应订单。",
      phase: "pod_3", assetPolicy: "order_context_only", inputKinds: ["order_customization", "template"], outputKinds: ["image"],
      parameterSummary: ["人物顺序", "构图", "背景", "输出比例"],
    }),
    tool({
      key: "pet_outfit", module: "personalization", label: "宠物换装",
      description: "在订单私有域内将顾客宠物图适配到授权服装或场景模板。",
      phase: "pod_3", assetPolicy: "order_context_only", inputKinds: ["order_customization", "template"], outputKinds: ["image"],
      parameterSummary: ["宠物主体", "服装模板", "姿态保留", "背景"],
    }),
    tool({
      key: "personalization_template", module: "personalization", label: "来图定制模板",
      description: "创建空白模板或解析 PNG、PSD 模板，并显式绑定商品、SKU 和尺寸。",
      phase: "pod_3", assetPolicy: "authorized_only", inputKinds: ["template", "psd", "image"], outputKinds: ["template"],
      parameterSummary: ["四类 PSD 分组", "容器命名", "文字字段", "SKU 绑定", "尺寸"],
    }),
    tool({
      key: "piece_extract", module: "production_artwork", label: "裁片图提取",
      description: "从授权商品或模板中提取裁片并记录裁片命名、印刷区域和缝纫线。",
      phase: "pod_3", assetPolicy: "authorized_only", inputKinds: ["image", "template"], outputKinds: ["image", "production_package"],
      parameterSummary: ["分版/合版", "稳定裁片键", "边界来源", "置信度", "模板草稿"],
    }),
    tool({
      key: "piece_compose", module: "production_artwork", label: "裁片图合成",
      description: "按定位模板合成裁片并执行缩放、填充、拉伸和文件质量检查。",
      phase: "pod_3", assetPolicy: "authorized_only", inputKinds: ["image", "template"], outputKinds: ["production_package"],
      parameterSummary: ["定位模板", "裁片键", "自动/手动排版", "最低 DPI", "逐片质量检查"],
    }),
    tool({
      key: "uv_layers", module: "production_artwork", label: "UV 智能分层",
      description: "拆分 UV 图层和通道，并保存自动结果与人工调整后的独立版本。",
      phase: "pod_3", assetPolicy: "authorized_only", inputKinds: ["image", "template"], outputKinds: ["production_package"],
      parameterSummary: ["分层方式", "稳定图层键", "通道顺序", "白墨/光油", "冲突复核"],
    }),
    tool({
      key: "fulfillment_composite", module: "production_artwork", label: "履约图合成",
      description: "将订单个性化结果编排为生产图，并生成不可变生产清单。",
      phase: "pod_3", assetPolicy: "order_context_only", inputKinds: ["order_customization", "template"], outputKinds: ["production_package"],
      parameterSummary: ["SKU 模板", "适配方式", "排版方式", "生产尺寸"],
    }),
    tool({
      key: "vector_fulfillment", module: "production_artwork", label: "履约矢量合成",
      description: "从批准的 SVG 模板和订单加密快照生成矢量生产文件，并以严格路径质量闸门阻断异常结果。",
      phase: "pod_3", assetPolicy: "order_context_only", inputKinds: ["vector", "order_customization", "template"], outputKinds: ["vector", "production_package"],
      parameterSummary: ["SVG 模板", "文字转路径", "镂空与连接桥", "路径修复", "不可变生产清单"],
    }),
  ],
  supportCapabilities: [
    {
      key: "task_center", label: "任务中心", description: "查看异步任务进度、重试、失败原因和审核状态。",
      phase: "pod_1", availability: "implementation_active",
    },
    {
      key: "asset_space", label: "我的空间", description: "按授权域、订单私有域和研究域隔离选择素材。",
      phase: "pod_1", availability: "implementation_active",
    },
    {
      key: "visual_search", label: "视觉检索", description: "使用视觉指纹查找租户内相关图片、商品和任务。",
      phase: "pod_1", availability: "implementation_active",
    },
    {
      key: "print_trace_search", label: "印花图检索", description: "按图片、任务、商品、SPU、SKU、Listing 和导出版本反查。",
      phase: "pod_1", availability: "implementation_active",
    },
  ],
});

@Injectable()
export class PodToolActivationPolicy {
  enabledTools(): ReadonlySet<PodToolKey> {
    const enabled = new Set<PodToolKey>();
    if (
      !process.env.POD_PROCESSOR_DEPLOYMENT_ID?.trim()
      || !process.env.POD_PROCESSOR_URL?.trim()
      || !process.env.POD_PROCESSOR_API_KEY?.trim()
    ) {
      // Generic tools remain disabled while order-context tools are evaluated independently below.
    } else {
      const values = process.env.POD_ENABLED_TOOLS?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
      for (const value of PodExecutableToolKeySchema.array().parse(values)) enabled.add(value);
    }
    if (
      process.env.POD_ORDER_PROCESSOR_DEPLOYMENT_ID?.trim()
      && process.env.POD_ORDER_PROCESSOR_URL?.trim()
      && process.env.POD_ORDER_PROCESSOR_API_KEY?.trim()
    ) {
      const values = process.env.POD_ORDER_ENABLED_TOOLS?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
      for (const value of OrderPersonalizationRenderToolSchema.array().parse(values)) enabled.add(value);
    }
    return enabled;
  }
}

@Injectable()
export class PodWorkbenchService {
  constructor(@Optional() private readonly activation?: PodToolActivationPolicy) {}

  getToolCatalog(): PodToolCatalogView {
    const enabled = this.activation?.enabledTools() ?? new Set<PodToolKey>();
    if (!enabled.size) return catalog;
    return PodToolCatalogViewSchema.parse({
      ...catalog,
      tools: catalog.tools.map((item) => enabled.has(item.key)
        ? { ...item, availability: "enabled" }
        : item),
    });
  }

  isToolEnabled(toolKey: PodToolKey): boolean {
    return this.getToolCatalog().tools.some((tool) => tool.key === toolKey && tool.availability === "enabled");
  }
}
