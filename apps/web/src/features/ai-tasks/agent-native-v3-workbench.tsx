"use client";
import { AgentNativeTaskFrame } from "./agent-native-task-frame";
import { nativeTaskV3Adapter } from "./agent-native-task-adapter";
export function AgentNativeV3Workbench() { return <AgentNativeTaskFrame adapter={nativeTaskV3Adapter} />; }
