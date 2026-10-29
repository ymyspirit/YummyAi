import { describe, expect, it } from "vitest";

import { designAgentActivity, designAgentBillingNotice, designAgentCurrentVersionApproved, designAgentErrorMessage, designAgentNoRunMessage, designAgentReadRetryDelay } from "./order-design-agent-panel";

describe("design agent absent-run context", () => {
  it("distinguishes a successfully read pushed Agent order without claiming a specific configuration defect", () => {
    expect(designAgentNoRunMessage({ preparation: "pushed", designExecutor: "agent" }))
      .toBe("尚未创建无人设计任务 请核对工艺模板的无人设计配置");
  });

  it("preserves the existing human and unknown-executor paths instead of inferring an Agent dispatch", () => {
    const original = designAgentNoRunMessage({});
    expect(original).toContain("审单并派发后开始执行");
    expect(designAgentNoRunMessage({ preparation: "pushed", designExecutor: "human" })).toBe(original);
    expect(designAgentNoRunMessage({ preparation: "pushed" })).toBe(original);
  });

  it("does not describe an unpushed Agent order as a missing dispatched task", () => {
    for (const preparation of ["pending_review", "needs_information", "ready_to_push"] as const)
      expect(designAgentNoRunMessage({ preparation, designExecutor: "agent" })).toBe(designAgentNoRunMessage({}));
  });

  it("does not turn a failed read into evidence that a task was never created", () => {
    const message = designAgentNoRunMessage({ preparation: "pushed", designExecutor: "agent", readFailed: true });
    expect(message).toBe("尚无法确认自动制图任务状态。请刷新进度。");
    expect(message).not.toContain("尚未创建");
  });

  it("keeps the financial-only fallback compatible when dispatch context is unavailable", () => {
    expect(designAgentNoRunMessage({ financialOnly: true })).toBe("尚无独立的自动制图费用记录。");
    expect(designAgentNoRunMessage({ financialOnly: true, readFailed: true })).toContain("尚无法确认");
  });
});

describe("design agent manual handoff boundary", () => {
  it("requires takeover for paused work while stopping its automatic polling", () => {
    expect(designAgentActivity("needs_attention")).toEqual({ polling: false, manualEditsBlocked: true });
    for (const status of ["queued", "running"] as const) {
      expect(designAgentActivity(status)).toEqual({ polling: true, manualEditsBlocked: true });
    }
  });

  it("allows human review and editing after completed steps or takeover", () => {
    for (const status of ["awaiting_review", "cancelled", null] as const) {
      expect(designAgentActivity(status)).toEqual({ polling: false, manualEditsBlocked: false });
    }
  });

  it("labels only the exact currently approved candidate without changing the original awaiting-review execution or completion", () => {
    const versionId = "019f0000-0000-7000-8000-000000000001";
    const candidate = { status: "awaiting_review" as const, currentEditorVersionId: versionId };
    const before = structuredClone(candidate);
    expect(designAgentCurrentVersionApproved(candidate, versionId)).toBe(true);
    for (const approved of [undefined, null, "", "019f0000-0000-7000-8000-000000000002"])
      expect(designAgentCurrentVersionApproved(candidate, approved)).toBe(false);
    expect(designAgentCurrentVersionApproved(null, versionId)).toBe(false);
    for (const status of ["queued", "running", "needs_attention", "cancelled"] as const)
      expect(designAgentCurrentVersionApproved({ ...candidate, status }, versionId)).toBe(false);
    expect(candidate).toEqual(before);
  });
});

