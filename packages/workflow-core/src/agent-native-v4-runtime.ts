import { NativeRuntimeEngine, type NativeRuntimeOptions } from "./agent-native-engine.js";
import type { NativeV4Family } from "./agent-native-protocol.js";
import { agentNativeV4Protocol } from "./agent-native-v4-protocol.js";

/** Only the protocol is new; paid checkpoints, leases and recovery stay in the shared engine. */
export class AgentNativeV4Runtime extends NativeRuntimeEngine<NativeV4Family> {
  constructor(options: NativeRuntimeOptions & {
    resources: NonNullable<NativeRuntimeOptions["resources"]>;
    fulfillment: NonNullable<NativeRuntimeOptions["fulfillment"]>;
    commandDefinitions: NonNullable<NativeRuntimeOptions["commandDefinitions"]>;
  }) {
    super(options, agentNativeV4Protocol);
  }
}
