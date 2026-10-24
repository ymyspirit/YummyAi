"use client";
import { AgentNativeTaskFrame } from "./agent-native-task-frame";
import { nativeTaskV4Adapter } from "./agent-native-task-adapter";
import "./agent-native-v4.css";

export function AgentNativeV4Workbench() { return <AgentNativeTaskFrame adapter={nativeTaskV4Adapter} />; }
