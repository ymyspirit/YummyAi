import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import { P2_CI_BROWSER_PIN } from "../testing/p2-ci-browser-pin.mjs";
import { assertP2BrowserPin, inspectPinnedBrowserArchive, readPinnedSourcePackage,
  P2_BROWSER_ARCHIVE_LIMITS as limits } from "../testing/p2-ci-browser-archive.mjs";

// Every archive and tar response below is small synthetic memory data. The
// installed, unchanged readers are used; no installer, native program, network,
// real browser cache, filesystem fixture or project dependency write is used.
const require = createRequire(import.meta.url), driver = require.resolve("@playwright/test/package.json"),
  playwright = createRequire(driver).resolve("playwright/package.json"),
  core = createRequire(playwright).resolve("playwright-core/package.json");
const yauzl = createRequire(core)(path.join(path.dirname(core), "lib/utilsBundle.js")).yauzl;
const JSZip = require("jszip"), prefix = "chrome-headless-shell-linux64/", executable = prefix + "chrome-headless-shell";
const sha = (bytes, algorithm = "sha256", encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);
const jsonBytes = value => Buffer.from(JSON.stringify(value));
const errorCode = code => new RegExp("^P2_BROWSER_ARCHIVE_" + code + "$"), hasCode = code => error => errorCode(code).test(error.message);
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
const nativeBytes = Buffer.alloc(96, 0x61);
function entries() {
  return [{ name: prefix, mode: 0o040755 }, { name: executable, mode: 0o100755, content: nativeBytes },
    { name: prefix + "resources/data.bin", mode: 0o100644, content: Buffer.from("synthetic resource") }];
}

