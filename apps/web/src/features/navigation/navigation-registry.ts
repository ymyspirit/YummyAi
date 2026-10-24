export interface NavigationDestination {
  id: string;
  href: string;
  label: string;
  description: string;
  keywords: string;
  parentId?: string;
}

export const NAVIGATION_GROUPS = [
  {
    id: "overview",
    label: "工作台",
    description: "今日待办、业务任务与分析记录",
    items: [
      {
        id: "dashboard",
        href: "/",
        label: "运营总览",
        description: "查看今日待办、风险和业务概况",
        keywords: "首页 工作台 仪表盘 dashboard",
      },
      {
        id: "business-tasks",
        href: "/business-tasks",
        label: "业务任务",
        description: "按订单或销售方案跟进业务阶段、待办与交付资料",
        keywords: "任务 工作台 agent 履约 上架 审核 交付",
      },
      {
        id: "ai-tasks",
        href: "/ai-tasks",
        label: "AI 任务工作台",
        description: "关联业务对象，核对依据并跟进 AI 任务与产物",
        keywords: "AI 智能体 任务 工作台 分析 依据 历史 agent",
      },
    ],
  },
  {
    id: "creative",
    label: "创作工具",
    description: "画布、生成工具与素材管理",
    items: [
      {
        id: "content-projects",
        href: "/content-projects",
        label: "商品图文项目",
        description: "联动研究、原创设计、SKU、商品套图、Listing 与审核资料包",
        keywords: "图文生产 图文项目 商品内容 AI 图文 联动 项目 资料包",
      },
      {
        id: "creative-canvas",
        href: "/creative-designs/canvas",
        label: "创意项目",
        description: "配置创意与定制需求，设计审核后交付印花素材",
        keywords: "创意工作台 创意画布 infinite canvas 画布 工作流 插件 定制模板 印花素材",
      },
      {
        id: "studio-canvas",
        href: "/creative-designs/studio/canvas",
        label: "我的画布",
        description: "编辑与保存无限画布，关联创意项目",
        keywords: "infinite canvas 无限画布 节点 流程 导入 导出",
      },
      {
        id: "studio-image",
        href: "/creative-designs/studio/image",
        label: "生图工作台",
        description: "使用 ERP 模型生成和编辑图片",
        keywords: "AI 生图 图生图 图片 创作 绘画",
      },
      {
        id: "studio-video",
        href: "/creative-designs/studio/video",
        label: "视频创作台",
        description: "创作视频，跟进生成任务",
        keywords: "视频 video 首帧 广告",
      },
      {
        id: "studio-prompts",
        href: "/creative-designs/studio/prompts",
        label: "提示词库",
        description: "管理并调用常用提示词",
        keywords: "提示词 prompt 模板 收藏 文字",
      },
      {
        id: "studio-assets",
        href: "/creative-designs/studio/assets",
        label: "我的资产",
        description: "管理图片、视频和文字素材",
        keywords: "素材库 资产 图片 视频 收藏 审核",
      },
      {
        id: "production-editor",
        href: "/pod-workbench/production-editor",
        label: "生产文件与底稿",
        description: "管理生产稿、历史文件和通用工艺底稿",
        keywords: "生产作图 生产图 美工 编辑器 PNG JPG TIFF DPI 印刷 导出",
      },
    ],
  },
  {
    id: "catalog",
    label: "商品与上架",
    description: "载体与工艺 → 印花 → 组合 → 套图 → 刊登",
    items: [
      {
        id: "product-specifications",
        href: "/product-specifications",
        label: "商品库",
        description: "先创建 SPU，维护工艺、规格、重量和可定制范围",
        keywords: "商品 SPU 产品目录 规格 空白品 材质 尺寸 重量 工艺",
      },
      {
        id: "print-library",
        href: "/print-library",
        label: "印花库",
        description: "从已审核创意登记独立印花 SKU，管理版本与研究来源",
        keywords: "印花 sku 素材 原创 主图案 版本",
      },
      {
        id: "product-development",
        href: "/product-development",
        label: "销售 SKU 组合",
        description: "组合印花与规格，维护制作配方和封存资料包",
        keywords: "产品开发 销售SKU 与资料包 配方 制作 渠道 映射",
      },
      {
        id: "mockup-batches",
        href: "/pod-workbench/mockup-batches",
        label: "商品套图",
        description: "用已批准设计与模板制作套图",
        keywords: "批量套图 样机 效果图 PSD mockup 场景图",
      },
      {
        id: "sales-plans",
        href: "/sales-plans",
        label: "上架工作台",
        description: "同一 SPU 的多个销售方案：调研、图文设计和刊登准备",
        keywords: "销售方案 产品开发 市场调研 定制 标品 FBA FBM 上架 四步",
      },
      {
        id: "listings",
        href: "/listings",
        label: "刊登管理",
        description: "编辑草稿、审核资料、查看平台提交结果与在售更新",
        keywords: "刊登控制台 上架 listing 标题 文案 五点 导出包 发布",
      },
    ],
  },
  {
    id: "commerce",
    label: "订单与履约",
    description: "导入订单，跟进定制、生产和发货",
    items: [
      {
        id: "orders",
        href: "/orders",
        label: "订单中心",
        description: "导入报告、编辑定制需求、审单并推送制图",
        keywords: "订单履约 订单 工作台 搜索 筛选 审单 报告 FBM 定制 order",
      },
      {
        id: "order-artwork",
        href: "/order-artwork",
        label: "制图中心",
        description: "领取订单制图任务、审核文件与客户校样",
        keywords: "订单 生产文件 制图 制作 审核 校样",
      },
      {
        id: "production",
        href: "/production",
        label: "生产中心",
        description: "下达生产、跟进工厂进度、质检与补做",
        keywords: "生产 工厂 加工 质检 返工",
      },
      {
        id: "logistics-purchase",
        href: "/logistics",
        label: "物流下单",
        description: "按实际工厂、时效和预算准备 ShipOS 或云途面单",
        keywords: "物流 下单 购单 询价 ShipOS 云途 运单 面单 工厂",
      },
      {
        id: "shipments",
        href: "/shipments",
        label: "发货中心",
        description: "安排包裹、记录交运并跟踪物流",
        keywords: "发货 包裹 物流 单号 运输 回传",
      },
      {
        id: "after-sales",
        href: "/after-sales",
        label: "售后中心",
        description: "跟进客户问题、沟通记录和处理方案",
        keywords: "售后 客诉 退款 补发 补做 退货",
      },
    ],
  },
  {
    id: "supply",
    label: "供应链",
    description: "供应商、采购补货与仓库库存",
    items: [
      {
        id: "suppliers",
        href: "/suppliers",
        label: "供应商档案",
        description: "新增和维护合作供应商资料",
        keywords: "新增 创建 供应商 工厂 合作 建档 supplier",
      },
      {
        id: "factory-collaboration",
        href: "/factory-collaboration",
        label: "工厂协作授权",
        description: "将原制作文件分配给已开通的工厂成员，管理有效期与撤销",
        keywords: "工厂 协作 授权 分配 文件 成员 回执",
      },
      {
        id: "inventory",
        href: "/inventory",
        label: "库存台账",
        description: "查看仓库库存、预占与出入库记录",
        keywords: "仓库 数量 库存 入库 出库 盘点 stock",
      },
      {
        id: "procurement",
        href: "/procurement",
        label: "采购补货",
        description: "处理补货建议、采购单和到货验收",
        keywords: "供应商 工厂 采购 收货 缺货 补货 purchase",
      },
      {
        id: "supplier-performance",
        href: "/supplier-performance",
        label: "供应商绩效",
        description: "评估供应商交期、质量与履约表现",
        keywords: "工厂 供应商 评分 准时 质检 supplier",
      },
      {
        id: "channel-inventory",
        href: "/channel-inventory",
        label: "渠道库存",
        description: "核对各销售渠道的库存与差异",
        keywords: "FBA 亚马逊 仓库 渠道 同步 库存 对账",
      },
    ],
  },
  {
    id: "insights",
    label: "研究与经营",
    description: "选品研究、客户反馈与经营分析",
    items: [
      {
        id: "research",
        href: "/research",
        label: "研究资料库",
        description: "查看采集商品、快照和分析报告",
        keywords: "选品 竞品 采集 抓取 插件 证据 分析报告 research",
      },
      {
        id: "competitors",
        href: "/competitors",
        label: "竞争店铺",
        description: "管理竞品店铺与研究记录",
        keywords: "竞品店铺 对标 竞争对手 competitor",
      },
      {
        id: "finance",
        href: "/finance",
        label: "财务利润",
        description: "核对费用、结算、成本和利润",
        keywords: "财务 收入 成本 结算 对账 利润 报表 finance",
      },
      {
        id: "customer-intelligence",
        href: "/customer-intelligence",
        label: "广告与 VOC",
        description: "分析广告表现、关键词和客户反馈",
        keywords: "广告 关键词 搜索词 客户 评论 评价 VOC ACoS ROAS",
      },
    ],
  },
  {
    id: "knowledge",
    label: "知识与规则",
    description: "维护运营知识、制作规范与审核版本",
    items: [
      {
        id: "knowledge",
        href: "/knowledge",
        label: "运营知识库",
        description: "管理 AI 使用的运营知识、来源、审核版本和复查日期",
        keywords: "知识库 运营知识 SOP 文档 检索 AI 经验 复盘",
      },
      {
        id: "agent-methods",
        href: "/knowledge/methods",
        label: "方法库",
        description: "维护团队方法、知识引用和发布版本，核对当前可用性",
        keywords: "方法库 Skill 方法 版本 审核 发布 停用 Harness",
      },
      {
        id: "rule-center",
        href: "/settings/rules",
        label: "规则中心",
        description: "维护制作规范、工艺依据和规则版本，核对自动执行与人工核验要求",
        keywords: "规则 规范 SOP 制作标准 工厂 工艺 版本 配置",
      },
    ],
  },
  {
    id: "settings",
    label: "系统配置",
    description: "店铺授权、业务规则与服务连接",
    items: [
      {
        id: "teams",
        href: "/settings/teams",
        label: "团队管理",
        description: "维护现有成员关系与商品团队归属",
        keywords: "团队 成员 商品 范围 权限 team",
      },
      {
        id: "stores",
        href: "/stores",
        label: "店铺运营",
        description: "管理自有店铺连接与授权状态",
        keywords: "我的店铺 账号 连接 授权 Amazon Etsy 设置 store",
      },
      {
        id: "workflows",
        href: "/workflows",
        label: "工作流中心",
        description: "配置流程模板，查看任务执行记录",
        keywords: "流程 SOP Amazon Custom 任务 编排 节点 workflow",
      },
      {
        id: "fulfillment-settings",
        href: "/settings/fulfillment",
        label: "履约配置",
        description: "维护质检标准，管理工厂与物流渠道配置入口",
        keywords: "订单 履约 质检 标准 工厂 物流 渠道 配置",
      },
      {
        id: "ai-settings",
        href: "/settings/ai",
        label: "AI 模型配置",
        description: "统一管理创作渠道、密钥和模型用途",
        keywords: "配置 设置 API key 模型 渠道 AI settings",
      },
      {
        id: "model-billing",
        href: "/model-billing",
        label: "模型费用核对",
        description: "关联原调用和渠道凭证，记录人工核对及预算纠正",
        keywords: "AI 模型 费用 账单 预算 对账 核对 凭证 billing",
      },
      {
        id: "operating-cockpit",
        href: "/operating-cockpit",
        label: "数据与集成",
        description: "查看经营指标、数据任务和集成状态",
        keywords: "API Webhook 集成 数据 任务 指标 告警 连接器 设置",
      },
    ],
  },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  description: string;
  items: readonly NavigationDestination[];
}>;

