export interface NavigationDestination {
  id: string;
  href: string;
  label: string;
  description: string;
  keywords: string;
  parentId?: string;
}

export const NAVIGATION_GROUPS = [
  { id: "overview", label: "总览", description: "业务概况与今日待办", items: [
    { id: "dashboard", href: "/", label: "运营总览", description: "查看今日待办、风险和业务概况", keywords: "首页 工作台 仪表盘 dashboard" },
  ] },
  { id: "research", label: "选品研究", description: "采集商品，研究竞争店铺", items: [
    { id: "research", href: "/research", label: "研究资料库", description: "查看采集商品、快照和分析报告", keywords: "选品 竞品 采集 抓取 插件 证据 分析报告 research" },
    { id: "competitors", href: "/competitors", label: "竞争店铺", description: "管理竞品店铺与研究记录", keywords: "竞品店铺 对标 竞争对手 competitor" },
  ] },
  { id: "creative", label: "创意设计", description: "原创设计、图片处理与生产作图", items: [
    { id: "print-library", href: "/print-library", label: "印花库", description: "从已审核创意登记独立印花 SKU，管理版本与研究来源", keywords: "印花 sku 素材 原创 主图案 版本" },
    { id: "creative-canvas", href: "/creative-designs/canvas", label: "创意项目", description: "配置创意与定制需求，设计审核后交付印花素材", keywords: "创意工作台 创意画布 infinite canvas 画布 工作流 插件 定制模板 印花素材" },
    { id: "studio-canvas", href: "/creative-designs/studio/canvas", label: "我的画布", description: "编辑与保存无限画布，关联创意项目", keywords: "infinite canvas 无限画布 节点 流程 导入 导出" },
    { id: "studio-image", href: "/creative-designs/studio/image", label: "生图工作台", description: "使用 ERP 模型生成和编辑图片", keywords: "AI 生图 图生图 图片 创作 绘画" },
    { id: "studio-video", href: "/creative-designs/studio/video", label: "视频创作台", description: "创作视频，跟进生成任务", keywords: "视频 video 首帧 广告" },
    { id: "studio-prompts", href: "/creative-designs/studio/prompts", label: "提示词库", description: "管理并调用常用提示词", keywords: "提示词 prompt 模板 收藏 文字" },
    { id: "studio-assets", href: "/creative-designs/studio/assets", label: "我的资产", description: "管理图片、视频和文字素材", keywords: "素材库 资产 图片 视频 收藏 审核" },
    { id: "production-editor", href: "/pod-workbench/production-editor", label: "生产文件与底稿", description: "管理生产稿、历史文件和通用工艺底稿", keywords: "生产作图 生产图 美工 编辑器 PNG JPG TIFF DPI 印刷 导出" },
  ] },
  { id: "catalog", label: "商品与刊登", description: "管理产品，准备商品刊登资料", items: [
    { id: "mockup-batches", href: "/pod-workbench/mockup-batches", label: "商品套图", description: "把已批准的正式设计套入商品场景模板", keywords: "批量套图 样机 效果图 PSD mockup 场景图" },
    { id: "product-specifications", href: "/product-specifications", label: "商品 SPU", description: "以 SPU 管理产品，在详情中维护多个规格、工艺和共用物料", keywords: "SPU 规格 空白品 材质 尺寸" },
    { id: "product-development", href: "/product-development", label: "产品开发", description: "组合印花与规格生成销售 SKU，制作套图并封存上架资料包", keywords: "组合 矩阵 销售SKU 上架 资料包 渠道 映射 版本" },
    { id: "process-library", href: "/process-library", label: "工艺底稿", description: "管理已审核的通用尺寸和制作模板", keywords: "工艺 模板 底稿 制作 印刷" },
    { id: "products", href: "/products", label: "产品目录", description: "管理产品企划、SPU、SKU 和产品事实", keywords: "商品 档案 款式 变体 规格 SKU SPU product" },
    { id: "workflows", href: "/workflows", label: "工作流中心", description: "管理流程模板，跟进产品任务与执行记录", keywords: "流程 SOP Amazon Custom 任务 编排 节点 workflow" },
    { id: "listings", href: "/listings", label: "刊登控制台", description: "编辑 Listing、检查资料并审阅导出包", keywords: "上架 刊登 listing 标题 文案 五点 导出包 发布" },
  ] },
  { id: "commerce", label: "订单与履约", description: "导入订单，跟进定制、生产和发货", items: [
    { id: "orders", href: "/orders", label: "订单中心", description: "导入报告、编辑定制需求、审单并推送制图", keywords: "订单履约 订单 工作台 搜索 筛选 审单 报告 FBM 定制 order" },
    { id: "order-artwork", href: "/order-artwork", label: "制图中心", description: "领取订单制图任务、审核文件与客户校样", keywords: "订单 生产文件 制图 制作 审核 校样" },
    { id: "production", href: "/production", label: "生产中心", description: "下达生产、跟进工厂进度、质检与补做", keywords: "生产 工厂 加工 质检 返工" },
    { id: "shipments", href: "/shipments", label: "发货中心", description: "安排包裹、记录交运并跟踪物流", keywords: "发货 包裹 物流 单号 运输 回传" },
    { id: "after-sales", href: "/after-sales", label: "售后中心", description: "跟进客户问题、沟通记录和处理方案", keywords: "售后 客诉 退款 补发 补做 退货" },
    { id: "stores", href: "/stores", label: "店铺运营", description: "管理自有店铺连接与授权状态", keywords: "我的店铺 账号 连接 授权 Amazon Etsy 设置 store" },
  ] },
  { id: "supply", label: "采购与库存", description: "采购补货、仓库库存与供应商", items: [
    { id: "suppliers", href: "/suppliers", label: "供应商档案", description: "新增和维护合作供应商资料", keywords: "新增 创建 供应商 工厂 合作 建档 supplier" },
    { id: "inventory", href: "/inventory", label: "库存台账", description: "查看仓库库存、预占与出入库记录", keywords: "仓库 数量 库存 入库 出库 盘点 stock" },
    { id: "procurement", href: "/procurement", label: "采购补货", description: "处理补货建议、采购单和到货验收", keywords: "供应商 工厂 采购 收货 缺货 补货 purchase" },
    { id: "supplier-performance", href: "/supplier-performance", label: "供应商绩效", description: "评估供应商交期、质量与履约表现", keywords: "工厂 供应商 评分 准时 质检 supplier" },
    { id: "channel-inventory", href: "/channel-inventory", label: "渠道库存", description: "核对各销售渠道的库存与差异", keywords: "FBA 亚马逊 仓库 渠道 同步 库存 对账" },
  ] },
  { id: "insights", label: "经营分析", description: "核对利润，分析广告与经营数据", items: [
    { id: "finance", href: "/finance", label: "财务利润", description: "核对费用、结算、成本和利润", keywords: "财务 收入 成本 结算 对账 利润 报表 finance" },
    { id: "customer-intelligence", href: "/customer-intelligence", label: "广告与 VOC", description: "分析广告表现、关键词和客户反馈", keywords: "广告 关键词 搜索词 客户 评论 评价 VOC ACoS ROAS" },
    { id: "operating-cockpit", href: "/operating-cockpit", label: "数据与集成", description: "查看经营指标、数据任务和集成状态", keywords: "API Webhook 集成 数据 任务 指标 告警 连接器 设置" },
  ] },
  { id: "settings", label: "系统配置", description: "管理共用服务与模型", items: [
    { id: "ai-settings", href: "/settings/ai", label: "AI 模型配置", description: "统一管理创作渠道、密钥和模型用途", keywords: "配置 设置 API key 模型 渠道 AI settings" },
  ] },
] as const satisfies ReadonlyArray<{ id: string; label: string; description: string; items: readonly NavigationDestination[] }>;

