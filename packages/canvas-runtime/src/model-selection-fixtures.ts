import type { AiConfig } from "@/stores/use-config-store";
import type { StudioModel } from "@yummyai/contracts/pod/studio-personal";

// Unit-only metadata. No provider, credentials or execution environment is used.
export const modelSelectionFixtures: StudioModel[] = [
  { id: "019a0000-0000-7000-8000-000000000011", model: "same-name", label: "图片渠道甲", providerLabel: "甲", capability: "image", isDefault: false, selectionRevision: "a".repeat(64) },
  { id: "019a0000-0000-7000-8000-000000000012", model: "same-name", label: "图片渠道乙", providerLabel: "乙", capability: "image", isDefault: false, selectionRevision: "b".repeat(64) },
  { id: "019a0000-0000-7000-8000-000000000013", model: "same-name", label: "视频渠道", providerLabel: "丙", capability: "video", isDefault: false, selectionRevision: "c".repeat(64) },
  { id: "019a0000-0000-7000-8000-000000000014", model: "configured-text", label: "文字渠道", providerLabel: "丁", capability: "text", isDefault: false, selectionRevision: "d".repeat(64) },
];
export function modelSelectionConfig(patch: Partial<AiConfig> = {}): AiConfig {
  return { channelMode: "remote", baseUrl: "", apiKey: "", apiFormat: "openai", channels: [], models: [], model: "", imageModel: "", videoModel: "", textModel: "", audioModel: "", audioVoice: "", audioFormat: "mp3", audioSpeed: "1", audioInstructions: "", videoSeconds: "4", vquality: "720", videoGenerateAudio: "false", videoWatermark: "false", videoMode: "frames", systemPrompt: "", reasoningEffort: "auto", quality: "auto", size: "1:1", background: "auto", count: "1", canvasImageCount: "1", proxyEnabled: false, proxyUrl: "", nodeRegenerateBehavior: "new-node", autoFocusOnSelect: false, ...patch };
}
