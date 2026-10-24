"use client";
import type { AgentNativeV3View } from "@yummyai/contracts/ai/agent-native-v3";
import { NativeTaskEvidence, nativeTaskStatusLabels } from "./agent-native-reader-registry";
import { nativeTaskV3Adapter } from "./agent-native-task-adapter";
export const agentNativeV3StatusLabels = nativeTaskStatusLabels;
export function AgentNativeV3Evidence(props: { run: AgentNativeV3View; onDenied(): void }) { return <NativeTaskEvidence {...props} adapter={nativeTaskV3Adapter} />; }