describe("design agent diagnostics", () => {
  it("explains plan blockers and uncertain billed calls using safe user-facing messages", () => {
    expect(designAgentErrorMessage("model_price_missing")).toContain("预估费用");
    expect(designAgentErrorMessage("order_image_transfer_not_allowed")).toContain("尚未授权");
    expect(designAgentErrorMessage("agent_model_submission_unknown")).toContain("不会自动再次付费提交");
    expect(designAgentErrorMessage("agent_model_submission_unknown")).toContain("核实后可导入原结果继续");
    expect(designAgentErrorMessage("agent_recipe_product_mismatch")).toContain("不匹配");
  });

  it("does not echo private text or inherited object properties from unknown codes", () => {
    const fallback = designAgentErrorMessage("new_future_error");
    expect(designAgentErrorMessage("private buyer name / token=synthetic-secret")).toBe(fallback);
    expect(designAgentErrorMessage("toString")).toBe(fallback);
    expect(fallback).not.toContain("synthetic-secret");
  });
  it.each([
    ["pillow_model_unverified", "gpt-image-2.5"], ["pillow_model_mismatch", "不匹配"],
    ["pillow_runtime_unavailable", "未就绪"], ["pillow_runtime_mismatch", "固定版本不一致"],
    ["agent_template_review_required", "尚未审核"], ["agent_pillow_factory_pin_invalid", "工厂标准"],
    ["agent_pillow_source_resolution_too_low", "不会缩小订单尺寸"], ["agent_pillow_geometry_invalid", "独立裁线"],
    ["agent_contour_workflow_invalid", "流程版本不受支持"], ["agent_contour_artwork_changed", "结果未提交"],
    ["agent_contour_attempt_invalid", "次数或参数范围"], ["agent_contour_result_missing", "完整检查结果"],
    ["agent_upscale_runtime_integrity_failed", "校验失败"], ["agent_upscale_policy_unsupported", "不能擅自更换"],
    ["agent_upscale_input_invalid", "原素材已保留"], ["agent_upscale_output_invalid", "不能送审"],
    ["agent_upscale_cleanup_failed", "清理未完成"], ["agent_upscale_cancelled", "已停止"],
    ["agent_model_response_uncheckpointed", "不会再次提交模型请求"],
    ["agent_model_response_processing_failed", "复用已保存结果"],
    ["agent_model_response_checkpoint_invalid", "校验未通过"],
    ["agent_scan_rejected", "不会登记为可用图片或自动重试"],
    ["agent_asset_storage_unavailable", "私有素材存储暂时不可用"],
    ["agent_asset_preview_failed", "无需重新调用模型"],
    ["agent_requirements_need_resolution", "顾客定制要求仍有待核对项"],
  ])("explains the bounded pillow failure %s with an actionable safe message", (code, expected) => {
    const message = designAgentErrorMessage(code);
    expect(message).toContain(expected);
    expect(message).not.toContain(code);
    expect(message).not.toContain("未识别");
  });
  it.each(["agent_upscale_busy", "agent_upscale_timeout", "agent_upscale_process_failed"])("explains local recovery without asking for a new paid model request: %s", code => {
    const message = designAgentErrorMessage(code);
    expect(message).toContain("恢复可重试步骤");
    expect(message).toContain("已完成");
    expect(message).toContain("复用");
    expect(message).not.toContain("重新抠图");
  });
});

describe("design agent result and billing evidence", () => {
  it("does not describe completed model output as uncertain merely because the provider supplied no bill", () => {
    expect(designAgentBillingNotice("unknown", [{ status: "completed" }, { status: "pending" }])).toBe("提供方实际账单尚未确认，保留已占用额度。");
    expect(designAgentBillingNotice("unknown", [{ status: "failed" }])).not.toContain("结果待核实");
  });
  it("describes result uncertainty only when a persisted step has that state", () => {
    expect(designAgentBillingNotice("unknown", [{ status: "completed" }, { status: "uncertain" }])).toBe("模型请求结果待核实，实际费用也未知，保留已占用额度。");
    for (const status of ["not_required", "estimated", "reported"] as const) expect(designAgentBillingNotice(status, [{ status: "completed" }])).toBeNull();
  });
});

describe("design agent read retry boundary", () => {
  it("backs off after network or server failures and stops after three retries", () => {
    expect([1, 2, 3, 4].map(failures => designAgentReadRetryDelay(new TypeError("network failed"), failures))).toEqual([2500, 5000, 10_000, null]);
    for (const status of [408, 429, 500, 503]) expect(designAgentReadRetryDelay({ status }, 1)).toBe(2500);
  });

  it("never retries permission failures, missing resources or malformed successful responses", () => {
    for (const status of [400, 401, 403, 404, 409, 422]) expect(designAgentReadRetryDelay({ status }, 1)).toBeNull();
    expect(designAgentReadRetryDelay(new Error("invalid response"), 1)).toBeNull();
    expect(designAgentReadRetryDelay(new TypeError("network"), 0)).toBeNull();
  });
});