export type NavigationGroupId = (typeof NAVIGATION_GROUPS)[number]["id"];
// Stable business order: the daily fulfillment and design work comes first.
export const SIDEBAR_GROUPS = (["overview", "commerce", "creative", "catalog", "research", "supply", "insights", "settings"] as const)
  .map((id) => NAVIGATION_GROUPS.find((group) => group.id === id)!);
export const SIDEBAR_SHORTCUTS = [
  { id: "order-import", label: "导入订单报告" },
  { id: "creative-canvas", label: "开始创作" },
  { id: "orders-shipment", label: "查看待发货" },
] as const;

export const AUXILIARY_DESTINATIONS = [
  { id: "creative-designs", href: "/creative-designs", label: "批量生图", description: "辅助工具：批量生成与管理候选设计", keywords: "画图设计 AI 绘画 生图 创意 原创 批量设计 design", parentId: "creative-canvas", groupId: "creative", groupLabel: "创意设计" },
  { id: "pod-workbench", href: "/pod-workbench", label: "图片处理工具", description: "辅助工具：印花提取、抠图与图案处理", keywords: "POD 作图中心 工具箱 抠图 去背景 图片处理", parentId: "creative-canvas", groupId: "creative", groupLabel: "创意设计" },
  { id: "design", href: "/design", label: "设计任务与校样", description: "辅助工具：设计任务、文件版本与校样记录", keywords: "美工 设计校样 设计任务 审图 校对 审核 proof", parentId: "creative-canvas", groupId: "creative", groupLabel: "创意设计" },
  { id: "order-import", href: "/orders?view=reports", label: "导入与定制", description: "导入 Amazon TXT 和定制附件，再到订单中心核对并推送制图", keywords: "亚马逊 Amazon 下载 上传 报告 TXT CSV ZIP 买家 定制信息 预览图 导入订单", parentId: "orders", groupId: "commerce", groupLabel: "订单与履约" },
] as const;
export type ErpSection = (typeof NAVIGATION_GROUPS)[number]["items"][number]["id"] | (typeof AUXILIARY_DESTINATIONS)[number]["id"];
export type SearchDestination = NavigationDestination & { groupId: string; groupLabel: string };
export const PRIMARY_DESTINATIONS: readonly SearchDestination[] = NAVIGATION_GROUPS.flatMap((group) =>
  group.items.map((item) => ({ ...item, groupId: group.id, groupLabel: group.label })),
);
export const PRIMARY_NAVIGATION_LABELS = PRIMARY_DESTINATIONS.map((item) => item.label);

