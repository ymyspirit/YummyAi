import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { requireProductionEditorFixtureEnvironment } from "../testing/production-editor-fixture-environment.mjs";

const nonce = "a".repeat(32), otherNonce = "b".repeat(32);
const failureMessage = "PRODUCTION_EDITOR_FIXTURE_ENVIRONMENT_INVALID";
const valid = {
  E2E_ISOLATED_DAILY: "1",
  DATABASE_URL: `postgresql://synthetic:synthetic@127.0.0.1:55432/order_daily_e2e_${nonce}`,
  S3_PRIVATE_BUCKET: `order-daily-e2e-${nonce}`,
  REDIS_URL: "redis://127.0.0.1:56379",
  E2E_DISPOSABLE_REDIS_URL: "redis://127.0.0.1:56379",
  E2E_DISPOSABLE_REDIS_CONTAINER: `yummyai-daily-${nonce}`,
};
const refuses = environment => assert.throws(() => requireProductionEditorFixtureEnvironment(environment), { message: failureMessage });

test("render fixture accepts only the runner's matched disposable resources without mutating its environment", () => {
  const original = { ...valid }, result = requireProductionEditorFixtureEnvironment(original);
  assert.deepEqual(result, { isolatedDaily: true, databaseUrl: valid.DATABASE_URL, redisUrl: valid.REDIS_URL,
    bucket: valid.S3_PRIVATE_BUCKET, nonce, designFault: undefined });
  assert.deepEqual(original, valid);
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    const redisUrl = `redis://${host}:56379`;
    const local = { ...valid, DATABASE_URL: `postgres://synthetic:synthetic@${host}:55432/order_daily_e2e_${nonce}`,
      REDIS_URL: redisUrl, E2E_DISPOSABLE_REDIS_URL: redisUrl };
    assert.equal(requireProductionEditorFixtureEnvironment(local).redisUrl, redisUrl);
  }
});