// JSZip's public builder merges duplicate names and sanitizes paths. Write the
// ZIP records directly so malformed raw central-directory evidence survives.
function rawZip(members, { declaredCount = members.length } = {}) {
  const locals = [], central = []; let offset = 0;
  for (const entry of members) {
    const name = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name), content = entry.content ?? Buffer.alloc(0),
      extra = entry.extra ?? Buffer.alloc(0), flags = entry.flags ?? 0, method = entry.method ?? 0,
      crc = entry.crc ?? crc32(content), compressed = entry.compressedBytes ?? content.length,
      expanded = entry.expandedBytes ?? content.length;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed, 18); local.writeUInt32LE(expanded, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28);
    const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50); header.writeUInt16LE(0x0314, 4); header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8); header.writeUInt16LE(method, 10); header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed, 20); header.writeUInt32LE(expanded, 24); header.writeUInt16LE(name.length, 28); header.writeUInt16LE(extra.length, 30);
    header.writeUInt32LE(entry.attributes ?? (((entry.mode ?? 0o100644) << 16) >>> 0), 38);
    header.writeUInt32LE(entry.offset ?? offset, 42);
    const record = Buffer.concat([local, name, extra, content]); locals.push(record); central.push(header, name, extra); offset += record.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(declaredCount, 8); end.writeUInt16LE(declaredCount, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function pinFor(bytes) {
  const pin = globalThis.structuredClone(P2_CI_BROWSER_PIN);
  pin.browser.archiveSha256 = sha(bytes); pin.browser.archiveBytes = bytes.length;
  pin.browser.executableSha256 = sha(nativeBytes); pin.browser.executableBytes = nativeBytes.length;
  return pin;
}
function sourceFixture({ pkg, registry } = {}) {
  const selected = { name: "chromium-headless-shell", revision: "1251", browserVersion: "157.0.8103.6", installByDefault: true },
    packageBytes = Buffer.isBuffer(pkg) ? pkg : jsonBytes(pkg ?? { name: "playwright-core", version: "1.65.0-alpha-2026-10-23" }),
    registryBytes = Buffer.isBuffer(registry) ? registry : jsonBytes(registry ?? { browsers: [selected] }),
    bytes = Buffer.from("synthetic signed tar input; never executed or extracted"), pin = pinFor(rawZip(entries())), calls = [];
  pin.sourcePackage.integrity = "sha512-" + sha(bytes, "sha512", "base64"); pin.sourcePackage.registrySha256 = sha(registryBytes);
  const runTar = (member, input, maximum) => {
    calls.push({ member, input, maximum });
    if (member === "package/package.json") return packageBytes;
    if (member === "package/browsers.json") return registryBytes;
    assert.fail("unexpected tar member");
  };
  return { bytes, pin, packageBytes, registryBytes, calls, runTar };
}
async function rejectsBeforeDecode(bytes, expected) {
  let decoded = 0;
  await assert.rejects(inspectPinnedBrowserArchive(bytes, pinFor(bytes), { yauzl,
    JSZip: { loadAsync() { decoded++; assert.fail("unsafe raw members reached the content reader"); } } }), expected);
  assert.equal(decoded, 0);
}

test("configured pins are complete; unfinished content pins stop before archive IO", async () => {
  assert.doesNotThrow(() => assertP2BrowserPin(P2_CI_BROWSER_PIN));
  const bytes = rawZip(entries()), pin = pinFor(bytes); pin.browser.archiveSha256 = null;
  let opened = 0;
  await assert.rejects(inspectPinnedBrowserArchive(bytes, pin, { yauzl: { fromBuffer() { opened++; } }, JSZip }), hasCode("PIN_INCOMPLETE"));
  assert.equal(opened, 0);
  for (const change of [value => { value.version = 1; }, value => { value.driver.version = "1.65.0"; },
    value => { value.browser.url = "https://example.invalid/browser.zip"; }, value => { value.sourcePackage.relative = "../source"; }]) {
    const invalid = pinFor(bytes); change(invalid); assert.throws(() => assertP2BrowserPin(invalid), hasCode("PIN_REJECTED"));
  }
});

test("verified tar bytes yield only the two bounded metadata members without requiring absent npm gitHead", () => {
  const f = sourceFixture(), result = readPinnedSourcePackage(f.bytes, f.pin, f.runTar);
  assert.deepEqual(result, { packageBytes: f.packageBytes, registryBytes: f.registryBytes });
  assert.deepEqual(f.calls.map(({ member, maximum }) => ({ member, maximum })), [
    { member: "package/package.json", maximum: 256 * 1024 }, { member: "package/browsers.json", maximum: 64 * 1024 }]);
  assert.ok(f.calls.every(call => call.input === f.bytes)); assert.equal(Object.isFrozen(result), true);
});

test("a source integrity failure never calls tar", () => {
  const f = sourceFixture(), corrupt = Buffer.from(f.bytes); corrupt[0] ^= 1;
  assert.throws(() => readPinnedSourcePackage(corrupt, f.pin, f.runTar), hasCode("PACKAGE_INTEGRITY_REJECTED"));
  assert.equal(f.calls.length, 0);
});

for (const [name, options, expected] of [
  ["invalid UTF8 package metadata", { pkg: Buffer.from([0xc3, 0x28]) }, "JSON_REJECTED"],
  ["invalid UTF8 registry metadata", { registry: Buffer.from([0xff]) }, "JSON_REJECTED"],
  ["oversized metadata", { pkg: Buffer.alloc(limits.metadataBytes + 1, 0x20) }, "PACKAGE_METADATA_REJECTED"],
  ["a different source package", { pkg: { name: "other", version: "1.65.0-alpha-2026-10-23" } }, "PACKAGE_METADATA_REJECTED"],
  ["an asserted conflicting gitHead", { pkg: { name: "playwright-core", version: "1.65.0-alpha-2026-10-23", gitHead: "0".repeat(40) } }, "PACKAGE_METADATA_REJECTED"],
  ["two selected browser definitions", { registry: { browsers: [{ name: "chromium-headless-shell" }, { name: "chromium-headless-shell" }] } }, "BROWSER_DEFINITION_REJECTED"],
  ["the previous revision", { registry: { browsers: [{ name: "chromium-headless-shell", revision: "1228", browserVersion: "149.0.7827.55", installByDefault: true }] } }, "BROWSER_DEFINITION_REJECTED"],
]) test("source metadata rejects " + name, () => {
  const f = sourceFixture(options); assert.throws(() => readPinnedSourcePackage(f.bytes, f.pin, f.runTar), hasCode(expected));
});

test("registry byte identity is checked independently of valid JSON and browser values", () => {
  const f = sourceFixture(); f.pin.sourcePackage.registrySha256 = "0".repeat(64);
  assert.throws(() => readPinnedSourcePackage(f.bytes, f.pin, f.runTar), hasCode("PACKAGE_METADATA_REJECTED"));
});

test("a regular small archive exposes only its reviewed exact file bytes", async () => {
  const bytes = rawZip(entries()), result = await inspectPinnedBrowserArchive(bytes, pinFor(bytes), { yauzl, JSZip });
  assert.deepEqual(result.members.map(value => value.name), entries().map(value => value.name));
  assert.equal(result.members.find(value => value.name === executable).mode, 0o755);
  assert.equal(result.members.find(value => value.name.endsWith("data.bin")).mode, 0o644);
  assert.deepEqual(await result.readMember(executable), nativeBytes);
  assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.members), true);
  await assert.rejects(result.readMember(prefix), hasCode("MEMBER_READ_REJECTED"));
  await assert.rejects(result.readMember(prefix + "../outside"), hasCode("MEMBER_READ_REJECTED"));
});

test("valid DEFLATE members retain exact bytes through raw inspection and CRC decoding", async () => {
  const members = entries().map(entry => entry.name.endsWith("/") ? entry : {
    ...entry, content: deflateRawSync(entry.content), method: 8, expandedBytes: entry.content.length, crc: crc32(entry.content),
  });
  const bytes = rawZip(members), result = await inspectPinnedBrowserArchive(bytes, pinFor(bytes), { yauzl, JSZip });
  for (const entry of entries().filter(value => !value.name.endsWith("/"))) assert.deepEqual(await result.readMember(entry.name), entry.content);
});

