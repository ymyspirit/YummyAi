import { AMAZON_CUSTOM_WORKFLOW_STEPS } from "@yummyai/contracts/catalog/amazon-custom-workflow";
import {
  WorkflowGraphSchema,
  type WorkflowGraph,
  type WorkflowNode,
} from "@yummyai/contracts/workflow";

export const AMAZON_CUSTOM_WORKFLOW_STABLE_KEY = "official.amazon-custom-product-development.v1";
export const AMAZON_CUSTOM_WORKFLOW_NAME = "Amazon Custom Product Development V1";

const SOP: Record<
  (typeof AMAZON_CUSTOM_WORKFLOW_STEPS)[number]["key"],
  {
    description: string;
    requiredActions: string[];
    blockingConditions: string[];
    artifactLabel: string;
    permission: string;
    kind?: WorkflowNode["kind"];
    capabilityKey?: string;
    reworkTargetNodeId?: string;
  }
> = {
  research_capture: {
    description:
      "把竞品页面、标题、套图、A+ 与评论材料形成带来源的研究快照。竞品素材只作分析参考。",
    requiredActions: ["保存来源 URL", "上传页面截图或粘贴文本", "确认竞品素材为 reference_only"],
    blockingConditions: ["缺少来源 URL", "研究材料包含未授权的最终输出素材"],
    artifactLabel: "研究快照",
    permission: "research:write",
  },
  research_review: {
    description: "复核购买动机、差评原因、页面缺口和图片任务，不把评论观点写成自有产品事实。",
    requiredActions: ["确认研究结论", "标记事实与市场洞察边界", "记录需要验证的假设"],
    blockingConditions: ["结论无证据来源", "竞品参数被当作已验证事实"],
    artifactLabel: "已复核研究结论",
    permission: "research:write",
  },
  product_plan: {
    description: "建立自有产品企划，绑定负责人、目标站点、类目与开发范围。",
    requiredActions: ["创建或关联产品企划", "指定负责人", "确认 Amazon Custom 开发范围"],
    blockingConditions: ["未绑定产品企划", "负责人为空"],
    artifactLabel: "产品企划",
    permission: "product:write",
  },
  provisional_facts: {
    description: "根据研究资料生成可编辑的临时产品事实。所有字段默认标为待卖家核实。",
    requiredActions: ["生成临时事实", "保留来源标签", "不得自动锁定竞品参数"],
    blockingConditions: ["未完成研究复核"],
    artifactLabel: "临时产品事实",
    permission: "product:write",
    kind: "internal_action",
    capabilityKey: "yummyai.custom_product.generate_provisional_facts",
  },
  seller_facts: {
    description: "用实物、供应商资料和生产规格替换或确认临时事实，完成事实锁定。",
    requiredActions: ["核对尺寸、材质和数量", "核对包装与配件", "确认事实来源并锁定"],
    blockingConditions: ["关键事实仍为竞品临时值", "尺寸或包装数量缺失"],
    artifactLabel: "已确认产品事实",
    permission: "product:write",
  },
  customization_schema: {
    description: "配置 Surface、文字、图片、选项、备注、加工区域与加价规则。",
    requiredActions: ["定义每个定制面", "填写加工区域 mm", "设置字符、字体、颜色和图片质量限制"],
    blockingConditions: ["定制区域缺失", "字段数量超过当前政策配置"],
    artifactLabel: "定制字段配置",
    permission: "product:write",
  },
  spu_sku: {
    description: "创建 SPU 与实际销售 SKU，并使变体与包装事实一致。",
    requiredActions: ["创建 SPU", "创建至少一个 SKU", "复核 SKU 属性和定制规则"],
    blockingConditions: ["SKU 缺失", "SKU 属性与事实不一致"],
    artifactLabel: "SKU",
    permission: "product:write",
  },
  design_proof: {
    description: "在设计校样模块制作真实加工区域内的定制效果，审核尺寸、出血、文字和工艺可生产性。",
    requiredActions: ["上传或创建设计版本", "核对安全区与出血", "由设计审核人批准校样"],
    blockingConditions: ["校样未批准", "设计超出加工区域", "关键文字依赖生图模型生成"],
    artifactLabel: "已批准设计版本",
    permission: "design:review",
  },
  authorized_assets: {
    description: "将实拍、完成品、包装、印刷模板与风格参考按角色和权利状态关联到产品包。",
    requiredActions: ["关联真实产品素材", "填写 rightsStatus 与 usePolicy", "执行产品包完整度预检"],
    blockingConditions: ["素材权利不明", "竞品原图进入最终生图参考", "缺少真实主图主体"],
    artifactLabel: "授权素材集",
    permission: "asset:promote",
  },
  studio_draft: {
    description: "生成 CustomProductPackageV1 草稿 ZIP，交给 Amazon Studio 策划 9 图、A+ 和文案。",
    requiredActions: ["通过导出闸门", "生成草稿产品包", "确认包内不含凭据"],
    blockingConditions: ["事实未锁定", "素材权利不明", "定制区域缺失"],
    artifactLabel: "产品包 ZIP",
    permission: "product:write",
    kind: "internal_action",
    capabilityKey: "yummyai.custom_product.export_package",
  },
  studio_content: {
    description:
      "在 Amazon Studio 导入产品包，生成 Listing 文案、9 张 Custom 套图、A+ 与逐图提示词。",
    requiredActions: ["导入产品包", "先用 2K 生成草稿", "关键名字和 Logo 在设计层确定性排版"],
    blockingConditions: ["主图不是自有实拍主体", "包装数量与事实不一致", "可见商标或非虚构示例名"],
    artifactLabel: "Listing 内容版本",
    permission: "listing:write",
  },
  content_review: {
    description: "审核文案、9 图、A+、Custom 配置表和合规报告；拒绝时返工到 Studio 内容节点。",
    requiredActions: ["逐项对照产品事实", "审核 MAIN 图与宣称", "批准后生成正式上架资料包"],
    blockingConditions: ["事实不一致", "存在未证实宣称", "Custom 配置无法对应 Seller Central 字段"],
    artifactLabel: "已批准上线包",
    permission: "listing:review",
    kind: "approval_gate",
    reworkTargetNodeId: "studio_content",
  },
  seller_central: {
    description:
      "将已批准文案、9 图、A+、Custom 配置、SKU 属性、生产文件与合规报告汇总为一个可交付 ZIP。",
    requiredActions: ["执行八组资料齐套检查", "确认竞品素材未进入包内", "下载完整上架资料包"],
    blockingConditions: [
      "Listing 版本未批准",
      "图片或 A+ 不齐",
      "定制配置、生产模板或合规字段缺失",
    ],
    artifactLabel: "完整上架资料包 ZIP",
    permission: "listing:read",
  },
  online_qa: {
    description: "由产品负责人按资料齐套报告验收最终 ZIP，确认运营无需再临时补文案、图片或配置。",
    requiredActions: [
      "逐项核对八组资料",
      "抽查 MAIN、PT01–PT08 与 A+ 文件",
      "确认上传清单可逐项执行",
    ],
    blockingConditions: [
      "齐套率未达到 100%",
      "文件名或上传顺序不明确",
      "包内存在未授权或未确认内容",
    ],
    artifactLabel: "已验收上架资料包",
    permission: "listing:review",
    kind: "approval_gate",
    reworkTargetNodeId: "content_review",
  },
};

