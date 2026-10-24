"use client";
import type { AgentNativeV2View } from "@yummyai/contracts/ai/agent-native-v2";
import { NativeTaskEvidence, nativeTaskStatusLabels } from "./agent-native-reader-registry";
import { nativeTaskV2Adapter } from "./agent-native-task-adapter";
export { NativeClaims } from "./agent-native-reader-registry";
export const agentNativeV2StatusLabels = nativeTaskStatusLabels;
export function AgentNativeV2Evidence(props: { run: AgentNativeV2View; onDenied(): void }) { return <NativeTaskEvidence {...props} adapter={nativeTaskV2Adapter} />; }
