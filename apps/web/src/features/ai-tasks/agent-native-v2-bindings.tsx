"use client";
import { AgentNativeV2BindingSchema, AgentNativeV2ReadKeySchema, type AgentNativeV2Binding, type AgentNativeV2ReadKey, type AgentNativeV2Workspace } from "@yummyai/contracts/ai/agent-native-v2";
import { NativeTaskBindings, NativeTaskBindingSummary, nativeTaskReadLabels } from "./agent-native-reader-registry";
import { nativeTaskV2Adapter } from "./agent-native-task-adapter";
export const agentNativeV2ReadLabels = Object.fromEntries(AgentNativeV2ReadKeySchema.options.map(key => [key, nativeTaskReadLabels[key]])) as Record<AgentNativeV2ReadKey, string>;
export function AgentNativeV2BindingSummary(props: { bindings: readonly AgentNativeV2Binding[]; onRemove?(index: number): void; disabled?: boolean; removing?: string | null }) {
  return <NativeTaskBindingSummary {...props} adapter={nativeTaskV2Adapter} />;
}
export function AgentNativeV2Bindings(props: { workspace: AgentNativeV2Workspace; authority: string; value: AgentNativeV2Binding[]; disabled: boolean; onChange(value: AgentNativeV2Binding[]): void; onDenied(): void; onPendingChange(pending: boolean): void }) {
  return <NativeTaskBindings {...props} adapter={nativeTaskV2Adapter} onChange={values => props.onChange(values.map(value => AgentNativeV2BindingSchema.parse(value)))} />;
}