export type NavigationGroupId = (typeof NAVIGATION_GROUPS)[number]["id"];
// Follow the product lifecycle; supporting tools and configuration follow daily work.
export const SIDEBAR_GROUPS = (
  [
    "overview",
    "catalog",
    "commerce",
    "creative",
    "insights",
    "supply",
    "knowledge",
    "settings",
  ] as const
).map((id) => NAVIGATION_GROUPS.find((group) => group.id === id)!);
export const AUXILIARY_DESTINATIONS = [
  {
    id: "manufacturing-recipes",
    href: "/manufacturing-recipes",
    label: "制造模板",
    description: "按SPU维护制造材料、工序、审核版本和备料建议",
    keywords: "BOM 制造 配方 材料 工序 供料 备料",
    parentId: "product-specifications",
    groupId: "catalog",
    groupLabel: "商品与上架",
  },
  {
    id: "process-library",
    href: "/process-library",
    label: "工艺底稿",
    description: "维护商品共用工艺与制作模板",
    keywords: "工艺 模板 底稿 制作 印刷",
    parentId: "product-specifications",
    groupId: "catalog",
    groupLabel: "商品与上架",
  },
  {
    id: "products",
    href: "/products",
    label: "历史产品企划",
    description: "查看原产品企划、商品资料和历史记录",
    keywords: "产品目录 企划 旧商品 档案 SKU SPU product",
    parentId: "product-specifications",
    groupId: "catalog",
    groupLabel: "商品与上架",
  },
  {
    id: "creative-designs",
    href: "/creative-designs",
    label: "批量生图",
    description: "辅助工具：批量生成与管理候选设计",
    keywords: "画图设计 AI 绘画 生图 创意 原创 批量设计 design",
    parentId: "creative-canvas",
    groupId: "creative",
    groupLabel: "创作工具",
  },
  {
    id: "pod-workbench",
    href: "/pod-workbench",
    label: "图片处理工具",
    description: "辅助工具：印花提取、抠图与图案处理",
    keywords: "POD 作图中心 工具箱 抠图 去背景 图片处理",
    parentId: "creative-canvas",
    groupId: "creative",
    groupLabel: "创作工具",
  },
  {
    id: "design",
    href: "/design",
    label: "设计任务与校样",
    description: "辅助工具：设计任务、文件版本与校样记录",
    keywords: "美工 设计校样 设计任务 审图 校对 审核 proof",
    parentId: "creative-canvas",
    groupId: "creative",
    groupLabel: "创作工具",
  },
  {
    id: "order-import",
    href: "/orders?view=reports",
    label: "导入与定制",
    description: "导入 Amazon TXT 和定制附件，再到订单中心核对并推送制图",
    keywords: "亚马逊 Amazon 下载 上传 报告 TXT CSV ZIP 买家 定制信息 预览图 导入订单",
    parentId: "orders",
    groupId: "commerce",
    groupLabel: "订单与履约",
  },
  {
    id: "logistics-sync",
    href: "/shipments?view=logistics",
    label: "物流订单同步",
    description: "同步 ShipOS 已有订单、运单和现有面单，核对本地关联与异常",
    keywords: "ShipOS 物流 订单 同步 运单 面单 已有订单 只读",
    parentId: "shipments",
    groupId: "commerce",
    groupLabel: "订单与履约",
  },
] as const;
export type ErpSection =
  | (typeof NAVIGATION_GROUPS)[number]["items"][number]["id"]
  | (typeof AUXILIARY_DESTINATIONS)[number]["id"];