test("render fixture refuses ordinary, missing and malformed database admission", () => {
  for (const environment of [
    {}, { ...valid, E2E_ISOLATED_DAILY: undefined }, { ...valid, E2E_ISOLATED_DAILY: "0" },
    { ...valid, DATABASE_URL: undefined }, { ...valid, DATABASE_URL: "invalid" },
    { ...valid, DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:55432/yummyai" },
    { ...valid, DATABASE_URL: valid.DATABASE_URL.replace(nonce, "A".repeat(32)) },
    { ...valid, DATABASE_URL: valid.DATABASE_URL.replace("postgresql:", "http:") },
  ]) refuses(environment);
});

test("render fixture requires the same nonce for database, private bucket and named Redis container", () => {
  for (const changes of [
    { S3_PRIVATE_BUCKET: undefined }, { S3_PRIVATE_BUCKET: "ordinary-private" },
    { S3_PRIVATE_BUCKET: `order-daily-e2e-${otherNonce}` },
    { E2E_DISPOSABLE_REDIS_CONTAINER: undefined }, { E2E_DISPOSABLE_REDIS_CONTAINER: "infra-redis-1" },
    { E2E_DISPOSABLE_REDIS_CONTAINER: `yummyai-daily-${otherNonce}` },
  ]) refuses({ ...valid, ...changes });
});

test("render fixture rejects database redirects and non-loopback database hosts", () => {
  for (const databaseUrl of [valid.DATABASE_URL.replace("127.0.0.1", "db.example.invalid"),
    valid.DATABASE_URL + "?host=127.0.0.1&database=yummyai", valid.DATABASE_URL + "#ordinary",
  ]) refuses({ ...valid, DATABASE_URL: databaseUrl });
});

test("render fixture requires the exact runner Redis URL rather than a merely equivalent URL", () => {
  for (const changes of [
    { REDIS_URL: undefined }, { E2E_DISPOSABLE_REDIS_URL: undefined },
    { E2E_DISPOSABLE_REDIS_URL: "redis://127.0.0.1:56380" },
    { E2E_DISPOSABLE_REDIS_URL: "redis://localhost:56379" },
    { E2E_DISPOSABLE_REDIS_URL: valid.REDIS_URL + "/" },
  ]) refuses({ ...valid, ...changes });
});

test("render fixture refuses remote or ambiguous Redis endpoints even when both URL claims agree", () => {
  for (const redisUrl of [
    "invalid", "rediss://127.0.0.1:56379", "redis://cache.example.invalid:56379", "redis://127.0.0.1",
    "redis://127.0.0.1:0", "redis://127.0.0.1:65536", "redis://synthetic:synthetic@127.0.0.1:56379",
    "redis://127.0.0.1:56379/1", "redis://127.0.0.1:56379?db=1", "redis://127.0.0.1:56379#ordinary",
    "http://127.0.0.1:56379", "file:///synthetic-redis.sock",
  ]) refuses({ ...valid, REDIS_URL: redisUrl, E2E_DISPOSABLE_REDIS_URL: redisUrl });
});

test("render fixture validates synthetic fault modes before any client is admitted", () => {
  for (const designFault of ["unknown_pillow_cutout", "expire_order_before_response"])
    assert.equal(requireProductionEditorFixtureEnvironment({ ...valid, E2E_DESIGN_AGENT_FAULT: designFault }).designFault, designFault);
  for (const designFault of ["", "ordinary", "disable_scan", "unknown_pillow_cutout "])
    refuses({ ...valid, E2E_DESIGN_AGENT_FAULT: designFault });
});

test("render fixture rejection exposes no supplied credentials or URLs", () => {
  const secret = "synthetic-rejection-canary";
  let failure;
  try { requireProductionEditorFixtureEnvironment({ ...valid, DATABASE_URL: `postgres://synthetic:${secret}@db.example.invalid/ordinary` }); }
  catch (error) { failure = error; }
  assert.equal(failure?.message, failureMessage);
  assert.equal(String(failure?.stack).includes(secret), false);
  assert.equal(String(failure?.stack).includes("db.example.invalid"), false);
});

/** TCP sentinels are owned by this test only. They never speak PG/Redis/S3 and
 * immediately destroy any unexpected connection so cleanup cannot hang. */
async function sentinel() {
  let connections = 0;
  const sockets = new Set();
  const server = createServer(socket => {
    connections++;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.destroy();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { port: server.address().port, connections: () => connections, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

test("the actual Worker child rejects unsafe admission before touching database, Redis or storage", { timeout: 90_000 }, async t => {
  const sentinels = [];
  try {
    for (let index = 0; index < 3; index++) sentinels.push(await sentinel());
    const [database, redis, storage] = sentinels;
    const resources = { ...valid,
      DATABASE_URL: `postgresql://synthetic:synthetic@127.0.0.1:${database.port}/order_daily_e2e_${nonce}`,
      REDIS_URL: `redis://127.0.0.1:${redis.port}`, E2E_DISPOSABLE_REDIS_URL: `redis://127.0.0.1:${redis.port}`,
      S3_ENDPOINT: `http://127.0.0.1:${storage.port}`, S3_REGION: "us-east-1",
      S3_ACCESS_KEY_ID: "synthetic", S3_SECRET_ACCESS_KEY: "synthetic",
    };
    for (const [name, changes] of [
      ["missing isolation flag", { E2E_ISOLATED_DAILY: undefined }],
      ["ordinary database", { DATABASE_URL: resources.DATABASE_URL.replace(`order_daily_e2e_${nonce}`, "yummyai") }],
      ["ordinary bucket", { S3_PRIVATE_BUCKET: "ordinary-private" }],
      ["missing Redis proof", { E2E_DISPOSABLE_REDIS_URL: undefined }],
      ["different Redis URL", { E2E_DISPOSABLE_REDIS_URL: `redis://127.0.0.1:${database.port}` }],
      ["different Redis container", { E2E_DISPOSABLE_REDIS_CONTAINER: `yummyai-daily-${otherNonce}` }],
      ["unknown synthetic fault", { E2E_DESIGN_AGENT_FAULT: "disable_scan" }],
    ]) await t.test(name, async () => {
      const environment = { ...process.env, ...resources, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1",
        TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../apps/worker/tsconfig.json", import.meta.url)) };
      delete environment.E2E_DESIGN_AGENT_FAULT;
      for (const [key, value] of Object.entries(changes)) {
        if (value === undefined) delete environment[key];
        else environment[key] = value;
      }
      let failure;
      try {
        await promisify(execFile)(process.execPath, ["--import", new URL("../../apps/worker/node_modules/tsx/dist/loader.mjs", import.meta.url).href,
          fileURLToPath(new URL("../../apps/worker/e2e/production-editor-worker.mts", import.meta.url))],
        { cwd: fileURLToPath(new URL("../../apps/worker/", import.meta.url)), env: environment,
          windowsHide: true, timeout: 10_000, maxBuffer: 256 * 1024 });
      } catch (error) { failure = error; }
      assert.equal(failure?.code, 1, "The Worker must reject instead of hanging, connecting or becoming ready");
      assert.match(failure.stderr, new RegExp(failureMessage));
      assert.doesNotMatch(failure.stdout, /PRODUCTION_EDITOR_WORKER_READY|SYNTHETIC_DESIGN_MODEL_CALL/);
      for (const resource of sentinels) assert.equal(resource.connections(), 0, "No client may connect before fixture admission");
    });
  } finally { await Promise.all(sentinels.map(resource => resource.close())); }
});
