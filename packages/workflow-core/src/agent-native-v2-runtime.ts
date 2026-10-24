import { NativeRuntimeEngine, type NativeRuntimeOptions } from "./agent-native-engine.js";
import { agentNativeV2Protocol } from "./agent-native-v2-protocol.js";

export class AgentNativeV2Runtime extends NativeRuntimeEngine {
  constructor(options: NativeRuntimeOptions & { resources: NonNullable<NativeRuntimeOptions["resources"]> }) {
    super(options, agentNativeV2Protocol);
  }
}
