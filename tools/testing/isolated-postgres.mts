import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";

const exec = promisify(execFile);
const operationLabel = "io.yummyai.test.operation", kindLabel = "io.yummyai.test.kind";
const kind = "production-command-restart";
export type OwnedRestartPostgres = { operationId: string; container: string; volume: string; containerId: string; imageId: string; port: number };
async function docker(args: string[], environment = process.env) {
  const result = await exec("docker", args, { encoding: "utf8", windowsHide: true, timeout: 45_000, env: environment, maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}
const lines = (value: string) => value ? value.split(/\r?\n/) : [];
export async function assertOwnedRestartPostgres(identity: OwnedRestartPostgres) {
  if (!/^[a-f0-9]{32}$/.test(identity.operationId) || identity.container !== `yummyai-prod-restart-${identity.operationId}` ||
    identity.volume !== `yummyai-prod-restart-data-${identity.operationId}` || !Number.isInteger(identity.port) || identity.port < 1 || identity.port > 65535 || [5432, 55432].includes(identity.port)) throw Error("Invalid isolated Postgres identity");
  const [container] = JSON.parse(await docker(["container", "inspect", identity.container]));
  const [volume] = JSON.parse(await docker(["volume", "inspect", identity.volume]));
  if (container.Id !== identity.containerId || container.Image !== identity.imageId ||
    container.Config.Labels?.[operationLabel] !== identity.operationId || container.Config.Labels?.[kindLabel] !== kind ||
    volume.Labels?.[operationLabel] !== identity.operationId || volume.Labels?.[kindLabel] !== kind ||
    !container.Mounts.some((mount: { Type: string; Name: string; Destination: string }) => mount.Type === "volume" && mount.Name === identity.volume && mount.Destination === "/var/lib/postgresql/data") ||
    !container.NetworkSettings.Ports["5432/tcp"]?.some((binding: { HostIp: string; HostPort: string }) => binding.HostIp === "127.0.0.1" && Number(binding.HostPort) === identity.port)) throw Error("Isolated Postgres ownership or address changed");
  return { containerId: container.Id as string, startedAt: container.State.StartedAt as string, running: container.State.Running as boolean };
}
export async function waitRestartPostgres(identity: OwnedRestartPostgres) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const owner = await assertOwnedRestartPostgres(identity);
    if (!owner.running) throw Error("Isolated Postgres is not running");
    try { await docker(["exec", identity.container, "pg_isready", "-U", "fixture_owner", "-d", "restart_host"]); return owner; }
    catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  throw Error("Isolated Postgres did not become ready");
}
export async function restartOwnedPostgres(identity: OwnedRestartPostgres) {
  const before = await assertOwnedRestartPostgres(identity);
  await docker(["restart", "--time", "0", identity.container]);
  const after = await waitRestartPostgres(identity);
  if (after.containerId !== before.containerId || after.startedAt === before.startedAt) throw Error("Postgres restart was not observed");
  return { before, after, stopTimeoutSeconds: 0, dataVolume: identity.volume };
}
export async function createRestartPostgres(operationId: string) {
  if (!/^[a-f0-9]{32}$/.test(operationId)) throw Error("Fresh isolated operation ID required");
  const container = `yummyai-prod-restart-${operationId}`, volume = `yummyai-prod-restart-data-${operationId}`;
  if (lines(await docker(["ps", "--all", "--format", "{{.Names}}"])) .includes(container) || lines(await docker(["volume", "ls", "--format", "{{.Name}}"])) .includes(volume)) throw Error("Isolated Postgres target already exists");
  const imageId = await docker(["image", "inspect", "postgres:17-alpine", "--format", "{{.Id}}"]);
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw Error("Installed Postgres image is unavailable");
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => {
      const address = server.address(); if (!address || typeof address === "string") return server.close(() => reject(Error("No isolated port")));
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
  if ([5432, 55432].includes(port)) throw Error("Reserved ordinary Postgres port refused");
  await docker(["volume", "create", "--label", `${operationLabel}=${operationId}`, "--label", `${kindLabel}=${kind}`, volume]);
  const password = randomBytes(32).toString("base64url");
  try {
    const containerId = await docker(["run", "--detach", "--name", container, "--label", `${operationLabel}=${operationId}`, "--label", `${kindLabel}=${kind}`,
      "--env", "POSTGRES_PASSWORD", "--env", "POSTGRES_USER=fixture_owner", "--env", "POSTGRES_DB=restart_host",
      "--publish", `127.0.0.1:${port}:5432`, "--volume", `${volume}:/var/lib/postgresql/data`, imageId, "-c", "max_connections=80"],
    { ...process.env, POSTGRES_PASSWORD: password });
    const identity = { operationId, container, volume, containerId, imageId, port };
    await waitRestartPostgres(identity);
    const url = new URL(`postgres://fixture_owner@127.0.0.1:${port}/restart_host`); url.password = password;
    return { identity, databaseUrl: url.href };
  } catch (error) {
    await cleanupFailedCreation(operationId, container, volume); throw error;
  }
}
async function cleanupFailedCreation(operationId: string, container: string, volume: string) {
  if (lines(await docker(["ps", "--all", "--format", "{{.Names}}"])) .includes(container)) {
    const [value] = JSON.parse(await docker(["container", "inspect", container]));
    if (value.Config.Labels?.[operationLabel] !== operationId || value.Config.Labels?.[kindLabel] !== kind) throw Error("Refuse unowned failed container cleanup");
    await docker(["container", "rm", "--force", container]);
  }
  const [value] = JSON.parse(await docker(["volume", "inspect", volume]));
  if (value.Labels?.[operationLabel] !== operationId || value.Labels?.[kindLabel] !== kind) throw Error("Refuse unowned failed volume cleanup");
  await docker(["volume", "rm", volume]);
}
export async function removeRestartPostgres(identity: OwnedRestartPostgres) {
  await assertOwnedRestartPostgres(identity);
  await docker(["container", "rm", "--force", identity.container]);
  const [volume] = JSON.parse(await docker(["volume", "inspect", identity.volume]));
  if (volume.Labels?.[operationLabel] !== identity.operationId || volume.Labels?.[kindLabel] !== kind) throw Error("Refuse unowned volume cleanup");
  await docker(["volume", "rm", identity.volume]);
  const containerAbsent = !lines(await docker(["ps", "--all", "--format", "{{.Names}}"])) .includes(identity.container);
  const volumeAbsent = !lines(await docker(["volume", "ls", "--format", "{{.Name}}"])) .includes(identity.volume);
  if (!containerAbsent || !volumeAbsent) throw Error("Isolated Postgres resources remain");
  return { containerAbsent, volumeAbsent };
}
