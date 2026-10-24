import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { createStudioDocumentTransferBrowserLockGuard, studioDocumentTransferPinnedBrowserUse,
  STUDIO_DOCUMENT_TRANSFER_BROWSER_LOCK_SHA256 } from "../testing/require-studio-document-transfer-browser-lock.mjs";

// Every file and Windows directory below is in memory. No real artifact,
// browser, socket, filesystem mutation, environment file or provider is used.
const win = path.win32, clone = value => globalThis.structuredClone(value);
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const sha = value => createHash("sha256").update(value).digest("hex");
const payloadRelative = "browsers/chromium_headless_shell-1251";
const exeInPayload = "chrome-headless-shell-win64/chrome-headless-shell.exe";
const fail = code => error => { assert.equal(error.message, "STUDIO_TRANSFER_BROWSER_LOCK_" + code); assert.ok(!error.message.includes("SYNTHETIC_PRIVATE")); return true; };

function fixture() {
  const workspaceRoot = "D:\\synthetic-memory-yummyai";
  const root = win.join(workspaceRoot, ".artifacts", "toolchains", "playwright-core-1.65.0-alpha-2026-10-23");
  const payloadRoot = win.join(root, ...payloadRelative.split("/"));
  const lockPath = win.join(root, "browser-lock.json"), receiptPath = win.join(root, "payload-receipt.json");
  const nodes = new Map(), fds = new Map(), calls = { opened: [], closed: 0, reads: [], readBytes: 0 };
  let nextNode = 0, nextFd = 0, clock = 0, trusted, onRead;
  const normal = at => win.normalize(at), atPayload = value => win.join(payloadRoot, ...value.split("/"));
  function directory(at) {
    at = normal(at); if (nodes.has(at)) return;
    const parent = win.dirname(at); if (parent !== at) directory(parent);
    nodes.set(at, { kind: "directory", ino: ++nextNode, tick: ++clock });
    if (nodes.has(parent) && parent !== at) nodes.get(parent).tick = ++clock;
  }
  function write(at, content) {
    at = normal(at); directory(win.dirname(at)); const previous = nodes.get(at);
    nodes.set(at, { kind: "file", ino: previous?.ino ?? ++nextNode, tick: ++clock, content: Buffer.from(content) });
    if (!previous) nodes.get(win.dirname(at)).tick = ++clock;
  }
  function remove(at) { at = normal(at); nodes.delete(at); nodes.get(win.dirname(at)).tick = ++clock; }
  function node(at) { const value = nodes.get(normal(at)); if (!value) throw Object.assign(new Error("SYNTHETIC_PRIVATE_MISSING"), { code: "ENOENT" }); return value; }
  function stat(at) {
    const value = node(at);
    return { dev: 1, ino: value.ino, size: value.content?.length ?? 0, mtimeMs: value.tick, ctimeMs: value.tick,
      mode: value.kind === "file" ? 0o100600 : 0o40700,
      isFile: () => value.kind === "file", isDirectory: () => value.kind === "directory", isSymbolicLink: () => value.kind === "link" };
  }
  const io = {
    lstatSync: stat,
    realpathSync(at) { const value = node(at); return value.realpath ?? normal(at); },
    readdirSync(at) {
      assert.equal(node(at).kind, "directory");
      return [...nodes.keys()].filter(key => key !== normal(at) && win.dirname(key) === normal(at)).map(key => win.basename(key)).sort();
    },
    openSync(at, flags) { assert.equal(flags, "r"); assert.equal(node(at).kind, "file"); const fd = ++nextFd; fds.set(fd, { at: normal(at), offset: 0 }); calls.opened.push(normal(at)); return fd; },
    fstatSync(fd) { return stat(fds.get(fd).at); },
    readSync(fd, buffer, offset, length, position) {
      assert.equal(position, null); assert.ok(length <= 1024 * 1024);
      const handle = fds.get(fd), value = node(handle.at), count = Math.min(length, value.content.length - handle.offset);
      value.content.copy(buffer, offset, handle.offset, handle.offset + count); handle.offset += count;
      calls.readBytes += count; calls.reads.push({ at: handle.at, count, requested: length });
      if (onRead) onRead({ at: handle.at, count, offset: handle.offset });
      return count;
    },
    closeSync(fd) { assert.ok(fds.delete(fd)); calls.closed++; },
  };
  write(atPayload("INSTALLATION_COMPLETE"), Buffer.alloc(0));
  write(atPayload("aaa/earlier.bin"), Buffer.from("SYNTHETIC_EARLIER_PAYLOAD"));
  write(atPayload(exeInPayload), Buffer.alloc(1024 * 1024 + 17, 101));
  write(atPayload("chrome-headless-shell-win64/runtime.dll"), Buffer.from("SYNTHETIC_RUNTIME_BYTES"));
  const receipt = { version: 1, rootRelative: payloadRelative, files: [...nodes.entries()]
    .filter(([at, value]) => value.kind === "file" && at.startsWith(payloadRoot + "\\"))
    .map(([at, value]) => ({ path: win.relative(payloadRoot, at).replaceAll("\\", "/"), bytes: value.content.length, sha256: sha(value.content) })) };
  const executable = receipt.files.find(file => file.path === exeInPayload);
  const lock = { version: 1, family: "studio_document_transfer_d8b42e71", purpose: "local_acceptance",
    driver: { name: "@playwright/test", version: "1.61.1" },
    sourcePackage: { name: "playwright-core", version: "1.65.0-alpha-2026-10-23", gitHead: "20a2087ea43412b90c172c88faef80786ee18b8b",
      integrity: "sha512-2vqfxKkSB94itSPN4IeJlDiw3Ulsr+FVbqiS7HL2j/lE5gI5T7V7b4HkTG3om6ou35KTie0jaiGdCk3+FCxeKw==" },
    browser: { name: "chromium-headless-shell", revision: "1251", version: "157.0.8103.6", platform: "win64",
      downloadUrl: "https://cdn.playwright.dev/builds/cft/157.0.8103.6/win64/chrome-headless-shell-win64.zip" },
    registrySha256: "bbf8f51124fb831099d7a75830af240d0556bb56c537b953eb88cdda97c2c49d",
    payloadReceipt: "payload-receipt.json", payloadReceiptSha256: "", executableRelative: payloadRelative + "/" + exeInPayload,
    executableSha256: executable.sha256, executableBytes: executable.bytes };
  function trustLock() { write(lockPath, encode(lock)); trusted = sha(node(lockPath).content); }
  function trustReceipt() { write(receiptPath, encode(receipt)); lock.payloadReceiptSha256 = sha(node(receiptPath).content); trustLock(); }
  trustReceipt();
  return { workspaceRoot, root, payloadRoot, lockPath, receiptPath, nodes, fds, calls, lock, receipt, io, node, stat, write, remove, atPayload,
    trustLock, trustReceipt, onRead(callback) { onRead = callback; },
    run(environment = {}, changes = {}) { return createStudioDocumentTransferBrowserLockGuard({ filesystem: io, workspaceRoot,
      expectedLockSha256: trusted, driverVersion: "1.61.1", ...changes })(environment); } };
}

