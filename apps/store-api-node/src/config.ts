import path from "node:path";
import { nodeCheck } from "./error.js";

export interface StoreNodeCliConfiguration { operation: "init" | "enroll" | "run" | "work"; directory: string; passphrase: string; bundlePath?: string; intervalMs: number }
export function storeNodeOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { nodeCheck(false, "store_node_origin_invalid"); }
  nodeCheck(url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash
    && url.origin === raw.replace(/\/$/, ""), "store_node_origin_invalid");
  return url.origin;
}
export function storeNodeDirectory(raw: string): string {
  nodeCheck(path.isAbsolute(raw) && !raw.startsWith("\\\\") && !raw.startsWith("//") && !raw.includes("\0")
    && path.resolve(raw) !== path.parse(path.resolve(raw)).root, "store_node_directory_invalid");
  return path.resolve(raw);
}
export function checkStoreNodePassphrase(value: string | undefined): asserts value is string {
  nodeCheck(typeof value === "string" && Buffer.byteLength(value, "utf8") >= 16 && Buffer.byteLength(value, "utf8") <= 1024,
    "store_node_passphrase_invalid");
}
export function parseStoreNodeConfiguration(args: readonly string[], env: NodeJS.ProcessEnv = process.env): StoreNodeCliConfiguration {
  nodeCheck(process.platform === "win32", "store_node_platform_unsupported");
  const operation = args[0]; nodeCheck(operation === "init" || operation === "enroll" || operation === "run" || operation === "work", "store_node_arguments_invalid");
  const values = new Map<string, string>();
  for (const argument of args.slice(1)) {
    const match = /^--(dir|bundle|interval-ms)=(.+)$/.exec(argument);
    nodeCheck(match && !values.has(match[1]!), "store_node_arguments_invalid"); values.set(match[1]!, match[2]!);
  }
  const directory = storeNodeDirectory(values.get("dir") ?? "");
  const bundlePath = values.get("bundle");
  nodeCheck(operation === "enroll" ? Boolean(bundlePath) && !values.has("interval-ms") : !bundlePath, "store_node_arguments_invalid");
  const rawInterval = values.get("interval-ms") ?? "10000";
  nodeCheck((operation === "run" || operation === "work" || !values.has("interval-ms")) && /^\d{4,5}$/.test(rawInterval), "store_node_arguments_invalid");
  const intervalMs = Number(rawInterval); nodeCheck(intervalMs >= 1000 && intervalMs <= 60000, "store_node_arguments_invalid");
  const passphrase = env.STORE_NODE_KEY_PASSPHRASE; checkStoreNodePassphrase(passphrase);
  nodeCheck(!env.SSLKEYLOGFILE && !/(?:^|\s)--tls-keylog(?:=|\s|$)/.test(env.NODE_OPTIONS ?? "")
    && !process.execArgv.some(value => value === "--tls-keylog" || value.startsWith("--tls-keylog=")), "store_node_configuration_invalid");
  return { operation, directory, passphrase, ...(bundlePath ? { bundlePath: storeNodeDirectory(bundlePath) } : {}), intervalMs };
}
