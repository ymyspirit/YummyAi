import { createHash } from "node:crypto";

const IMAGE_ID = /^sha256:[a-f0-9]{64}(?![\s\S])/;
const SHA256 = /^[a-f0-9]{64}(?![\s\S])/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*(?![\s\S])/;
const REPOSITORIES = Object.freeze({ sub2api: "weishaw/sub2api", "canvas-legacy": "ghcr.io/basketikun/infinite-canvas" });
const MOVING_TAGS = new Set(["latest", "main", "master"]);
const REVIEWABLE_FIELDS = new Set(["imageID", "environment", "command", "entrypoint", "user", "workingDirectory", "healthcheck", "stopSignal", "exposedPorts", "labels"]);
class ImageReviewError extends Error {}
const fail = code => { throw new ImageReviewError(`UNIFIED_COMPOSE_${code}`); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

/** Only these upstream repositories and an explicit, non-moving tag/digest. */
export function validateOfficialAppImage(service, image) {
  if (typeof service !== "string" || !Object.hasOwn(REPOSITORIES, service) || typeof image !== "string")
    fail("EXPLICIT_OFFICIAL_APP_IMAGE_REQUIRED");
  const repository = REPOSITORIES[service];
  if (!image.startsWith(repository)) fail("EXPLICIT_OFFICIAL_APP_IMAGE_REQUIRED");
  const match = /^(?::([A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))?(?:@(sha256:[a-f0-9]{64}))?(?![\s\S])/.exec(image.slice(repository.length));
  if (!match || !match[1] && !match[2] || match[1] && MOVING_TAGS.has(match[1].toLowerCase()))
    fail("EXPLICIT_OFFICIAL_APP_IMAGE_REQUIRED");
  return image;
}

// Docker comparisons are JSON data. Reject getters/prototypes/holes rather than
// hashing a partial or coerced view; no exception can disclose their values.
function canonical(value, ancestors = new Set(), depth = 0) {
  if (depth > 64) fail("APP_IMAGE_REVIEW_INVALID_VALUE");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== "object" || ancestors.has(value) || Object.getOwnPropertySymbols(value).length)
    fail("APP_IMAGE_REVIEW_INVALID_VALUE");
  const prototype = Object.getPrototypeOf(value), isArray = Array.isArray(value);
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    fail("APP_IMAGE_REVIEW_INVALID_VALUE");
  const descriptors = Object.getOwnPropertyDescriptors(value), names = Object.keys(descriptors);
  if (isArray) {
    if (names.length !== value.length + 1 || names.some(key => key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)))
      fail("APP_IMAGE_REVIEW_INVALID_VALUE");
  }
  for (const key of names) if (key !== "length" || !isArray) {
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable) fail("APP_IMAGE_REVIEW_INVALID_VALUE");
  }
  ancestors.add(value);
  try {
    if (isArray) return `[${Array.from({ length: value.length }, (_, index) => canonical(descriptors[index].value, ancestors, depth + 1)).join(",")}]`;
    return `{${names.sort().map(key => `${JSON.stringify(key)}:${canonical(descriptors[key].value, ancestors, depth + 1)}`).join(",")}}`;
  } finally { ancestors.delete(value); }
}
function safely(operation) {
  try { return operation(); }
  catch (error) { if (error instanceof ImageReviewError) throw error; fail("APP_IMAGE_REVIEW_INVALID_VALUE"); }
}
const hash = serialized => createHash("sha256").update(serialized).digest("hex");

/** Same canonical SHA for the private review preview and explicit adoption. */
export function appImageReviewSha(value) { return safely(() => hash(canonical(value))); }

/** Inputs must come from inspectComparable. Values stay private to the caller. */
export function reviewAppImageChange(input) {
  return safely(() => {
    const { before, after, expectedImageId, reviewedSha256 } = input ?? {};
    if (!object(before) || !object(after)) fail("APP_IMAGE_REVIEW_INVALID_COMPARABLE");
    if (typeof expectedImageId !== "string" || !IMAGE_ID.test(expectedImageId)) fail("APP_IMAGE_REVIEW_INVALID_IMAGE_ID");
    if (typeof reviewedSha256 !== "string" || !SHA256.test(reviewedSha256)) fail("APP_IMAGE_REVIEW_INVALID_SHA256");
    const beforeSha256 = hash(canonical(before)), afterSha256 = hash(canonical(after));
    if (afterSha256 !== reviewedSha256) fail("APP_IMAGE_REVIEW_SHA256_MISMATCH");
    if (!Object.hasOwn(before, "name") || !Object.hasOwn(after, "name") || typeof before.name !== "string" || !NAME.test(before.name) || before.name !== after.name)
      fail("APP_IMAGE_REVIEW_NAME_MISMATCH");
    if (!Object.hasOwn(before, "imageID") || typeof before.imageID !== "string" || !IMAGE_ID.test(before.imageID)
      || !Object.hasOwn(after, "imageID") || after.imageID !== expectedImageId) fail("APP_IMAGE_REVIEW_IMAGE_ID_MISMATCH");
    const changedFields = [];
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      const changed = Object.hasOwn(before, key) !== Object.hasOwn(after, key) || canonical(before[key]) !== canonical(after[key]);
      if (!changed) continue;
      if (!REVIEWABLE_FIELDS.has(key)) fail("APP_IMAGE_REVIEW_PROTECTED_FIELD_CHANGED");
      changedFields.push(key);
    }
    return { beforeSha256, afterSha256, reviewedSha256, expectedImageId, changedFields };
  });
}
