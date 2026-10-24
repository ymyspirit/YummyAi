import type { StudioRuntimeDescriptor } from "./serve-studio-runtime.mjs";
export { verifyStudioRuntime } from "./serve-studio-runtime.mjs";
export function sealStudioRuntime(root: string): Promise<StudioRuntimeDescriptor>;
