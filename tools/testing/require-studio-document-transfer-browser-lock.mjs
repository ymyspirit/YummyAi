import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import filesystem from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const win = path.win32;
const sourceWorkspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const STUDIO_DOCUMENT_TRANSFER_BROWSER_LOCK_SHA256 = "8d7b168846c926720e47c4f1c9eaaeb7ac83c1264f43c692f76a325ab8604347";
const toolchainRelative = ".artifacts/toolchains/playwright-core-1.65.0-alpha-2026-10-23";
const payloadRelative = "browsers/chromium_headless_shell-1251";
const executableRelative = payloadRelative + "/chrome-headless-shell-win64/chrome-headless-shell.exe";
const sourcePackage = Object.freeze({ name: "playwright-core", version: "1.65.0-alpha-2026-10-23",
  gitHead: "20a2087ea43412b90c172c88faef80786ee18b8b",
  integrity: "sha512-2vqfxKkSB94itSPN4IeJlDiw3Ulsr+FVbqiS7HL2j/lE5gI5T7V7b4HkTG3om6ou35KTie0jaiGdCk3+FCxeKw==" });
const browser = Object.freeze({ name: "chromium-headless-shell", revision: "1251", version: "157.0.8103.6", platform: "win64",
  downloadUrl: "https://cdn.playwright.dev/builds/cft/157.0.8103.6/win64/chrome-headless-shell-win64.zip" });
const registrySha256 = "bbf8f51124fb831099d7a75830af240d0556bb56c537b953eb88cdda97c2c49d";
const approved = new WeakSet();
class BrowserLockError extends Error {}
const fail = code => { throw new BrowserLockError("STUDIO_TRANSFER_BROWSER_LOCK_" + code); };
const isSha = value => typeof value === "string" && value.length === 64 && /^[a-f0-9]+$/.test(value);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
function keys(value, expected) {
  if (!object(value) || Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) fail("SCHEMA_INVALID");
}
function exact(value, expected) {
  keys(value, Object.keys(expected));
  if (Object.entries(expected).some(([key, entry]) => value[key] !== entry)) fail("PROVENANCE_CHANGED");
}
function part(value) {
  return typeof value === "string" && value.length > 0 && value !== "." && value !== ".."
    && !/[\\/:\0\r\n]/.test(value) && !/[. ]$/.test(value)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}
function relative(value) {
  if (typeof value !== "string" || !value.split("/").every(part)) fail("PATH_INVALID");
  return value;
}
function absolute(value) {
  if (typeof value !== "string" || !/^[a-z]:\\/i.test(value) || value.slice(2).includes(":") || /[\0\r\n]/.test(value)) fail("PATH_INVALID");
  if (win.normalize(value) !== value || value.slice(3).split("\\").some(segment => !part(segment))) fail("PATH_INVALID");
  return value;
}
const samePath = (left, right) => absolute(left).toLowerCase() === absolute(right).toLowerCase();
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode];
const sameStamp = (left, right) => stamp(left).every((value, index) => value === stamp(right)[index]);
function safe(operation) {
  try { return operation(); }
  catch (error) { if (error instanceof BrowserLockError) throw error; fail("IO_REJECTED"); }
}
function environmentAllowed(environment) {
  if (!object(environment)) fail("ENVIRONMENT_REJECTED");
  for (const key of Object.keys(environment)) {
    // Windows environment lookups are case insensitive even when enumeration
    // preserves a caller's original spelling.
    const normalized = key.toUpperCase();
    if ((/^PW_TEST_CONNECT_/.test(normalized) || ["PW_TEST_REUSE_CONTEXT", "PWDEBUG"].includes(normalized))
      && environment[key] !== undefined) fail("ENVIRONMENT_REJECTED");
  }
}

/** Test injection is an explicit API, never a process-environment path or SHA.
 * Production calls only the source-pinned wrapper below. No operation writes,
 * downloads, installs, connects to, or launches a browser. */