const secondaryDestinations: NavigationDestination[] = [
  { id: "pillow-artwork", href: "/pod-workbench/production-editor?kind=shaped_pillow", label: "异形抱枕生产图", description: "处理主体轮廓、缝边、裁剪线与正反面", keywords: "猫咪 宠物 人像 抱枕 枕头 异形 生产图 美工 剪裁 条码", parentId: "production-editor" },
  { id: "tire-artwork", href: "/pod-workbench/production-editor?kind=tire_cover", label: "定制备胎罩生产图", description: "排版图片和弧形文字，核对尺寸后导出", keywords: "轮胎罩 胎罩 备胎罩 轮胎 tire cover 弧形文字 圆形 生产图", parentId: "production-editor" },
  { id: "pod-print-extraction", href: "/pod-workbench?module=print_extraction", label: "印花提取", description: "从授权素材提取印花与裁片", keywords: "提图 提取 印花 裁片", parentId: "pod-workbench" },
  { id: "pod-print-design", href: "/pod-workbench?module=print_design", label: "印花设计", description: "创建并调整印花设计任务", keywords: "印花 原创 创意 图案", parentId: "pod-workbench" },
  { id: "pod-pattern-processing", href: "/pod-workbench?module=pattern_processing", label: "图案处理", description: "裁切、处理图案与图层", keywords: "裁剪 裁切 抠图 去背景 UV 图层", parentId: "pod-workbench" },
  { id: "pod-rights-risk", href: "/pod-workbench?module=rights_risk", label: "侵权检测", description: "检查并复核素材的权利风险", keywords: "商标 版权 风险 授权 侵权", parentId: "pod-workbench" },
  { id: "pod-listing-assets", href: "/pod-workbench?module=listing_assets", label: "套图与标题", description: "处理商品套图、标题和视频素材", keywords: "套图&标题 Listing 商品图 主图 视频 标题", parentId: "pod-workbench" },
  { id: "pod-personalization", href: "/pod-workbench?module=personalization", label: "来图定制", description: "管理定制模板与订单定制任务", keywords: "个性化 客户来图 买家 图片 模板 personalization", parentId: "pod-workbench" },
  { id: "pod-production-artwork", href: "/pod-workbench?module=production_artwork", label: "生产图任务与清单", description: "查看生产图工具、任务及生产清单", keywords: "生产文件 manifest 批量 生产图 工具", parentId: "pod-workbench" },
  { id: "orders-design", href: "/orders?workflowState=awaiting_design", label: "待设计订单", description: "筛选需要美工制作的订单", keywords: "等待 美工 待设计 订单 任务", parentId: "orders" },
  { id: "orders-production", href: "/orders?workflowState=in_production", label: "生产中订单", description: "筛选已进入生产的订单", keywords: "工厂 在做 生产中 订单", parentId: "orders" },
  { id: "orders-shipment", href: "/shipments?shipment=unshipped", label: "待发货订单", description: "筛选等待安排发货的订单", keywords: "物流 运单 包裹 发货 订单", parentId: "shipments" },
];

export const FUNCTION_DESTINATIONS: readonly SearchDestination[] = [
  ...PRIMARY_DESTINATIONS,
  ...AUXILIARY_DESTINATIONS,
  ...secondaryDestinations.map((item) => {
    const parent = [...PRIMARY_DESTINATIONS, ...AUXILIARY_DESTINATIONS].find((entry) => entry.id === item.parentId)!;
    return { ...item, groupId: parent.groupId, groupLabel: parent.groupLabel };
  }),
];
export const QUICK_DESTINATION_IDS = ["order-import", "creative-canvas", "orders-shipment"];
export const DIRECTORY_DESTINATION = { id: "navigation", href: "/navigation", label: "全部功能", description: "按业务分组查找所有页面入口", keywords: "导航 功能目录" };

