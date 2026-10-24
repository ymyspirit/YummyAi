import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { appImageReviewSha, reviewAppImageChange, validateOfficialAppImage } from "../scripts/lib/unified-compose-image-review.mjs";

// Pure synthetic normalized Docker comparisons; no Docker, files, or network.
const imageId = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const oldId = imageId("synthetic-old"), newId = imageId("synthetic-new"), privateValue = "SYNTHETIC-PRIVATE-$VALUE";
const repositories = { sub2api: "weishaw/sub2api", "canvas-legacy": "ghcr.io/basketikun/infinite-canvas" };
const allowed = ["command", "entrypoint", "environment", "exposedPorts", "healthcheck", "imageID", "labels", "stopSignal", "user", "workingDirectory"];
function fixture() {
  return { name: "sub2api", imageID: oldId, environment: { PATH: "/usr/bin", SYNTHETIC_PRIVATE: privateValue }, command: ["serve"], entrypoint: ["/app/start"], user: "1001", workingDirectory: "/app",
    healthcheck: { test: ["CMD", "/app/check"], interval: 30 }, stopSignal: "SIGTERM", exposedPorts: ["8080/tcp"], labels: { "synthetic.label": privateValue },
    hostname: null, domainname: "", tty: false, stdinOpen: false, stdinOnce: false, stopTimeout: null,
    mounts: [{ type: "bind", source: "/synthetic/data", target: "/app/data", read_only: false }], tmpfs: {}, ports: [{ target: 8080, published: "8080", host_ip: "127.0.0.1", protocol: "tcp" }],
    networks: { original: { aliases: ["sub2api", "operator-alias"], ipv4_address: "172.30.0.4" } }, constraints: { privileged: false, read_only: false, mem_limit: 536870912, security_opt: ["no-new-privileges:true"], cap_drop: ["ALL"] },
    maskedPaths: ["/proc/kcore"], readonlyPaths: ["/proc/sys"] };
}
function upgraded(before) {
  return { ...globalThis.structuredClone(before), imageID: newId, environment: { PATH: "/new/bin", SYNTHETIC_PRIVATE: privateValue, VERSION: "v2" }, command: ["serve", "--new"], entrypoint: ["/new/start"], user: "1002:1002", workingDirectory: "/new",
    healthcheck: { test: ["CMD", "/new/check"], interval: 10 }, stopSignal: "SIGINT", exposedPorts: ["8080/tcp", "9090/tcp"], labels: { "synthetic.label": privateValue, "org.opencontainers.image.version": "v2" } };
}
function review(before, after, overrides = {}) { return reviewAppImageChange({ before, after, expectedImageId: newId, reviewedSha256: appImageReviewSha(after), ...overrides }); }
function frozen(value) { if (value && typeof value === "object") { Object.freeze(value); Object.values(value).forEach(frozen); } return value; }
const fixedError = code => error => { assert.equal(error.message, `UNIFIED_COMPOSE_${code}`); assert.ok(!error.message.includes(privateValue)); return true; };

for (const [service, repository] of Object.entries(repositories)) {
  test(`${service} admits only its exact official repository with an explicit tag or sha256 digest`, () => {
    for (const image of [`${repository}:v2.4.1-rc_2`, `${repository}@${newId}`, `${repository}:v2.4.1@${newId}`]) assert.equal(validateOfficialAppImage(service, image), image);
    assert.equal(validateOfficialAppImage(service, `${repository}:${"a".repeat(128)}`), `${repository}:${"a".repeat(128)}`);
  });
  test(`${service} rejects moving tags without case or digest loopholes`, () => {
    for (const tag of ["latest", "LATEST", "Latest", "main", "MAIN", "mAiN", "master", "MASTER", "MaStEr"]) {
      for (const suffix of ["", `@${newId}`]) assert.throws(() => validateOfficialAppImage(service, `${repository}:${tag}${suffix}`), fixedError("EXPLICIT_OFFICIAL_APP_IMAGE_REQUIRED"));
    }
  });
  test(`${service} rejects implicit, malformed, aliased and foreign image references`, () => {
    for (const image of [repository, `${repository}:`, `${repository}:bad/tag`, `${repository}:bad tag`, `${repository}:v1\n`, `${repository}:${"a".repeat(129)}`, `${repository}@sha256:abc`, `${repository}@${newId.toUpperCase()}`, `${repository}@sha512:${"a".repeat(128)}`,
      `${repository}:v1@${newId}@${newId}`, `${repository}:v1?x=1`, `${repository}:v1#tag`, `${repository}.evil:v1`, `https://${repository}:v1`, `docker.io/${repository}:v1`, repository.toUpperCase() + ":v1", "attacker/sub2api:v1", "weishaw/sub2api-malicious:v1"]) {
      assert.throws(() => validateOfficialAppImage(service, image), fixedError("EXPLICIT_OFFICIAL_APP_IMAGE_REQUIRED"));
    }
  });
}
test("the app image allowlist cannot be expanded with an unknown or inherited service key", () => {
  for (const service of ["postgres", "canvas", "SUB2API", "__proto__", "constructor", "toString", undefined, null, {}]) assert.throws(() => validateOfficialAppImage(service, "weishaw/sub2api:v2"), fixedError("EXPLICIT_OFFICIAL_APP_IMAGE_REQUIRED"));
  for (const image of [null, undefined, {}, 123]) assert.throws(() => validateOfficialAppImage("sub2api", image), fixedError("EXPLICIT_OFFICIAL_APP_IMAGE_REQUIRED"));
  assert.throws(() => validateOfficialAppImage("sub2api", `${repositories["canvas-legacy"]}:v2`), fixedError("EXPLICIT_OFFICIAL_APP_IMAGE_REQUIRED"));
});