export type SearchDestination = NavigationDestination & { groupId: string; groupLabel: string };
export const PRIMARY_DESTINATIONS: readonly SearchDestination[] = NAVIGATION_GROUPS.flatMap(
  (group) => group.items.map((item) => ({ ...item, groupId: group.id, groupLabel: group.label })),
);
export const PRIMARY_NAVIGATION_LABELS = PRIMARY_DESTINATIONS.map((item) => item.label);

const secondaryDestinations: NavigationDestination[] = [
  {
    id: "finance-cost-allocations",
    href: "/finance/cost-allocations",
    label: "费用分摊与归属利润",
    description: "明确原费用、真实目标、精确权重和已批准版本 核对逐目标利润",
    keywords: "费用 分摊 归属 利润 权重 期间 规则 版本 cost allocation",
    parentId: "finance",
  },
  {
    id: "finance-originals",
    href: "/finance/originals",
    label: "我的财务原提交",
    description: "恢复本人原填写并核对实际记账、版本与计算结果",
    keywords: "财务 恢复 原提交 断线 重试 幂等 原请求",
    parentId: "finance",
  },
  {
    id: "advertising-originals",
    href: "/advertising/originals",
    label: "我的广告原提交",
    description: "恢复本人原填写 核对原请求与真实导入和动作结果",
    keywords: "广告 恢复 原提交 断线 重试 幂等 原请求",
    parentId: "customer-intelligence",
  },
  {
    id: "finance-ledger",
    href: "/finance/ledger",
    label: "财务台账",
    description: "逐页查阅财务凭据、原始金额、历史版本和关联明细",
    keywords: "财务 台账 历史 分页 账单 付款 退款 费用 凭据 ledger",
    parentId: "finance",
  },
  {
    id: "finance-payables",
    href: "/finance/payables",
    label: "应付与付款核销",
    description: "登记工厂和供应商账单、实际付款证据、部分与合并核销及撤销记录",
    keywords: "应付 付款 核销 工厂 供应商 发票 账单 payment payable allocation",
    parentId: "finance",
  },
  {
    id: "order-profit-review",
    href: "/finance/order-review",
    label: "定制订单履约与利润复盘",
    description: "核对固定规格、配方、工厂、实际交运、返工和已入账贡献利润",
    keywords: "订单 复盘 成本 利润 准时 交期 补做 返工 SKU",
    parentId: "finance",
  },
  {
    id: "pillow-artwork",
    href: "/pod-workbench/production-editor?kind=shaped_pillow",
    label: "异形抱枕生产图",
    description: "处理主体轮廓、缝边、裁剪线与正反面",
    keywords: "猫咪 宠物 人像 抱枕 枕头 异形 生产图 美工 剪裁 条码",
    parentId: "production-editor",
  },
  {
    id: "tire-artwork",
    href: "/pod-workbench/production-editor?kind=tire_cover",
    label: "定制备胎罩生产图",
    description: "排版图片和弧形文字，核对尺寸后导出",
    keywords: "轮胎罩 胎罩 备胎罩 轮胎 tire cover 弧形文字 圆形 生产图",
    parentId: "production-editor",
  },
  {
    id: "pod-print-extraction",
    href: "/pod-workbench?module=print_extraction",
    label: "印花提取",
    description: "从授权素材提取印花与裁片",
    keywords: "提图 提取 印花 裁片",
    parentId: "pod-workbench",
  },
  {
    id: "pod-print-design",
    href: "/pod-workbench?module=print_design",
    label: "印花设计",
    description: "创建并调整印花设计任务",
    keywords: "印花 原创 创意 图案",
    parentId: "pod-workbench",
  },
  {
    id: "pod-pattern-processing",
    href: "/pod-workbench?module=pattern_processing",
    label: "图案处理",
    description: "裁切、处理图案与图层",
    keywords: "裁剪 裁切 抠图 去背景 UV 图层",
    parentId: "pod-workbench",
  },
  {
    id: "pod-rights-risk",
    href: "/pod-workbench?module=rights_risk",
    label: "侵权检测",
    description: "检查并复核素材的权利风险",
    keywords: "商标 版权 风险 授权 侵权",
    parentId: "pod-workbench",
  },
  {
    id: "pod-listing-assets",
    href: "/pod-workbench?module=listing_assets",
    label: "套图与标题",
    description: "处理商品套图、标题和视频素材",
    keywords: "套图&标题 Listing 商品图 主图 视频 标题",
    parentId: "pod-workbench",
  },
  {
    id: "pod-personalization",
    href: "/pod-workbench?module=personalization",
    label: "来图定制",
    description: "管理定制模板与订单定制任务",
    keywords: "个性化 客户来图 买家 图片 模板 personalization",
    parentId: "pod-workbench",
  },
  {
    id: "pod-production-artwork",
    href: "/pod-workbench?module=production_artwork",
    label: "生产图任务与清单",
    description: "查看生产图工具、任务及生产清单",
    keywords: "生产文件 manifest 批量 生产图 工具",
    parentId: "pod-workbench",
  },
  {
    id: "orders-design",
    href: "/orders?workflowState=awaiting_design",
    label: "待设计订单",
    description: "筛选需要美工制作的订单",
    keywords: "等待 美工 待设计 订单 任务",
    parentId: "orders",
  },
  {
    id: "orders-production",
    href: "/orders?workflowState=in_production",
    label: "生产中订单",
    description: "筛选已进入生产的订单",
    keywords: "工厂 在做 生产中 订单",
    parentId: "orders",
  },
  {
    id: "orders-shipment",
    href: "/shipments?orderStatus=produced",
    label: "待发货订单",
    description: "查看整单已生产、等待发货的订单",
    keywords: "物流 运单 包裹 发货 订单",
    parentId: "shipments",
  },
];