const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase().trim();

export function searchDestinations(query: string): readonly SearchDestination[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return FUNCTION_DESTINATIONS;
  return FUNCTION_DESTINATIONS.map((item, index) => {
    const title = normalize(item.label);
    const text = normalize(`${item.label} ${item.description} ${item.keywords} ${item.groupLabel}`);
    const score = terms.every((term) => text.includes(term))
      ? terms.reduce((total, term) => total + (title === term ? 100 : title.includes(term) ? 30 : 5), 0)
      : 0;
    return { item, score, index };
  }).filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index).map((entry) => entry.item);
}

export interface NavigationLocation {
  current: NavigationDestination;
  primaryId?: string;
  detailKey?: string;
  breadcrumbs: { label: string; href?: string }[];
}

export function resolveNavigationLocation(pathname: string, search = ""): NavigationLocation {
  const path = pathname.replace(/\/$/, "") || "/";
  const params = new URLSearchParams(search);
  const exact = FUNCTION_DESTINATIONS.filter((item) => {
    const url = new URL(item.href, "https://erp.local");
    return url.pathname === path && [...url.searchParams].every(([key, value]) => params.get(key) === value);
  }).sort((a, b) => Number(b.href.includes("?")) - Number(a.href.includes("?")))[0];
  let current: NavigationDestination = exact ?? DIRECTORY_DESTINATION;
  let primaryId = PRIMARY_DESTINATIONS.find((item) => item.href === path)?.id;
  const queryDetail = [
    { path: "/product-specifications", parameter: "spu", parentId: "product-specifications", label: "SPU 详情" },
    { path: "/product-development", parameter: "sku", parentId: "product-development", label: "销售 SKU 详情" },
  ].find((item) => item.path === path && params.get(item.parameter)?.trim());
  const detailKey = queryDetail ? `${queryDetail.path}:${params.get(queryDetail.parameter)}` : undefined;
  if (queryDetail) {
    current = { id: `${queryDetail.parentId}-detail`, href: path, label: queryDetail.label, description: "", keywords: "", parentId: queryDetail.parentId };
  }
  if (!exact && path !== DIRECTORY_DESTINATION.href) {
    const detail = [
      { pattern: /^\/analysis\/[^/]+$/, parentId: "research", label: "分析报告" },
      { pattern: /^\/listings\/[^/]+$/, parentId: "listings", label: "刊登编辑" },
      { pattern: /^\/stores\/[^/]+$/, parentId: "stores", label: "店铺详情" },
      { pattern: /^\/workflows\/templates\/[^/]+\/edit$/, parentId: "workflows", label: "编辑流程模板" },
      { pattern: /^\/workflows\/runs\/[^/]+$/, parentId: "workflows", label: "工作流执行" },
      { pattern: /^\/suppliers\/[^/]+$/, parentId: "suppliers", label: "供应商详情" },
    ].find((item) => item.pattern.test(path));
    if (detail) {
      current = { id: "detail", href: path, label: detail.label, description: "", keywords: "", parentId: detail.parentId };
      primaryId = detail.parentId;
    } else {
      current = { id: "unknown", href: path, label: "当前页面", description: "", keywords: "" };
    }
  }
  const ancestors: NavigationDestination[] = [];
  let parentId = current.parentId;
  while (parentId) {
    const parent = FUNCTION_DESTINATIONS.find((item) => item.id === parentId);
    if (!parent) break;
    ancestors.unshift(parent);
    if (!primaryId && PRIMARY_DESTINATIONS.some((item) => item.id === parent.id)) primaryId = parent.id;
    parentId = parent.parentId;
  }
  const breadcrumbs: NavigationLocation["breadcrumbs"] = [];
  if (path !== "/") breadcrumbs.push({ label: "运营总览", href: "/" });
  const group = FUNCTION_DESTINATIONS.find((item) => item.id === (primaryId ?? current.id));
  if (group && group.groupId !== "overview") {
    breadcrumbs.push({ label: group.groupLabel, href: `/navigation?group=${group.groupId}` });
  }
  breadcrumbs.push(...ancestors.map((item) => {
    if (!queryDetail || item.id !== queryDetail.parentId) return { label: item.label, href: item.href };
    const listParams = new URLSearchParams(params);
    for (const key of ["spu", "sku", "artwork", "queue", "form", "compose", "editSpu", "specificationVersionId", "artworkVersionId"]) listParams.delete(key);
    const search = listParams.toString();
    return { label: item.label, href: `${item.href}${search ? `?${search}` : ""}` };
  }));
  breadcrumbs.push({ label: current.label });
  return { current, primaryId, detailKey, breadcrumbs };
}
