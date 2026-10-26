import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { P2_CI_BROWSER_PIN as pin } from "../testing/p2-ci-browser-pin.mjs";
import { assertP2BrowserPin, inspectPinnedBrowserArchive, readPinnedSourcePackage, P2_BROWSER_ARCHIVE_LIMITS as limits } from "../testing/p2-ci-browser-archive.mjs";

export const P2_BROWSER_REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const fail = code => { throw new Error("P2_BROWSER_INSTALL_" + code); };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const stamp = value => [value.dev, value.ino, value.nlink, value.size, value.mode, value.mtimeMs, value.ctimeMs];
const same = (left, right) => stamp(left).every((value, index) => value === stamp(right)[index]);
const exists = at => { try { fs.lstatSync(at); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
function absolute(at) {
  if (typeof at !== "string" || !at.startsWith("/") || path.posix.normalize(at) !== at || /[\\\0\r\n]/.test(at)) fail("PATH_REJECTED");
  return at;
}
function directory(at) {
  absolute(at); let cursor = "/", value;
  for (const part of ["", ...at.split("/").filter(Boolean)]) {
    if (part) cursor = path.posix.join(cursor, part);
    value = fs.lstatSync(cursor);
    if (!value.isDirectory() || value.isSymbolicLink() || fs.realpathSync(cursor) !== cursor) fail("DIRECTORY_REJECTED");
  }
  return value;
}
function regular(at, maximum, allowHardlinks = false) {
  directory(path.posix.dirname(absolute(at)));
  const before = fs.lstatSync(at);
  if (!before.isFile() || before.isSymbolicLink() || !Number.isSafeInteger(before.nlink) || before.nlink < 1 || !allowHardlinks && before.nlink !== 1 || !Number.isSafeInteger(before.size)
    || before.size < 0 || before.size > maximum || !Number.isFinite(before.mtimeMs) || !Number.isFinite(before.ctimeMs)) fail("FILE_REJECTED");
  const fd = fs.openSync(at, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), chunks = [];
  let size = 0;
  try {
    if (!same(before, fs.fstatSync(fd))) fail("FILE_CHANGED");
    for (;;) {
      const chunk = Buffer.alloc(Math.min(1024 * 1024, maximum + 1 - size));
      const count = fs.readSync(fd, chunk, 0, chunk.length, null); if (!count) break;
      size += count; if (size > maximum || size > before.size) fail("FILE_CHANGED"); chunks.push(chunk.subarray(0, count));
    }
    if (size !== before.size || !same(before, fs.fstatSync(fd)) || !same(before, fs.lstatSync(at))) fail("FILE_CHANGED");
  } finally { fs.closeSync(fd); }
  return Buffer.concat(chunks, size);
}
function ensureDirectory(base, relative) {
  directory(base); let current = base;
  for (const part of relative.split("/").filter(Boolean)) {
    if ([".", ".."].includes(part) || !/^[A-Za-z0-9_.-]+$/.test(part)) fail("PATH_REJECTED");
    current = path.posix.join(current, part);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    directory(current);
  } return current;
}
function writeNew(at, bytes, mode = 0o600) {
  directory(path.posix.dirname(at)); const fd = fs.openSync(at, "wx", mode);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.chmodSync(at, mode);
  if (!regular(at, bytes.length).equals(bytes)) fail("WRITE_CHANGED");
}
/** Reserve a new final directory, then replace only this invocation's empty
 * inode. Node rename alone could otherwise overwrite somebody's empty cache. */
function publish(staging, target) {
  const staged = directory(staging); directory(path.posix.dirname(target));
  fs.mkdirSync(target, { mode: 0o700 }); // EEXIST is terminal; never overwrite/retry.
  const reserved = directory(target);
  if (fs.readdirSync(target).length || !same(reserved, fs.lstatSync(target))) fail("RESERVATION_CHANGED");
  fs.renameSync(staging, target);
  const adopted = directory(target);
  if (adopted.dev !== staged.dev || adopted.ino !== staged.ino) fail("PUBLISH_CHANGED");
}
function exactTree(root, files, directories = new Set()) {
  directory(root); const seen = new Set();
  const visit = (at, prefix = "") => {
    for (const name of fs.readdirSync(at)) {
      const relative = prefix + name, full = path.posix.join(at, name), stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) fail("TREE_LINK_REJECTED");
      if (stat.isDirectory()) { if (!directories.has(relative)) fail("TREE_EXTRA_REJECTED"); directory(full); visit(full, relative + "/"); }
      else { if (!files.has(relative) || !stat.isFile() || stat.nlink !== 1) fail("TREE_EXTRA_REJECTED"); seen.add(relative); }
    }
  }; visit(root);
  if (seen.size !== files.size) fail("TREE_MISSING_REJECTED");
}
function runtime() {
  if (process.platform !== "linux" || process.arch !== "x64" || process.env.CI !== "true" || !/^24\.17\.\d+$/.test(process.versions.node)
    || process.argv.length !== 2) fail("RUNTIME_REJECTED");
  assertP2BrowserPin(pin); // Null/unreviewed ELF or archive pins fail before IO/network.
  const home = absolute(os.userInfo().homedir), root = absolute(P2_BROWSER_REPOSITORY_ROOT.replace(/\/$/, ""));
  if (home === "/") fail("HOME_REJECTED");
  for (const key of Object.keys(process.env)) {
    const name = key.toUpperCase();
    if (name === "HOME" && process.env[key] !== home) fail("HOME_REJECTED");
    if (name === "NODE_TLS_REJECT_UNAUTHORIZED" && process.env[key] === "0") fail("TLS_DISABLED_REJECTED");
    if (/^(?:LD_|DYLD_|PW_TEST_CONNECT_)/.test(name) || ["PLAYWRIGHT_BROWSERS_PATH", "PLAYWRIGHT_DOWNLOAD_HOST", "PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST",
      "PLAYWRIGHT_FIREFOX_DOWNLOAD_HOST", "PLAYWRIGHT_WEBKIT_DOWNLOAD_HOST", "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH", "XDG_CACHE_HOME", "PWDEBUG", "PW_TEST_REUSE_CONTEXT",
      "CHROME_EXECUTABLE_PATH", "CHROMIUM_EXECUTABLE_PATH", "EXECUTABLE_PATH", "CHROME_BIN", "BROWSER"].includes(name)) fail("ENVIRONMENT_REJECTED");
  }
  directory(root); directory(home); return { root, home };
}
function installedLibraries(root) {
  const require = createRequire(path.posix.join(root, "package.json")), driver = require.resolve("@playwright/test/package.json"),
    playwright = createRequire(driver).resolve("playwright/package.json"), core = createRequire(playwright).resolve("playwright-core/package.json");
  const packages = [driver, playwright, core].map(at => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(regular(at, 256 * 1024, true))));
  if (packages[0].name !== "@playwright/test" || packages[1].name !== "playwright" || packages[2].name !== "playwright-core"
    || packages.some(value => value.version !== pin.driver.version) || packages[0].dependencies?.playwright !== pin.driver.version
    || packages[1].dependencies?.["playwright-core"] !== pin.driver.version) fail("DRIVER_CHANGED");
  if (sha(regular(path.posix.join(path.posix.dirname(core), "browsers.json"), 64 * 1024, true)) !== pin.driver.registrySha256) fail("DRIVER_REGISTRY_CHANGED");
  const bundle = path.posix.join(path.posix.dirname(core), "lib/utilsBundle.js"); regular(bundle, 16 * 1024 * 1024, true);
  return { yauzl: createRequire(core)(bundle).yauzl, JSZip: require("jszip") };
}
function runTar(member, bytes, maximum) {
  if (!["package/package.json", "package/browsers.json"].includes(member)) fail("TAR_MEMBER_REJECTED");
  const binary = "/usr/bin/tar", before = fs.lstatSync(binary); regular(binary, 4 * 1024 * 1024);
  const result = spawnSync(binary, ["-xOzf", "-", member], { input: bytes, encoding: "buffer", maxBuffer: maximum,
    timeout: 15_000, windowsHide: true, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
  if (!same(before, fs.lstatSync(binary)) || result.error || result.status !== 0 || result.signal || !Buffer.isBuffer(result.stdout)
    || result.stdout.length < 1 || result.stdout.length > maximum) fail("TAR_REJECTED");
  return result.stdout;
}
async function download(url, maximum, expectedBytes, browser = false) {
  const allowed = new Set([url, ...(browser ? ["https://storage.googleapis.com/chrome-for-testing-public/" + pin.browser.version + "/linux64/chrome-headless-shell-linux64.zip"] : [])]);
  const signal = globalThis.AbortSignal.timeout(120_000); let current = url;
  for (let hop = 0; hop < 3; hop++) {
    const response = await globalThis.fetch(current, { redirect: "manual", cache: "no-store", credentials: "omit", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location"); await response.body?.cancel();
      const next = location ? new URL(location, current).href : "";
      if (!allowed.has(next) || next === current) fail("REDIRECT_REJECTED"); current = next; continue;
    }
    if (response.status !== 200 || !response.body) { await response.body?.cancel(); fail("DOWNLOAD_REJECTED"); }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum || expectedBytes && Number(declared) !== expectedBytes)) { await response.body.cancel(); fail("DOWNLOAD_SIZE_REJECTED"); }
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
      if (size > maximum || expectedBytes && size > expectedBytes) fail("DOWNLOAD_SIZE_REJECTED"); chunks.push(Buffer.from(part.value)); }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; } finally { reader.releaseLock(); }
    if (!size || expectedBytes && size !== expectedBytes) fail("DOWNLOAD_SIZE_REJECTED"); return Buffer.concat(chunks, size);
  } return fail("REDIRECT_REJECTED");
}
async function sourcePackage(root, libraries) {
  const target = path.posix.join(root, pin.sourcePackage.relative), names = new Set(["source.tgz", "browser.zip", "package.json", "browsers.json"]);
  let tgz, zip, metadata;
  if (exists(target)) {
    exactTree(target, names);
    tgz = regular(path.posix.join(target, "source.tgz"), limits.packageBytes); zip = regular(path.posix.join(target, "browser.zip"), limits.archiveBytes);
    metadata = readPinnedSourcePackage(tgz, pin, runTar);
    if (!regular(path.posix.join(target, "package.json"), limits.metadataBytes).equals(metadata.packageBytes)
      || !regular(path.posix.join(target, "browsers.json"), 64 * 1024).equals(metadata.registryBytes)) fail("SOURCE_CHANGED");
  } else {
    tgz = await download(pin.sourcePackage.url, limits.packageBytes);
    metadata = readPinnedSourcePackage(tgz, pin, runTar);
    zip = await download(pin.browser.url, limits.archiveBytes, pin.browser.archiveBytes, true);
  }
  const archive = await inspectPinnedBrowserArchive(zip, pin, libraries);
  if (!exists(target)) {
    const parent = ensureDirectory(root, path.posix.dirname(pin.sourcePackage.relative)), staging = fs.mkdtempSync(path.posix.join(parent, ".source-package-stage-"));
    for (const [name, bytes] of [["source.tgz", tgz], ["browser.zip", zip], ["package.json", metadata.packageBytes], ["browsers.json", metadata.registryBytes]]) writeNew(path.posix.join(staging, name), bytes);
    exactTree(staging, names); publish(staging, target);
  }
  // Re-read immutable cached archives after the metadata operation. Never trust
  // a self-declared extraction manifest in place of the pinned original bytes.
  exactTree(target, names);
  if (!regular(path.posix.join(target, "source.tgz"), limits.packageBytes).equals(tgz)
    || !regular(path.posix.join(target, "browser.zip"), limits.archiveBytes).equals(zip)
    || !regular(path.posix.join(target, "package.json"), limits.metadataBytes).equals(metadata.packageBytes)
    || !regular(path.posix.join(target, "browsers.json"), 64 * 1024).equals(metadata.registryBytes)) fail("SOURCE_CHANGED");
  return archive;
}
function layout(members) {
  const files = new Set(), directories = new Set();
  for (const member of members) {
    const parts = member.name.replace(/\/$/, "").split("/"); if (!member.directory) { files.add(member.name); parts.pop(); }
    while (parts.length) { directories.add(parts.join("/")); parts.pop(); }
  } return { files, directories };
}
async function verifyBrowser(root, archive) {
  const expected = layout(archive.members); exactTree(root, expected.files, expected.directories);
  for (const member of archive.members.filter(value => !value.directory)) {
    const bytes = await archive.readMember(member.name), at = path.posix.join(root, member.name), actual = regular(at, limits.memberBytes);
    if (actual.length !== member.bytes || sha(actual) !== sha(bytes) || (fs.lstatSync(at).mode & 0o777) !== member.mode) fail("BROWSER_FILE_CHANGED");
  }
  const executablePath = path.posix.join(root, "chrome-headless-shell-linux64/chrome-headless-shell"), executable = regular(executablePath, limits.memberBytes);
  if (executable.length !== pin.browser.executableBytes || sha(executable) !== pin.browser.executableSha256
    || !(fs.lstatSync(executablePath).mode & 0o111) || executable.subarray(0, 4).toString("hex") !== "7f454c46"
    || executable[4] !== 2 || executable[5] !== 1 || executable.readUInt16LE(18) !== 62) fail("ELF_REJECTED");
}