export const FUNCTION_DESTINATIONS: readonly SearchDestination[] = [
  ...PRIMARY_DESTINATIONS,
  ...AUXILIARY_DESTINATIONS,
  ...secondaryDestinations.map((item) => {
    const parent = [...PRIMARY_DESTINATIONS, ...AUXILIARY_DESTINATIONS].find(
      (entry) => entry.id === item.parentId,
    )!;
    return { ...item, groupId: parent.groupId, groupLabel: parent.groupLabel };
  }),
];
export const QUICK_DESTINATION_IDS = ["order-import", "creative-canvas", "orders-shipment"];
export const DIRECTORY_DESTINATION = {
  id: "navigation",
  href: "/navigation",
  label: "全部功能",
  description: "按业务分组查找所有页面入口",
  keywords: "导航 功能目录",
};

const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase().trim();

export function searchDestinations(query: string): readonly SearchDestination[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return FUNCTION_DESTINATIONS;
  return FUNCTION_DESTINATIONS.map((item, index) => {
    const title = normalize(item.label);
    const text = normalize(`${item.label} ${item.description} ${item.keywords} ${item.groupLabel}`);
    const score = terms.every((term) => text.includes(term))
      ? terms.reduce(
          (total, term) => total + (title === term ? 100 : title.includes(term) ? 30 : 5),
          0,
        )
      : 0;
    return { item, score, index };
  })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
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
    return (
      url.pathname === path &&
      [...url.searchParams].every(([key, value]) => params.get(key) === value)
    );
  }).sort((a, b) => Number(b.href.includes("?")) - Number(a.href.includes("?")))[0];
  let current: NavigationDestination = exact ?? DIRECTORY_DESTINATION;
  let primaryId = PRIMARY_DESTINATIONS.find((item) => item.href === path)?.id;
  const queryDetail = [
    {
      path: "/content-projects",
      parameter: "project",
      parentId: "content-projects",
      label: "图文项目详情",
    },
    { path: "/sales-plans", parameter: "plan", parentId: "sales-plans", label: "销售方案详情" },
    {
      path: "/product-specifications",
      parameter: "spu",
      parentId: "product-specifications",
      label: "SPU 详情",
    },
    {
      path: "/product-development",
      parameter: "sku",
      parentId: "product-development",
      label: "销售 SKU 详情",
    },
  ].find((item) => item.path === path && params.get(item.parameter)?.trim());
  const detailKey = queryDetail
    ? `${queryDetail.path}:${params.get(queryDetail.parameter)}`
    : undefined;
  if (queryDetail) {
    current = {
      id: `${queryDetail.parentId}-detail`,
      href: path,
      label: queryDetail.label,
      description: "",
      keywords: "",
      parentId: queryDetail.parentId,
    };
  }
  if (!exact && path !== DIRECTORY_DESTINATION.href) {
    const detail = [
      { pattern: /^\/analysis\/[^/]+$/, parentId: "research", label: "分析报告" },
      { pattern: /^\/listings\/[^/]+$/, parentId: "listings", label: "刊登编辑" },
      { pattern: /^\/stores\/[^/]+$/, parentId: "stores", label: "店铺详情" },
      {
        pattern: /^\/workflows\/templates\/[^/]+\/edit$/,
        parentId: "workflows",
        label: "编辑流程模板",
      },
      { pattern: /^\/workflows\/runs\/[^/]+$/, parentId: "workflows", label: "工作流执行" },
      { pattern: /^\/suppliers\/[^/]+$/, parentId: "suppliers", label: "供应商详情" },
      {
        pattern: /^\/suppliers\/[^/]+\/factories\/[^/]+$/,
        parentId: "suppliers",
        label: "工厂详情",
      },
    ].find((item) => item.pattern.test(path));
    if (detail) {
      current = {
        id: "detail",
        href: path,
        label: detail.label,
        description: "",
        keywords: "",
        parentId: detail.parentId,
      };
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
    if (!primaryId && PRIMARY_DESTINATIONS.some((item) => item.id === parent.id))
      primaryId = parent.id;
    parentId = parent.parentId;
  }
  const breadcrumbs: NavigationLocation["breadcrumbs"] = [];
  if (path !== "/") breadcrumbs.push({ label: "运营总览", href: "/" });
  const group = FUNCTION_DESTINATIONS.find((item) => item.id === (primaryId ?? current.id));
  if (group && group.groupId !== "overview") {
    breadcrumbs.push({ label: group.groupLabel, href: `/navigation?group=${group.groupId}` });
  }
  breadcrumbs.push(
    ...ancestors.map((item) => {
      if (!queryDetail || item.id !== queryDetail.parentId)
        return { label: item.label, href: item.href };
      const listParams = new URLSearchParams(params);
      for (const key of [
        "spu",
        "sku",
        "artwork",
        "plan",
        "step",
        "new",
        "queue",
        "form",
        "compose",
        "editSpu",
        "specificationVersionId",
        "artworkVersionId",
      ])
        listParams.delete(key);
      const search = listParams.toString();
      return { label: item.label, href: `${item.href}${search ? `?${search}` : ""}` };
    }),
  );
  breadcrumbs.push({ label: current.label });
  return { current, primaryId, detailKey, breadcrumbs };
}
