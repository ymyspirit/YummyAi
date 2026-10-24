/** Operational policy is independent of the customer's original marketplace options. */
export const DEFAULT_ORDER_DESIGN_EXECUTOR = "agent" as const;
export const ORDER_IMAGE_ENHANCEMENT_POLICY = "faithful_enhancement_v1" as const;
export const ORDER_IMAGE_ENHANCEMENT_INSTRUCTION =
  "所有订单的顾客图片均进行保真美化，不因顾客未选、关闭或未填写图片美化而跳过。" +
  "仅优化清晰度、曝光、白平衡、色彩和噪点，保持自然、适合印刷。" +
  "保留同一人物或宠物的身份、五官、表情、姿态、身体比例、毛色和独有特征；" +
  "保留原有文字、物品和构图，不增删主体，不瘦脸、换脸、改品种、卡通化或凭空补造细节。";

export function orderDesignExecutor(draft: { designExecutor?: "human" | "agent" }) {
  return draft.designExecutor ?? DEFAULT_ORDER_DESIGN_EXECUTOR;
}
