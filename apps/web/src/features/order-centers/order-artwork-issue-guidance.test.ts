import { describe, expect, it } from "vitest";
import type { ProductionEditorPreflightIssue } from "@yummyai/contracts/pod/production-editor";
import { artworkIssueGuidance } from "./order-artwork-issue-guidance";

function issue(
  code: string,
  severity: ProductionEditorPreflightIssue["severity"],
  message = "服务端检查说明",
): ProductionEditorPreflightIssue {
  return { code, severity, message };
}

describe("artwork issue guidance", () => {
  it("keeps resolution repair at the ordered size without promising an upscale button", () => {
    const finding = issue("insufficient_image_resolution", "error", "当前约 99 PPI，目标 150 PPI");
    const guidance = artworkIssueGuidance(finding);
    expect(guidance.inspector).toBe("layer");
    expect(guidance.instruction).toContain("保持订单尺寸和图案比例");
    expect(guidance.instruction).toContain("经核验的高清素材");
    expect(guidance.instruction).toContain("交还制图者处理");
    expect(guidance.instruction).not.toMatch(/缩小|一键|自动超分/);
    expect(guidance.location).toContain("替换所选图片");
    expect(finding.message).toBe("当前约 99 PPI，目标 150 PPI");
  });

  it.each([
    ["physical_size_unconfirmed", "实际尺寸与尺寸口径已由工厂确认"],
    ["white_border_unconfirmed", "白边与黑裁线规则已确认"],
    ["barcode_rule_unconfirmed", "条码框宽、高、位置已确认"],
    ["visual_review_required", "已查看当前图稿的后台校对预览"],
    ["back_text_unconfirmed", "背片工艺与文字阅读方向已确认"],
  ])("directs %s to its real confirmation after checking evidence", (code, label) => {
    const guidance = artworkIssueGuidance(issue(code, "manual"));
    expect(guidance.inspector).toBe("confirm");
    expect(guidance.location).toContain("预检确认");
    expect(guidance.instruction).toContain(label);
    expect(guidance.instruction).not.toContain("已通过");
  });

  it("requires a confirmed measuring basis as well as the narrow-parts checkbox", () => {
    const guidance = artworkIssueGuidance(issue("narrow_parts_unconfirmed", "manual"));
    expect(guidance.inspector).toBe("process");
    expect(guidance.instruction).toContain("最细部位计量口径");
    expect(guidance.instruction).toContain("不少于 50 mm");
    expect(guidance.instruction).toContain("已按工厂口径人工检查最细部位");
  });

  it.each(["manual_size_basis", "manual_factory_preflight"])(
    "does not turn the persistent warning %s into a required confirmation",
    (code) => {
      const finding = Object.freeze(issue(code, "warning"));
      const guidance = artworkIssueGuidance(finding);
      expect(guidance.instruction).toContain("非阻断提醒");
      expect(guidance.instruction).toContain("无需为清除此提示修改图稿");
      expect(guidance.instruction).not.toMatch(/勾选|才能通过|尚未确认/);
      expect(finding.severity).toBe("warning");
      expect(guidance).not.toHaveProperty("severity");
    },
  );

  it("distinguishes a missing size basis from a factory-standard mismatch and its warning", () => {
    const missing = artworkIssueGuidance(issue("size_basis_unconfirmed", "manual"));
    const mismatch = artworkIssueGuidance(issue("factory_size_basis", "error"));
    expect(missing.instruction).toContain("订单标称最长边（mm）");
    expect(mismatch.instruction).toContain("图案尺寸");
    expect(missing.instruction).not.toContain("非阻断");
    expect(mismatch.instruction).not.toContain("非阻断");
    expect(missing.inspector).toBe("process");
    expect(mismatch.inspector).toBe("process");
  });

  it.each(["error", "manual", "warning"] as const)(
    "preserves unknown %s findings without claiming a resolution or guessing a fix",
    (severity) => {
      const finding = Object.freeze(issue("future_check", severity, "保留此条服务端原始检查说明。"));
      expect(artworkIssueGuidance(finding)).toEqual({
        title: "检查结果",
        instruction: "按上方提示核查当前版本；无法判断时交还制图者处理，修改后重新检查生产参数。",
        location: "生产编辑器 → 预检与出图 → 检查生产参数",
        inspector: "confirm",
      });
      expect(finding.severity).toBe(severity);
    },
  );

  it("uses the unknown-code fallback for inherited object property names", () => {
    const finding = issue("constructor", "warning", "未识别的服务端检查。");
    expect(artworkIssueGuidance(finding)).toMatchObject({
      title: "检查结果",
      instruction: "按上方提示核查当前版本；无法判断时交还制图者处理，修改后重新检查生产参数。",
      inspector: "confirm",
    });
  });
});