test("the exact source pin yields a frozen chromium selection after bounded hashes of every payload file including zero-byte markers", () => {
  assert.equal(STUDIO_DOCUMENT_TRANSFER_BROWSER_LOCK_SHA256, "8d7b168846c926720e47c4f1c9eaaeb7ac83c1264f43c692f76a325ab8604347");
  const f = fixture(), selected = f.run();
  assert.equal(selected.executablePath, f.atPayload(exeInPayload)); assert.equal(selected.browserVersion, "157.0.8103.6");
  assert.equal(selected.revision, "1251"); assert.equal(selected.executableSha256, f.lock.executableSha256);
  assert.equal(selected.metadata.payloadFiles, 4); assert.equal(selected.metadata.payloadBytes, f.receipt.files.reduce((sum, row) => sum + row.bytes, 0));
  assert.equal(selected.metadata.sourcePackageIntegrity, f.lock.sourcePackage.integrity);
  assert.ok(Object.isFrozen(selected)); assert.ok(Object.isFrozen(selected.metadata));
  assert.throws(() => { selected.executablePath = "C:\\SYNTHETIC_PRIVATE\\other.exe"; }, TypeError);
  assert.ok(f.calls.reads.filter(row => row.at === selected.executablePath && row.count > 0).length >= 2);
  assert.ok(f.calls.opened.includes(f.atPayload("INSTALLATION_COMPLETE"))); assert.equal(f.fds.size, 0); assert.equal(f.calls.closed, f.calls.opened.length);
});

test("missing pins changed raw lock bytes malformed JSON or a different driver fail closed before any payload is opened", () => {
  for (const variant of ["pending", "pin", "json", "missing", "driver"]) {
    const f = fixture(); let expected = "PIN_CHANGED", changes = {};
    if (variant === "pending") { changes = { expectedLockSha256: "PENDING" }; expected = "PIN_REQUIRED"; }
    if (variant === "pin") f.write(f.lockPath, Buffer.concat([f.node(f.lockPath).content, Buffer.from("\n")]));
    if (variant === "json") { f.write(f.lockPath, Buffer.from("SYNTHETIC_PRIVATE_NOT_JSON")); changes.expectedLockSha256 = sha(f.node(f.lockPath).content); expected = "SCHEMA_INVALID"; }
    if (variant === "missing") { f.remove(f.lockPath); expected = "IO_REJECTED"; }
    if (variant === "driver") { changes.driverVersion = "1.65.0"; expected = "DRIVER_CHANGED"; }
    assert.throws(() => f.run({}, changes), fail(expected), variant);
    assert.equal(f.calls.opened.filter(at => at.startsWith(f.payloadRoot + "\\")).length, 0); assert.equal(f.fds.size, 0);
  }
});