export async function installP2CiBrowser() {
  const { root, home } = runtime(), libraries = installedLibraries(root), archive = await sourcePackage(root, libraries);
  const parent = ensureDirectory(home, ".cache/ms-playwright"), target = path.posix.join(parent, "chromium_headless_shell-" + pin.browser.revision);
  const reused = exists(target);
  if (!reused) {
    const staging = fs.mkdtempSync(path.posix.join(parent, ".chromium-headless-shell-1251-stage-"));
    for (const member of archive.members) {
      if (member.directory) ensureDirectory(staging, member.name.replace(/\/$/, ""));
      else { ensureDirectory(staging, path.posix.dirname(member.name)); writeNew(path.posix.join(staging, member.name), await archive.readMember(member.name), member.mode); }
    }
    await verifyBrowser(staging, archive); publish(staging, target);
  }
  await verifyBrowser(target, archive);
  return { status: "verified", reused, cache: target, sourcePackage: path.posix.join(root, pin.sourcePackage.relative), driver: pin.driver.version,
    browser: pin.browser.version, archiveSha256: pin.browser.archiveSha256, executableSha256: pin.browser.executableSha256,
    alphaCodeExecuted: false, existingCacheOverwritten: false, linksCreated: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(JSON.stringify(await installP2CiBrowser()) + "\n");
