import { NativeRuntimeEngine, type NativeRuntimeOptions } from "./agent-native-engine.js";
import { agentNativeV1Protocol } from "./agent-native-v1-protocol.js";

/** The original native-v1 ABI and 32-step policy use the common paid state machine. */
export class AgentNativeRuntime extends NativeRuntimeEngine {
  constructor(options: Omit<NativeRuntimeOptions, "resources">) { super(options, agentNativeV1Protocol); }
}