test("ZIP size or digest mismatch stops before opening the central directory", async () => {
  const bytes = rawZip(entries()); let opened = 0;
  for (const change of [pin => { pin.browser.archiveBytes++; }, pin => { pin.browser.archiveSha256 = "0".repeat(64); }]) {
    const pin = pinFor(bytes); change(pin);
    await assert.rejects(inspectPinnedBrowserArchive(bytes, pin, { yauzl: { fromBuffer() { opened++; } }, JSZip }), hasCode("ZIP_INTEGRITY_REJECTED"));
  }
  assert.equal(opened, 0);
});

const rawRejections = [
  ["duplicate raw file names", [...entries(), entries()[1]], "NAME_REJECTED"],
  ["case-folded duplicate files", [...entries(), { ...entries()[1], name: prefix + "CHROME-HEADLESS-SHELL" }], "NAME_REJECTED"],
  ["parent traversal", [...entries(), { name: prefix + "../outside", content: Buffer.from("x") }], "NAME_REJECTED"],
  ["backslash paths", [...entries(), { name: prefix + "resources\\outside", content: Buffer.from("x") }], "NAME_REJECTED"],
  ["paths outside the browser directory", [...entries(), { name: "outside/file", content: Buffer.from("x") }], "NAME_REJECTED"],
  ["same-path file and directory aliases", [...entries(), { name: prefix + "resources/data.bin/", mode: 0o040755 }], "NAME_REJECTED"],
  ["a file used as a parent directory", [...entries(), { name: prefix + "resources/data.bin/child", content: Buffer.from("x") }], "PARENT_FILE_REJECTED"],
  ["Unix symlinks", [...entries(), { name: prefix + "link", mode: 0o120777, content: Buffer.from("../outside") }], "MEMBER_TYPE_REJECTED"],
  ["Unix special files", [...entries(), { name: prefix + "pipe", mode: 0o010644 }], "MEMBER_TYPE_REJECTED"],
  ["setuid files", [...entries(), { name: prefix + "setuid", mode: 0o104755 }], "MEMBER_TYPE_REJECTED"],
  ["DOS reparse metadata", [...entries(), { name: prefix + "reparse", attributes: ((0o100644 << 16) | 0x400) >>> 0 }], "MEMBER_TYPE_REJECTED"],
  ["encrypted members", [...entries(), { name: prefix + "encrypted", flags: 1, content: Buffer.alloc(13), expandedBytes: 1 }], "MEMBER_TYPE_REJECTED"],
  ["unsupported compression", [...entries(), { name: prefix + "method", method: 99, content: Buffer.from("x") }], "MEMBER_TYPE_REJECTED"],
  ["directory payloads", [...entries(), { name: prefix + "payload/", mode: 0o040755, content: Buffer.from("x") }], "SIZE_REJECTED"],
  ["a missing executable", [entries()[0], entries()[2]], "MEMBER_COUNT_REJECTED"],
  ["oversized declared expansion", [...entries(), { name: prefix + "bomb", method: 8, content: Buffer.from("x"), expandedBytes: limits.memberBytes + 1 }], "SIZE_REJECTED"],
];
for (const [name, members, expected] of rawRejections) test("raw ZIP rejects " + name + " before content decoding", async () => {
  await rejectsBeforeDecode(rawZip(members), hasCode(expected));
});

test("a decoded Unicode path override cannot conceal a different raw member name", async () => {
  const name = prefix + "safe", decoded = Buffer.from(prefix + "renamed"), extra = Buffer.alloc(9 + decoded.length);
  extra.writeUInt16LE(0x7075); extra.writeUInt16LE(5 + decoded.length, 2); extra[4] = 1;
  extra.writeUInt32LE(crc32(Buffer.from(name)), 5); decoded.copy(extra, 9);
  await rejectsBeforeDecode(rawZip([...entries(), { name, extra, content: Buffer.from("x") }]), hasCode("NAME_REJECTED"));
});

test("excessive raw member counts are rejected before enumeration or decoding", async () => {
  await rejectsBeforeDecode(rawZip(entries(), { declaredCount: limits.members + 1 }), hasCode("MEMBER_COUNT_REJECTED"));
});

test("bad CRC is rejected despite matching the outer archive size and digest", async () => {
  const members = entries(), original = members[1].content;
  members[1] = { ...members[1], content: Buffer.from(original), crc: crc32(original) }; members[1].content[0] ^= 1;
  const bytes = rawZip(members); let decoded = 0;
  await assert.rejects(inspectPinnedBrowserArchive(bytes, pinFor(bytes), { yauzl,
    JSZip: { loadAsync(input, options) { decoded++; assert.equal(options.checkCRC32, true); return JSZip.loadAsync(input, options); } } }), /CRC32 mismatch/);
  assert.equal(decoded, 1);
});

test("the decoded member map must agree with every raw reviewed member", async () => {
  const bytes = rawZip(entries());
  await assert.rejects(inspectPinnedBrowserArchive(bytes, pinFor(bytes), { yauzl, JSZip: { async loadAsync(input, options) {
    const decoded = await JSZip.loadAsync(input, options); decoded.files[executable].unsafeOriginalName = "../aliased"; return decoded;
  } } }), hasCode("DECODED_MEMBERS_REJECTED"));
});