export function createStudioDocumentTransferBrowserLockGuard({ filesystem: io, workspaceRoot, expectedLockSha256, driverVersion }) {
  return (environment = {}) => safe(() => {
    environmentAllowed(environment);
    if (!isSha(expectedLockSha256)) fail("PIN_REQUIRED");
    if (driverVersion !== "1.61.1") fail("DRIVER_CHANGED");
    const workspace = absolute(workspaceRoot), root = win.join(workspace, ...toolchainRelative.split("/"));
    const lockPath = win.join(root, "browser-lock.json"), receiptPath = win.join(root, "payload-receipt.json");
    const payloadRoot = win.join(root, ...payloadRelative.split("/"));
    const chunk = Buffer.alloc(1024 * 1024);

    function owned(at, kind) {
      absolute(at);
      const tail = win.relative(workspace, at);
      if (win.isAbsolute(tail) || tail === ".." || tail.startsWith("..\\")) fail("PATH_OUTSIDE_WORKSPACE");
      const components = tail ? tail.split("\\") : [];
      let cursor = workspace, stat;
      for (let index = 0; index <= components.length; index++) {
        if (index) cursor = win.join(cursor, components[index - 1]);
        stat = io.lstatSync(cursor);
        if (stat.isSymbolicLink()) fail("LINK_REJECTED");
        if (index < components.length || kind === "directory") { if (!stat.isDirectory()) fail("NOT_REGULAR"); }
        else if (!stat.isFile()) fail("NOT_REGULAR");
        if (!samePath(io.realpathSync(cursor), cursor)) fail("REALPATH_CHANGED");
      }
      return stat;
    }
    function read(at, { collect = false, maximum = Number.MAX_SAFE_INTEGER, bytes } = {}) {
      const before = owned(at, "file");
      if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > maximum || bytes !== undefined && before.size !== bytes) fail("FILE_SIZE_CHANGED");
      const fd = io.openSync(at, "r"), digest = createHash("sha256"), chunks = [];
      let total = 0, opened;
      try {
        opened = io.fstatSync(fd);
        if (!opened.isFile() || !sameStamp(before, opened)) fail("FILE_CHANGED");
        for (;;) {
          const count = io.readSync(fd, chunk, 0, chunk.length, null);
          if (!Number.isSafeInteger(count) || count < 0 || count > chunk.length) fail("FILE_CHANGED");
          if (!count) break;
          total += count;
          if (total > before.size || total > maximum) fail("FILE_SIZE_CHANGED");
          digest.update(chunk.subarray(0, count)); if (collect) chunks.push(Buffer.from(chunk.subarray(0, count)));
        }
        if (total !== before.size || !sameStamp(opened, io.fstatSync(fd))) fail("FILE_CHANGED");
      } finally { io.closeSync(fd); }
      if (!sameStamp(opened, owned(at, "file"))) fail("FILE_CHANGED");
      return { bytes: total, sha256: digest.digest("hex"), content: collect ? Buffer.concat(chunks) : undefined, stamp: stamp(opened) };
    }
    const lockFile = read(lockPath, { collect: true, maximum: 64 * 1024 });
    if (lockFile.sha256 !== expectedLockSha256) fail("PIN_CHANGED");
    let lock;
    try { lock = JSON.parse(lockFile.content.toString("utf8")); } catch { fail("SCHEMA_INVALID"); }
    keys(lock, ["version", "family", "purpose", "driver", "sourcePackage", "browser", "registrySha256", "payloadReceipt",
      "payloadReceiptSha256", "executableRelative", "executableSha256", "executableBytes"]);
    if (lock.version !== 1 || lock.family !== "studio_document_transfer_d8b42e71" || lock.purpose !== "local_acceptance") fail("SCHEMA_INVALID");
    exact(lock.driver, { name: "@playwright/test", version: "1.61.1" }); exact(lock.sourcePackage, sourcePackage); exact(lock.browser, browser);
    if (lock.registrySha256 !== registrySha256 || lock.payloadReceipt !== "payload-receipt.json" || lock.executableRelative !== executableRelative
      || !isSha(lock.payloadReceiptSha256) || !isSha(lock.executableSha256) || !Number.isSafeInteger(lock.executableBytes) || lock.executableBytes < 1) fail("SCHEMA_INVALID");
    const receiptFile = read(receiptPath, { collect: true, maximum: 8 * 1024 * 1024 });
    if (receiptFile.sha256 !== lock.payloadReceiptSha256) fail("RECEIPT_CHANGED");
    let receipt;
    try { receipt = JSON.parse(receiptFile.content.toString("utf8")); } catch { fail("SCHEMA_INVALID"); }
    keys(receipt, ["version", "rootRelative", "files"]);
    if (receipt.version !== 1 || receipt.rootRelative !== payloadRelative || !Array.isArray(receipt.files)
      || !receipt.files.length || receipt.files.length > 10_000) fail("SCHEMA_INVALID");
    const expectedFiles = new Map(), folded = new Set(); let payloadBytes = 0;
    for (const item of receipt.files) {
      keys(item, ["path", "bytes", "sha256"]); relative(item.path);
      if (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || !isSha(item.sha256) || folded.has(item.path.toLowerCase())) fail("SCHEMA_INVALID");
      folded.add(item.path.toLowerCase()); expectedFiles.set(item.path, item); payloadBytes += item.bytes;
      if (!Number.isSafeInteger(payloadBytes)) fail("SCHEMA_INVALID");
    }
    const executableInPayload = executableRelative.slice(payloadRelative.length + 1), executable = expectedFiles.get(executableInPayload);
    if (!executable || executable.bytes !== lock.executableBytes || executable.sha256 !== lock.executableSha256) fail("EXECUTABLE_CHANGED");
    const visited = new Set(), verifiedFiles = new Map(), verifiedDirectories = new Map();
    function walk(directory, prefix = "") {
      const before = owned(directory, "directory"), names = io.readdirSync(directory), siblings = new Set();
      if (!Array.isArray(names)) fail("FILE_SET_CHANGED");
      for (const name of names) {
        if (!part(name) || siblings.has(name.toLowerCase())) fail("FILE_SET_CHANGED");
        siblings.add(name.toLowerCase());
        const at = win.join(directory, name), key = prefix + name, stat = io.lstatSync(at);
        if (stat.isSymbolicLink()) fail("LINK_REJECTED");
        if (stat.isDirectory()) walk(at, key + "/");
        else {
          if (!stat.isFile()) fail("NOT_REGULAR");
          const expected = expectedFiles.get(key);
          if (!expected || visited.has(key)) fail("FILE_SET_CHANGED");
          const actual = read(at, { bytes: expected.bytes });
          if (actual.sha256 !== expected.sha256) fail("PAYLOAD_CHANGED");
          visited.add(key); verifiedFiles.set(at, actual.stamp);
        }
      }
      if (!sameStamp(before, owned(directory, "directory"))) fail("FILE_CHANGED");
      const after = io.readdirSync(directory);
      if (!Array.isArray(after) || JSON.stringify([...names].sort()) !== JSON.stringify([...after].sort())) fail("FILE_SET_CHANGED");
      verifiedDirectories.set(directory, { stamp: stamp(before), names: [...names].sort() });
    }
    walk(payloadRoot);
    if (visited.size !== expectedFiles.size) fail("FILE_SET_CHANGED");
    for (const [at, before] of verifiedFiles) if (stamp(owned(at, "file")).some((value, index) => value !== before[index])) fail("FILE_CHANGED");
    for (const [at, before] of verifiedDirectories) {
      if (stamp(owned(at, "directory")).some((value, index) => value !== before.stamp[index])) fail("FILE_CHANGED");
      const names = io.readdirSync(at);
      if (!Array.isArray(names) || JSON.stringify([...names].sort()) !== JSON.stringify(before.names)) fail("FILE_SET_CHANGED");
    }
    // Recheck the complete payload root and both controlling files after hashing.
    owned(root, "directory"); owned(payloadRoot, "directory");
    if (read(lockPath, { maximum: 64 * 1024 }).sha256 !== expectedLockSha256) fail("PIN_CHANGED");
    if (read(receiptPath, { maximum: 8 * 1024 * 1024 }).sha256 !== lock.payloadReceiptSha256) fail("RECEIPT_CHANGED");
    const executablePath = win.join(root, ...executableRelative.split("/"));
    const metadata = Object.freeze({ family: lock.family, lockSha256: expectedLockSha256, driverVersion,
      sourcePackageVersion: sourcePackage.version, sourcePackageGitHead: sourcePackage.gitHead, sourcePackageIntegrity: sourcePackage.integrity,
      registrySha256, browserName: browser.name, browserVersion: browser.version, revision: browser.revision,
      payloadReceiptSha256: lock.payloadReceiptSha256, payloadFiles: visited.size, payloadBytes,
      executablePath, executableSha256: lock.executableSha256, executableBytes: lock.executableBytes });
    const selected = Object.freeze({ executablePath, executableSha256: lock.executableSha256, executableBytes: lock.executableBytes,
      browserVersion: browser.version, revision: browser.revision, lockSha256: expectedLockSha256, metadata });
    approved.add(selected); return selected;
  });
}

