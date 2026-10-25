import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import filesystem from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { requireStudioDocumentTransferBrowserLock, studioDocumentTransferPinnedBrowserUse } from "./require-studio-document-transfer-browser-lock.mjs";

export const P2_CI_BROWSER_REGISTRY_SHA256 = "ee39bc924bc3d1bd895626c2910f1292d109bbfeeb5abd113acb45e1951cc942";
const version = "1.61.1", revision = "1228", browserVersion = "149.0.7827.55";
const linux = path.posix, approved = new WeakSet(), windows = new WeakSet(), rechecks = new WeakMap();
class P2BrowserLockError extends Error {}
const fail = code => { throw new P2BrowserLockError("P2_BROWSER_LOCK_" + code); };
const safe = fn => { try { return fn(); } catch (cause) { if (cause instanceof P2BrowserLockError) throw cause; return fail("IO_REJECTED"); } };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeMs, stat.ctimeMs];
const same = (left, right) => stamp(left).every((value, index) => value === stamp(right)[index]);
function absolute(value) {
  if (typeof value !== "string" || !value.startsWith("/") || linux.normalize(value) !== value || /[\\\0\r\n]/.test(value)) fail("PATH_REJECTED");
  return value;
}
function environmentAllowed(environment, home) {
  if (!object(environment) || environment.CI !== "true") fail("PLATFORM_REJECTED");
  for (const key of Object.keys(environment)) {
    if (environment[key] === undefined) continue;
    const upper = key.toUpperCase();
    if (/^(?:PW_TEST_CONNECT_|LD_|DYLD_)/.test(upper)
      || ["PLAYWRIGHT_BROWSERS_PATH", "PLAYWRIGHT_DOWNLOAD_HOST", "PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST", "PLAYWRIGHT_FIREFOX_DOWNLOAD_HOST",
        "PLAYWRIGHT_WEBKIT_DOWNLOAD_HOST", "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH", "XDG_CACHE_HOME", "PWDEBUG", "PW_TEST_REUSE_CONTEXT",
        "CHROME_EXECUTABLE_PATH", "CHROMIUM_EXECUTABLE_PATH", "EXECUTABLE_PATH", "CHROME_BIN", "BROWSER"].includes(upper)) fail("ENVIRONMENT_REJECTED");
    if (upper === "HOME" && environment[key] !== home) fail("ENVIRONMENT_REJECTED");
  }
}

/** Explicit in-memory dependency injection for tests. The runtime wrapper below
 * resolves the repo's actual driver chain and OS account home; no environment
 * variable may provide a package, cache, executable, expected hash or version. */
