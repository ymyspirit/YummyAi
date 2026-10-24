import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { requireAgentNativeV4Environment } from "./require-agent-native-v4-environment.mjs";

/** Reuse original V4 isolation, with a dedicated lane; reject before connection. */
export function requireShipmentCreateEnvironment(environment = process.env, target = "current", browser = false) {
  if (environment.E2E_SHIPMENT_CREATE_ISOLATED !== "1" || target !== "current")
    throw new Error("Shipment creation requires its explicit disposable current187 isolation flag");
  const isolated = requireAgentNativeV4Environment(environment, target, browser);
  return { ...isolated, lane: fileURLToPath(new URL("../../tmp/shipment-create-20261023-0c7e35a1/qa", import.meta.url)) };
}
