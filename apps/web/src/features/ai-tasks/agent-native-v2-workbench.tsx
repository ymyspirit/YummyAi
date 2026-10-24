"use client";
import { AgentNativeTaskFrame } from "./agent-native-task-frame";
import { nativeTaskV2Adapter } from "./agent-native-task-adapter";
export function AgentNativeV2Workbench() { return <AgentNativeTaskFrame adapter={nativeTaskV2Adapter} />; }