const startNode: WorkflowNode = {
  id: "start",
  kind: "start",
  title: "开始产品开发",
  description: "绑定一个产品企划并固定当前官方模板版本。",
  ownerRole: "产品负责人",
  inputPorts: [],
  outputPorts: [],
  config: { parameters: {}, artifactLabel: "产品企划" },
  position: { x: 160, y: 40 },
};

const actionNodes = AMAZON_CUSTOM_WORKFLOW_STEPS.map((step, index): WorkflowNode => {
  const sop = SOP[step.key];
  return {
    id: step.key,
    kind: sop.kind ?? "human_task",
    title: step.title,
    description: sop.description,
    ownerRole: step.ownerRole,
    requiredPermission: sop.permission,
    inputPorts: [],
    outputPorts: [],
    config: {
      parameters: { system: step.system, location: step.location },
      instructions: sop.description,
      requiredActions: sop.requiredActions,
      blockingConditions: sop.blockingConditions,
      artifactLabel: sop.artifactLabel,
      ...(sop.capabilityKey ? { capabilityKey: sop.capabilityKey } : {}),
      ...(sop.kind === "approval_gate" ? { approvalMode: "any" as const } : {}),
    },
    position: { x: 160, y: 190 + index * 170 },
    ...(sop.reworkTargetNodeId ? { reworkTargetNodeId: sop.reworkTargetNodeId } : {}),
  };
});

const endNode: WorkflowNode = {
  id: "end",
  kind: "end",
  title: "完成并交接",
  description: "完整上架资料包已验收并交接给店铺运营，运行实例完成，全部历史事件继续保留。",
  ownerRole: "产品负责人",
  inputPorts: [],
  outputPorts: [],
  config: { parameters: {} },
  position: { x: 160, y: 190 + AMAZON_CUSTOM_WORKFLOW_STEPS.length * 170 },
};

const nodeIds = ["start", ...AMAZON_CUSTOM_WORKFLOW_STEPS.map((step) => step.key), "end"];
const artifactLabels = [
  "产品企划",
  ...AMAZON_CUSTOM_WORKFLOW_STEPS.map((step) => SOP[step.key].artifactLabel),
];

export const AMAZON_CUSTOM_OFFICIAL_GRAPH: WorkflowGraph = WorkflowGraphSchema.parse({
  nodes: [startNode, ...actionNodes, endNode],
  edges: nodeIds.slice(0, -1).map((source, index) => ({
    id: `edge-${source}-${nodeIds[index + 1]}`,
    source,
    target: nodeIds[index + 1],
    kind: "success",
    label: artifactLabels[index],
    artifactType: artifactTypeFor(nodeIds[index + 1]!),
    validationStatus: "valid",
  })),
  viewport: { x: 0, y: 0, zoom: 0.72 },
});

function artifactTypeFor(nodeId: string) {
  if (["research_capture", "research_review"].includes(nodeId)) return "research_snapshot" as const;
  if (["provisional_facts", "seller_facts", "customization_schema"].includes(nodeId))
    return "product_facts" as const;
  if (nodeId === "spu_sku") return "sku" as const;
  if (["design_proof", "authorized_assets"].includes(nodeId)) return "design_version" as const;
  if (nodeId === "studio_draft") return "product_package" as const;
  if (["studio_content", "content_review"].includes(nodeId)) return "listing_version" as const;
  if (["seller_central", "online_qa", "end"].includes(nodeId)) return "production_package" as const;
  return "any" as const;
}