test("strict lock and receipt provenance schemas reject unknown fields aliases changed versions revisions and duplicate payload identities", () => {
  const variants = [
    f => { f.lock.createdAt = "SYNTHETIC_PRIVATE"; }, f => { f.lock.family = "other_batch"; },
    f => { f.lock.driver.version = "next"; }, f => { f.lock.sourcePackage.version = "next"; },
    f => { f.lock.sourcePackage.gitHead = "0".repeat(40); }, f => { f.lock.sourcePackage.integrity = "sha512-SYNTHETIC_PRIVATE"; },
    f => { f.lock.browser.revision = "1252"; }, f => { f.lock.browser.version = "158.0.0.0"; },
    f => { f.lock.browser.platform = "linux"; }, f => { f.lock.browser.downloadUrl = "https://SYNTHETIC_PRIVATE.invalid/browser.zip"; },
    f => { f.lock.registrySha256 = "f".repeat(64); }, f => { f.lock.payloadReceipt = "other.json"; },
    f => { f.lock.executableRelative = "../../SYNTHETIC_PRIVATE.exe"; },
  ];
  for (const mutate of variants) {
    const f = fixture(); mutate(f); f.trustLock();
    assert.throws(() => f.run(), error => /^STUDIO_TRANSFER_BROWSER_LOCK_(?:SCHEMA_INVALID|PROVENANCE_CHANGED)$/.test(error.message));
    assert.equal(f.fds.size, 0);
  }
  for (const mutate of [f => { f.receipt.extra = true; }, f => { f.receipt.rootRelative = "../outside"; },
    f => { f.receipt.files.push(clone(f.receipt.files[0])); }, f => { f.receipt.files.push({ ...f.receipt.files[0], path: f.receipt.files[0].path.toLowerCase() }); },
    f => { f.receipt.files[0].bytes = -1; }, f => { f.receipt.files[0].sha256 = "a".repeat(64) + "\n"; }]) {
    const f = fixture(); mutate(f); f.trustReceipt(); assert.throws(() => f.run(), fail("SCHEMA_INVALID")); assert.equal(f.fds.size, 0);
  }
});

test("receipt hash executable metadata payload bytes sizes missing files and extra files are all independently verified", () => {
  const cases = [
    ["receipt", f => f.write(f.receiptPath, Buffer.concat([f.node(f.receiptPath).content, Buffer.from("\n")])), "RECEIPT_CHANGED"],
    ["executable-binding", f => { f.lock.executableSha256 = "b".repeat(64); f.trustLock(); }, "EXECUTABLE_CHANGED"],
    ["bytes", f => { const content = Buffer.from(f.node(f.atPayload(exeInPayload)).content); content[0] ^= 1; f.write(f.atPayload(exeInPayload), content); }, "PAYLOAD_CHANGED"],
    ["size", f => f.write(f.atPayload(exeInPayload), Buffer.from("SYNTHETIC_PRIVATE_SHORT")), "FILE_SIZE_CHANGED"],
    ["dll", f => f.write(f.atPayload("chrome-headless-shell-win64/runtime.dll"), Buffer.from("SYNTHETIC_RUNTIME_BYTEX")), "PAYLOAD_CHANGED"],
    ["missing", f => f.remove(f.atPayload("aaa/earlier.bin")), "FILE_SET_CHANGED"],
    ["extra", f => f.write(f.atPayload("extra.exe"), Buffer.from("SYNTHETIC_PRIVATE_EXTRA")), "FILE_SET_CHANGED"],
  ];
  for (const [name, mutate, expected] of cases) {
    const f = fixture(); mutate(f); assert.throws(() => f.run(), fail(expected), name); assert.equal(f.fds.size, 0);
  }
});

