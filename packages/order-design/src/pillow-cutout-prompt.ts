import {
  PILLOW_HALF_BODY_CUTOUT_INSTRUCTION, PILLOW_HALF_BODY_PROMPT_VERSION,
  type DesignAutomationStep, type PillowPipeline,
} from "@yummyai/contracts/pod/design-automation";
import { OrderDesignError } from "./types.js";

/** Existing subjects retain their exact prompt. Half-body is a separate pinned
 * instruction so resuming an old head/body snapshot never changes its meaning. */
export function pillowCutoutPrompt(step: Extract<DesignAutomationStep, { tool: "cutout_subject" }>, pipeline?: PillowPipeline): string {
  if (step.subject === "half_body") {
    if (step.subjectPromptVersion !== PILLOW_HALF_BODY_PROMPT_VERSION) throw new OrderDesignError("agent_pillow_subject_prompt_invalid");
    return `${PILLOW_HALF_BODY_CUTOUT_INSTRUCTION}保持原图主体身份、外观、姿态和已有美化结果不变。${pipeline ? "为了制作异形抱枕，请在本次抠图中清理突出主体自然轮廓的细长胡须；不要删除半身保留范围内的耳朵、手部、前爪或短毛，不要修改眼睛、面部花纹与神态。主体四周留出透明空间，不得碰到画布边缘。" : ""}输出真实透明背景，不加文字、白边、描边、裁切线或条码。`;
  }
  return `只抠出照片中的${step.subject === "head" ? "完整头部，保留头顶、双耳与下巴，去除身体" : "完整主体全身，保留所有手脚、耳朵和尾巴"}。保持原图主体身份、外观和已有美化结果不变。${pipeline ? "为了制作异形抱枕，请在本次抠图中清理突出主体自然轮廓的细长胡须；不要删除耳朵、手脚、尾巴或短毛，不要修改眼睛、面部花纹与神态。主体四周留出透明空间，不得碰到画布边缘。" : ""}输出真实透明背景，不加文字、白边、描边、裁切线或条码。`;
}
