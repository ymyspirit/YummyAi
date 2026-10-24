import { ModelSettings } from "../../../../features/creative-studio/model-settings";
import { studioRuntimeUrl } from "../../../../features/creative-studio/studio-configuration";
export const dynamic = "force-dynamic";
export const metadata = { title: "AI 模型配置 · YummyAI" };
export default function AiSettingsPage() { return <ModelSettings runtimeUrl={studioRuntimeUrl(process.env, "settings")} />; }