/** Fixed source pin; no environment-supplied executable, channel, path or SHA. */
export function requireStudioDocumentTransferBrowserLock(environment = process.env) {
  return safe(() => {
    if (process.platform !== "win32") fail("PLATFORM_REJECTED");
    const require = createRequire(import.meta.url), driver = JSON.parse(filesystem.readFileSync(require.resolve("@playwright/test/package.json"), "utf8"));
    return createStudioDocumentTransferBrowserLockGuard({ filesystem, workspaceRoot: sourceWorkspace,
      expectedLockSha256: STUDIO_DOCUMENT_TRANSFER_BROWSER_LOCK_SHA256, driverVersion: driver.version })(environment);
  });
}

export function studioDocumentTransferPinnedBrowserUse(selected, inheritedUse = {}) {
  return safe(() => {
    if (!approved.has(selected) || !object(inheritedUse)) fail("SELECTION_REQUIRED");
    for (const key of ["launchOptions", "connectOptions", "_optionConnectOptions", "channel"]) if (inheritedUse[key] !== undefined) fail("LAUNCH_OVERRIDE_REJECTED");
    if (inheritedUse.browserName !== undefined && inheritedUse.browserName !== "chromium"
      || inheritedUse.defaultBrowserType !== undefined && inheritedUse.defaultBrowserType !== "chromium"
      || inheritedUse.headless !== undefined && inheritedUse.headless !== true) fail("LAUNCH_OVERRIDE_REJECTED");
    return { ...inheritedUse, browserName: "chromium", headless: true, channel: undefined, connectOptions: undefined,
      launchOptions: { executablePath: selected.executablePath } };
  });
}
