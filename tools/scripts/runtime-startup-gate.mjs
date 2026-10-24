import { createHash } from "node:crypto";
import net from "node:net";
import path from "node:path";
import process from "node:process";

const held = new WeakMap();
const rootKey = root => {
  const absolute = path.resolve(root);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
};
const fail = code => { throw new Error("ORDINARY_RUNTIME_" + code); };

/** OS-owned coordination; retain the existing Windows pipe namespace so old
 * maintenance callers and the supported CLIs exclude one another. */
export async function acquireStartupGate(root) {
  const key = rootKey(root), digest = createHash("sha256").update(key).digest("hex");
  const server = net.createServer(socket => socket.destroy());
  const address = process.platform === "win32"
    ? { path: `\\\\.\\pipe\\yummyai-ordinary-start-${digest.slice(0, 24)}`, exclusive: true }
    : { host: "127.0.0.1", port: 49152 + (parseInt(digest.slice(0, 8), 16) % 16384), exclusive: true };
  await new Promise((resolve, reject) => {
    server.once("error", () => reject(new Error("ORDINARY_RUNTIME_ANOTHER_START_IN_PROGRESS")));
    server.listen(address, resolve);
  });
  held.set(server, key);
  server.once("close", () => held.delete(server));
  return server;
}

/** Only a live local object acquired here can be borrowed; no serializable or
 * caller-selected boolean/path can bypass the OS reservation. */
export function assertStartupGate(root, gate) {
  if (!gate || held.get(gate) !== rootKey(root) || !gate.listening) fail("INVALID_STARTUP_GATE");
  return gate;
}

export async function closeStartupGate(gate) {
  if (!held.has(gate) || !gate.listening) fail("INVALID_STARTUP_GATE");
  await new Promise((resolve, reject) => gate.close(error => error
    ? reject(new Error("ORDINARY_RUNTIME_STARTUP_GATE_CLOSE_FAILED")) : resolve()));
}

export async function withStartupGate(root, action, gate) {
  if (gate !== undefined) return action(assertStartupGate(root, gate));
  const owned = await acquireStartupGate(root);
  try { return await action(owned); }
  finally { await closeStartupGate(owned); }
}