test("canonical SHA ignores object insertion order but retains array order and exact string bytes", () => {
  assert.equal(appImageReviewSha({ b: [{ z: 2, a: "蓝" }], a: 1 }), appImageReviewSha({ a: 1, b: [{ a: "蓝", z: 2 }] }));
  assert.equal(appImageReviewSha({ b: 2, a: 1 }), createHash("sha256").update('{"a":1,"b":2}').digest("hex"));
  assert.notEqual(appImageReviewSha([1, 2]), appImageReviewSha([2, 1])); assert.notEqual(appImageReviewSha("é"), appImageReviewSha("é"));
});
test("a complete explicitly reviewed image/default update returns only safe hashes and known changed field names", () => {
  const before = fixture(), after = upgraded(before), original = globalThis.structuredClone({ before, after });
  const result = review(frozen(before), frozen(after));
  assert.deepEqual(result, { beforeSha256: appImageReviewSha(before), afterSha256: appImageReviewSha(after), reviewedSha256: appImageReviewSha(after), expectedImageId: newId, changedFields: allowed });
  assert.deepEqual({ before, after }, original); assert.ok(!JSON.stringify(result).includes(privateValue)); assert.ok(!JSON.stringify(result).includes("/synthetic/data"));
});
test("the same canonical candidate can be reviewed after object-key reordering without changing its exact digest", () => {
  const before = fixture(), after = upgraded(before), reordered = Object.fromEntries(Object.entries(after).reverse());
  assert.deepEqual(review(before, reordered, { reviewedSha256: appImageReviewSha(after) }), review(before, after));
});
test("changed, malformed or wrongly cased review hashes never authorize adoption", () => {
  const before = fixture(), after = upgraded(before), reviewedSha256 = appImageReviewSha(after); after.environment.VERSION = "v3";
  assert.throws(() => review(before, after, { reviewedSha256 }), fixedError("APP_IMAGE_REVIEW_SHA256_MISMATCH"));
  for (const value of [undefined, null, newId, "bad", reviewedSha256.toUpperCase(), reviewedSha256 + "\n"]) assert.throws(() => review(before, after, { reviewedSha256: value }), fixedError("APP_IMAGE_REVIEW_INVALID_SHA256"));
});
test("only the exact fixed image ID can be adopted even if a different candidate digest was reviewed", () => {
  const before = fixture(), after = upgraded(before); after.imageID = imageId("other-image");
  assert.throws(() => review(before, after), fixedError("APP_IMAGE_REVIEW_IMAGE_ID_MISMATCH"));
  for (const value of [undefined, null, "weishaw/sub2api:v2", newId.toUpperCase(), "sha256:abc", newId + "\n"]) assert.throws(() => review(before, after, { expectedImageId: value }), fixedError("APP_IMAGE_REVIEW_INVALID_IMAGE_ID"));
});
test("container name cannot change or disappear even with the correct candidate digest", () => {
  const before = fixture();
  for (const mutate of [value => { value.name = "other-container"; }, value => { delete value.name; }, value => { value.name = ""; }]) {
    const after = upgraded(before); mutate(after); assert.throws(() => review(before, after), fixedError("APP_IMAGE_REVIEW_NAME_MISMATCH"));
  }
});