export function createP2CiBrowserLockGuard({ filesystem: io, platform, architecture, userHome,
  driverPackagePath, playwrightPackagePath, corePackagePath, probeVersion }) {
  return (environment = {}) => safe(() => {
    if (platform !== "linux" || architecture !== "x64") fail("PLATFORM_REJECTED");
    const home = absolute(userHome);
    if (home === "/") fail("PATH_REJECTED");
    environmentAllowed(environment, home);
    const registryPath = linux.join(linux.dirname(absolute(corePackagePath)), "browsers.json");
    const executablePath = linux.join(home, ".cache/ms-playwright", `chromium_headless_shell-${revision}`,
      "chrome-headless-shell-linux64/chrome-headless-shell");

    function owned(at, kind) {
      absolute(at);
      let cursor = "/", stat;
      const parts = at.split("/").filter(Boolean);
      for (let index = 0; index <= parts.length; index++) {
        if (index) cursor = linux.join(cursor, parts[index - 1]);
        stat = io.lstatSync(cursor);
        if (stat.isSymbolicLink()) fail("LINK_REJECTED");
        if (index < parts.length || kind === "directory") { if (!stat.isDirectory()) fail("FILE_REJECTED"); }
        else if (!stat.isFile()) fail("FILE_REJECTED");
        if (io.realpathSync(cursor) !== cursor) fail("REALPATH_CHANGED");
      }
      return stat;
    }
    function read(at, maximum, collect = false) {
      const before = owned(at, "file");
      if (!Number.isSafeInteger(before.size) || before.size < 1 || before.size > maximum) fail("FILE_SIZE_REJECTED");
      const fd = io.openSync(at, "r"), chunks = [], digest = createHash("sha256"), chunk = Buffer.alloc(1024 * 1024);
      let size = 0, opened;
      try {
        opened = io.fstatSync(fd);
        if (!opened.isFile() || !same(before, opened)) fail("FILE_CHANGED");
        for (;;) {
          const count = io.readSync(fd, chunk, 0, chunk.length, null);
          if (!Number.isSafeInteger(count) || count < 0 || count > chunk.length) fail("FILE_CHANGED");
          if (!count) break;
          size += count;
          if (size > before.size || size > maximum) fail("FILE_CHANGED");
          digest.update(chunk.subarray(0, count));
          if (collect) chunks.push(Buffer.from(chunk.subarray(0, count)));
        }
        if (size !== before.size || !same(opened, io.fstatSync(fd))) fail("FILE_CHANGED");
      } finally { io.closeSync(fd); }
      if (!same(opened, owned(at, "file"))) fail("FILE_CHANGED");
      return { bytes: size, sha256: digest.digest("hex"), content: collect ? Buffer.concat(chunks) : undefined };
    }
    const packageFiles = [driverPackagePath, playwrightPackagePath, corePackagePath].map(at => read(absolute(at), 256 * 1024, true));
    const packages = packageFiles.map(file => JSON.parse(file.content.toString("utf8")));
    if (packages[0].name !== "@playwright/test" || packages[1].name !== "playwright" || packages[2].name !== "playwright-core"
      || packages.some(pkg => pkg.version !== version) || packages[0].dependencies?.playwright !== version
      || packages[1].dependencies?.["playwright-core"] !== version) fail("DRIVER_CHANGED");
    const registry = read(registryPath, 64 * 1024, true);
    if (registry.sha256 !== P2_CI_BROWSER_REGISTRY_SHA256) fail("REGISTRY_CHANGED");
    const definition = JSON.parse(registry.content.toString("utf8")).browsers?.filter(value => value.name === "chromium-headless-shell");
    if (!Array.isArray(definition) || definition.length !== 1 || definition[0].revision !== revision
      || definition[0].browserVersion !== browserVersion || definition[0].installByDefault !== true) fail("REGISTRY_CHANGED");
    const executable = read(executablePath, 1024 * 1024 * 1024);
    const stat = owned(executablePath, "file");
    if (!(stat.mode & 0o111)) fail("EXECUTABLE_REJECTED");
    const fd = io.openSync(executablePath, "r"), header = Buffer.alloc(20);
    try {
      if (io.readSync(fd, header, 0, header.length, null) !== header.length || header.subarray(0, 4).toString("hex") !== "7f454c46"
        || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 62) fail("EXECUTABLE_REJECTED");
    } finally { io.closeSync(fd); }
    const result = probeVersion(executablePath, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 4096,
      windowsHide: true, env: { HOME: home, PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
    if (!object(result) || result.error || result.signal || result.status !== 0 || typeof result.stdout !== "string"
      || result.stdout.length > 4096 || !new RegExp(`^(?:Chromium|Google Chrome for Testing) ${browserVersion.replaceAll(".", "\\.")}$`).test(result.stdout.trim())) fail("VERSION_CHANGED");
    const recheck = () => safe(() => {
      for (let index = 0; index < packageFiles.length; index++) {
        if (read([driverPackagePath, playwrightPackagePath, corePackagePath][index], 256 * 1024).sha256 !== packageFiles[index].sha256) fail("DRIVER_CHANGED");
      }
      if (read(registryPath, 64 * 1024).sha256 !== P2_CI_BROWSER_REGISTRY_SHA256) fail("REGISTRY_CHANGED");
      const current = read(executablePath, 1024 * 1024 * 1024);
      if (current.sha256 !== executable.sha256 || current.bytes !== executable.bytes || !same(stat, owned(executablePath, "file"))) fail("EXECUTABLE_CHANGED");
    });
    recheck();
    const metadata = Object.freeze({ family: "p2_linux_ci_official_headless_shell_v1", platform: "linux-x64", driverVersion: version,
      sourcePackageVersion: version, sourcePackageIntegrity: "sha512-h7Qlt6m4REp25qvIdvbDtVmD4LqVXfpRxhORv9L0jzETM05p4fuPJ3dKyuSXQxDSbXnmS79HAgi9589lGSpLkg==",
      registrySha256: registry.sha256, browserName: "chromium-headless-shell", browserVersion, revision, cacheKind: "os_account_default",
      executablePath, executableSha256: executable.sha256, executableBytes: executable.bytes, executableVersionOutput: result.stdout.trim(),
      binaryDigestKind: "observed_at_admission" });
    const selected = Object.freeze({ executablePath, executableSha256: executable.sha256, executableBytes: executable.bytes,
      browserVersion, revision, registrySha256: registry.sha256, metadata });
    approved.add(selected); rechecks.set(selected, recheck);
    return selected;
  });
}

/** Windows retains the existing full payload receipt and original pinnedUse.
 * Linux CI has a distinct registry/version/binary-observation metadata family. */
export function requireP2BrowserLock(environment = process.env) {
  if (process.platform === "win32") {
    const selected = requireStudioDocumentTransferBrowserLock(environment);
    approved.add(selected); windows.add(selected);
    return selected;
  }
  return safe(() => {
    if (process.platform !== "linux" || process.arch !== "x64" || environment.CI !== "true") fail("PLATFORM_REJECTED");
    const require = createRequire(import.meta.url), driverPackagePath = require.resolve("@playwright/test/package.json");
    const playwrightPackagePath = createRequire(driverPackagePath).resolve("playwright/package.json");
    const corePackagePath = createRequire(playwrightPackagePath).resolve("playwright-core/package.json");
    return createP2CiBrowserLockGuard({ filesystem, platform: process.platform, architecture: process.arch, userHome: os.userInfo().homedir,
      driverPackagePath, playwrightPackagePath, corePackagePath, probeVersion: spawnSync })(environment);
  });
}

export function p2PinnedBrowserUse(selected, inheritedUse = {}) {
  if (approved.has(selected) && windows.has(selected)) return studioDocumentTransferPinnedBrowserUse(selected, inheritedUse);
  return safe(() => {
    if (!approved.has(selected) || !object(inheritedUse)) fail("SELECTION_REQUIRED");
    for (const key of ["launchOptions", "connectOptions", "_optionConnectOptions", "channel"]) if (inheritedUse[key] !== undefined) fail("LAUNCH_OVERRIDE_REJECTED");
    if (inheritedUse.browserName !== undefined && inheritedUse.browserName !== "chromium"
      || inheritedUse.defaultBrowserType !== undefined && inheritedUse.defaultBrowserType !== "chromium"
      || inheritedUse.headless !== undefined && inheritedUse.headless !== true) fail("LAUNCH_OVERRIDE_REJECTED");
    rechecks.get(selected)();
    return { ...inheritedUse, browserName: "chromium", headless: true, channel: undefined, connectOptions: undefined,
      launchOptions: Object.freeze({ executablePath: selected.executablePath }) };
  });
}
