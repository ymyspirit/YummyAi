import { NativeRuntimeEngine, type NativeRuntimeOptions } from "./agent-native-engine.js";
import type { NativeV3Family } from "./agent-native-protocol.js";
import { agentNativeV3Protocol } from "./agent-native-v3-protocol.js";

export class AgentNativeV3Runtime extends NativeRuntimeEngine<NativeV3Family> {
  constructor(options: NativeRuntimeOptions & { resources: NonNullable<NativeRuntimeOptions["resources"]>; fulfillment: NonNullable<NativeRuntimeOptions["fulfillment"]> }) {
    super(options, agentNativeV3Protocol);
  }
}