for (const [name, mutate] of [
  ["published port", value => { value.ports[0].published = "18080"; }],
  ["host port address", value => { value.ports[0].host_ip = "0.0.0.0"; }],
  ["mount source", value => { value.mounts[0].source = "/synthetic/other-data"; }],
  ["mount write permission", value => { value.mounts[0].read_only = true; }],
  ["network aliases", value => { value.networks.original.aliases.push("new-alias"); }],
  ["network address", value => { value.networks.original.ipv4_address = "172.30.0.5"; }],
  ["security privileges", value => { value.constraints.privileged = true; }],
  ["security options", value => { value.constraints.security_opt = []; }],
  ["dropped capabilities", value => { value.constraints.cap_drop = []; }],
  ["memory constraints", value => { value.constraints.mem_limit *= 2; }],
  ["tmpfs", value => { value.tmpfs["/tmp"] = "rw"; }],
  ["masked paths", value => { value.maskedPaths = []; }],
  ["readonly paths", value => { value.readonlyPaths = []; }],
  ["hostname", value => { value.hostname = "new-host"; }],
  ["stop timeout", value => { value.stopTimeout = 5; }],
  ["tty", value => { value.tty = true; }],
]) test(`an exact review SHA cannot approve changed protected ${name}`, () => {
  const before = fixture(), after = upgraded(before), original = globalThis.structuredClone(before); mutate(after);
  assert.throws(() => review(frozen(before), after), fixedError("APP_IMAGE_REVIEW_PROTECTED_FIELD_CHANGED")); assert.deepEqual(before, original);
});
test("adding or removing any unapproved root field fails, including an unknown field with a secret-like name", () => {
  const before = fixture();
  for (const mutate of [value => { value[privateValue] = "extra"; }, value => { delete value.ports; }, value => { delete value.constraints; }]) {
    const after = upgraded(before); mutate(after); assert.throws(() => review(before, after), fixedError("APP_IMAGE_REVIEW_PROTECTED_FIELD_CHANGED"));
  }
  before.originalExtension = { enabled: true }; const unchangedExtension = upgraded(before); assert.equal(review(before, unchangedExtension).afterSha256, appImageReviewSha(unchangedExtension));
  delete unchangedExtension.originalExtension; assert.throws(() => review(before, unchangedExtension), fixedError("APP_IMAGE_REVIEW_PROTECTED_FIELD_CHANGED"));
});
test("reviewable fields may appear or disappear and an unchanged fixed image is a valid empty review", () => {
  const before = fixture(), after = globalThis.structuredClone(before); delete before.labels; after.imageID = newId; delete after.healthcheck;
  assert.deepEqual(review(before, after).changedFields, ["healthcheck", "imageID", "labels"]);
  assert.deepEqual(review(before, before, { expectedImageId: oldId }).changedFields, []);
});
test("non-JSON, accessor, cyclic and malformed comparable values fail with fixed redacted errors", () => {
  let getterCalled = false; const accessor = { get value() { getterCalled = true; throw new Error(privateValue); } }, cycle = {}; cycle.self = cycle;
  const sparse = []; sparse.length = 1; const extended = [1]; extended.extra = "not-json";
  const hidden = {}; Object.defineProperty(hidden, "value", { value: privateValue }); const symbol = { [Symbol("private")]: privateValue };
  const proxy = new Proxy({}, { getPrototypeOf() { throw new Error(privateValue); } });
  for (const value of [undefined, NaN, Infinity, 1n, () => {}, new Date(), /pattern/, accessor, cycle, sparse, extended, hidden, symbol, proxy, { value: undefined }])
    assert.throws(() => appImageReviewSha(value), fixedError("APP_IMAGE_REVIEW_INVALID_VALUE"));
  assert.equal(getterCalled, false);
  for (const before of [undefined, null, "private", []]) assert.throws(() => review(before, upgraded(fixture())), fixedError("APP_IMAGE_REVIEW_INVALID_COMPARABLE"));
  for (const input of [undefined, null, "private", []]) assert.throws(() => reviewAppImageChange(input), fixedError("APP_IMAGE_REVIEW_INVALID_COMPARABLE"));
  assert.throws(() => reviewAppImageChange({ get before() { throw new Error(privateValue); } }), fixedError("APP_IMAGE_REVIEW_INVALID_VALUE"));
});