test("every ancestor and file rejects junctions realpath escape nonregular files UNC ADS and noncanonical relative paths", () => {
  for (const select of [f => f.workspaceRoot, f => win.join(f.workspaceRoot, ".artifacts"), f => f.root,
    f => f.payloadRoot, f => f.lockPath, f => f.receiptPath, f => f.atPayload(exeInPayload)]) {
    const f = fixture(); f.node(select(f)).kind = "link"; assert.throws(() => f.run(), fail("LINK_REJECTED")); assert.equal(f.fds.size, 0);
  }
  const escaped = fixture(); escaped.node(escaped.root).realpath = "C:\\SYNTHETIC_PRIVATE_OUTSIDE";
  assert.throws(() => escaped.run(), fail("REALPATH_CHANGED"));
  for (const select of [f => f.lockPath, f => f.atPayload("aaa/earlier.bin")]) {
    const f = fixture(); f.node(select(f)).kind = "fifo"; assert.throws(() => f.run(), fail("NOT_REGULAR"));
  }
  for (const bad of ["../outside", "a/./b", "a//b", "C:/outside", "\\\\host\\share\\file", "a/file:stream", "a/CON.txt", "a/file. ", "a\\b"]) {
    const f = fixture(); f.receipt.files[0].path = bad; f.trustReceipt(); assert.throws(() => f.run(), fail("PATH_INVALID"), bad);
  }
  for (const workspaceRoot of ["\\\\server\\share", "D:\\safe\\..\\outside", "relative", "D:\\safe:stream"]) {
    assert.throws(() => fixture().run({}, { workspaceRoot }), fail("PATH_INVALID"));
  }
});

test("stat realpath and exact file enumeration are rechecked when payloads change during or after an earlier file hash", () => {
  for (const variant of ["during-read", "earlier-file", "earlier-directory", "realpath"]) {
    const f = fixture();
    f.onRead(event => {
      if (event.at !== f.atPayload(exeInPayload) || !event.count) return;
      f.onRead(undefined);
      if (variant === "during-read") f.write(event.at, f.node(event.at).content);
      if (variant === "earlier-file") f.write(f.atPayload("INSTALLATION_COMPLETE"), Buffer.alloc(0));
      if (variant === "earlier-directory") f.write(f.atPayload("aaa/injected.bin"), Buffer.from("SYNTHETIC_PRIVATE_LATE"));
      if (variant === "realpath") f.node(f.payloadRoot).realpath = "C:\\SYNTHETIC_PRIVATE_OUTSIDE";
    });
    assert.throws(() => f.run(), fail(variant === "realpath" ? "REALPATH_CHANGED" : "FILE_CHANGED"), variant);
    assert.equal(f.fds.size, 0); assert.equal(f.calls.closed, f.calls.opened.length);
  }
});

test("environment remote-connect reuse debug and inherited launch overrides cannot replace the validated browser", () => {
  for (const key of ["PW_TEST_CONNECT_WS_ENDPOINT", "PW_TEST_CONNECT_HEADERS", "PW_TEST_CONNECT_EXPOSE_NETWORK", "PW_TEST_CONNECT_FUTURE",
    "PW_TEST_REUSE_CONTEXT", "PWDEBUG", "pwdebug", "pw_test_connect_ws_endpoint", "Pw_Test_Reuse_Context"]) {
    const f = fixture(); assert.throws(() => f.run({ [key]: "SYNTHETIC_PRIVATE_OVERRIDE" }), fail("ENVIRONMENT_REJECTED")); assert.equal(f.calls.opened.length, 0);
  }
  const f = fixture(), selected = f.run({ PLAYWRIGHT_BROWSERS_PATH: "C:\\SYNTHETIC_PRIVATE_OUTSIDE", EXECUTABLE_PATH: "C:\\other.exe" });
  const inherited = { viewport: { width: 1440, height: 960 }, trace: "off", browserName: "chromium" }, use = studioDocumentTransferPinnedBrowserUse(selected, inherited);
  assert.deepEqual(use.launchOptions, { executablePath: selected.executablePath }); assert.equal(use.browserName, "chromium"); assert.equal(use.headless, true);
  assert.equal(use.channel, undefined); assert.equal(use.connectOptions, undefined); assert.deepEqual(use.viewport, inherited.viewport);
  for (const patch of [{ launchOptions: {} }, { launchOptions: { executablePath: "C:\\SYNTHETIC_PRIVATE.exe" } },
    { connectOptions: { wsEndpoint: "ws://SYNTHETIC_PRIVATE" } }, { _optionConnectOptions: {} }, { channel: "chrome" },
    { headless: false }, { browserName: "firefox" }, { defaultBrowserType: "webkit" }])
    assert.throws(() => studioDocumentTransferPinnedBrowserUse(selected, { ...inherited, ...patch }), fail("LAUNCH_OVERRIDE_REJECTED"));
  assert.throws(() => studioDocumentTransferPinnedBrowserUse({ ...selected }), fail("SELECTION_REQUIRED"));
});
