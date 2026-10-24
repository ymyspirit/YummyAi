import { describe, expect, it } from "vitest";
import { createPillowPipeline, PILLOW_HALF_BODY_PROMPT_VERSION, type DesignAutomationStep } from "@yummyai/contracts/pod/design-automation";
import { pillowCutoutPrompt } from "./pillow-cutout-prompt.js";

type CutoutStep = Extract<DesignAutomationStep, { tool: "cutout_subject" }>;
const step: CutoutStep = { id: "cutout", tool: "cutout_subject", outputRole: "subject_image", dependsOn: [], sourceImageId: "019f7600-0000-7000-8000-000000000001", enhancedStepId: null, subject: "head" };
const pipeline = createPillowPipeline({ engine: "realesrgan-ncnn-vulkan", release: "20220424", model: "realesrgan-x4plus", scale: 4, tileSize: 256, threads: "1:1:1", alphaStrategy: "source-alpha-lanczos3-rgb-nearest-fill-v1", binarySha256: "a".repeat(64), modelBinSha256: "b".repeat(64), modelParamSha256: "c".repeat(64) });

describe("pinned pillow cutout prompts", () => {
  it.each(["head", "body"] as const)("keeps the previous %s prompt exact with and without the versioned pipeline", subject => {
    for (const enabled of [false, true]) {
      const expected = `只抠出照片中的${subject === "head" ? "完整头部，保留头顶、双耳与下巴，去除身体" : "完整主体全身，保留所有手脚、耳朵和尾巴"}。保持原图主体身份、外观和已有美化结果不变。${enabled ? "为了制作异形抱枕，请在本次抠图中清理突出主体自然轮廓的细长胡须；不要删除耳朵、手脚、尾巴或短毛，不要修改眼睛、面部花纹与神态。主体四周留出透明空间，不得碰到画布边缘。" : ""}输出真实透明背景，不加文字、白边、描边、裁切线或条码。`;
      expect(pillowCutoutPrompt({ ...step, subject }, enabled ? pipeline : undefined)).toBe(expected);
    }
  });
  it.each([false, true])("keeps half-body to the existing head and upper torso without inventing absent body parts (pipeline=%s)", enabled => {
    const prompt = pillowCutoutPrompt({ ...step, subject: "half_body", subjectPromptVersion: PILLOW_HALF_BODY_PROMPT_VERSION }, enabled ? pipeline : undefined);
    expect(prompt).toContain("完整头部、双耳、下巴及躯干上半部");
    expect(prompt).toContain("去掉下半身与背景");
    expect(prompt).toContain("不补画被遮挡或原图之外的身体、手脚、尾巴或毛发");
    expect(prompt).toContain("不把半身改成全身");
    expect(prompt).toContain("输出真实透明背景");
    expect(prompt).not.toContain("完整主体全身，保留所有手脚");
    if (enabled) expect(prompt).toContain("不要删除半身保留范围内");
  });
  it("rejects a half-body step without its pinned instruction before a model request", () => {
    expect(() => pillowCutoutPrompt({ ...step, subject: "half_body" }, pipeline)).toThrow("agent_pillow_subject_prompt_invalid");
  });
  it("keeps every foreground person and held pet with their original grouping, without selecting one main subject", () => {
    const prompt = pillowCutoutPrompt({ ...step, subject: "half_body", subjectPromptVersion: PILLOW_HALF_BODY_PROMPT_VERSION }, pipeline);
    expect(prompt).toContain("必须保留所有前景合影人物和动物");
    expect(prompt).toContain("人物数量、动物数量、相对位置、比例及遮挡关系保持不变");
    expect(prompt).toContain("不能只选择单一主角");
    expect(prompt).toContain("怀中宠物保留原图已有的全部可见部分");
    expect(prompt).toContain("不得因人物的半身裁切而删除宠物或裁掉宠物的可见部位");
  });
  it("preserves an already assembled transparent group image instead of separating or rearranging it", () => {
    const prompt = pillowCutoutPrompt({ ...step, subject: "half_body", subjectPromptVersion: PILLOW_HALF_BODY_PROMPT_VERSION }, pipeline);
    expect(prompt).toContain("若原图已经拼合并含透明区域，保持整体构图和已有透明区域");
    expect(prompt).toContain("不拆分、不重新排列、不填充透明区域");
  });
});
