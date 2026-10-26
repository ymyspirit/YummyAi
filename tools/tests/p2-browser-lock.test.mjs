import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { URL } from "node:url";
import test from "node:test";
import { createP2CiBrowserLockGuard, p2PinnedBrowserUse, P2_CI_BROWSER_REGISTRY_SHA256, P2_CI_DRIVER_REGISTRY_SHA256 } from "../testing/require-p2-browser-lock.mjs";

// The installed official registry is read once. All following packages, paths,
// executable bytes and version probes live in memory: no browser is executed,
// no directory is created, and no network, DB, queue or credential is used.
const require = createRequire(import.meta.url), driver = require.resolve("@playwright/test/package.json");
const playwright = createRequire(driver).resolve("playwright/package.json");
const core = createRequire(playwright).resolve("playwright-core/package.json");
const registryBytes = fs.readFileSync(path.join(path.dirname(core), "browsers.json"));
const sourceRegistryBytes = fs.readFileSync(new URL("../testing/fixtures/p2-ci-browser-source-browsers.json", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = code => new RegExp(`^P2_BROWSER_LOCK_${code}$`);
const rejects = (fn, code) => assert.throws(fn, error => fail(code).test(error.message));

function fixture() {
  const home = "/home/runner", root = "/repo/node_modules", nodes = new Map(), handles = new Map(), calls = { probes: [], reads: 0 };
  const driverPath = `${root}/driver/package.json`, playwrightPath = `${root}/playwright/package.json`, corePath = `${root}/core/package.json`;
  const registry = `${root}/core/browsers.json`;
  const sourcePath = "/repo/.artifacts/toolchains/p2-linux-browser-157/source-package/package.json", sourceRegistry = path.posix.join(path.posix.dirname(sourcePath), "browsers.json");
  const executable = `${home}/.cache/ms-playwright/chromium_headless_shell-1251/chrome-headless-shell-linux64/chrome-headless-shell`;
  let ino = 1, counter = 1, probe = () => ({ status: 0, signal: null, stdout: "Chromium 157.0.8103.6\n", stderr: "" }), onRead;
  function directory(at) {
    if (nodes.has(at)) return;
    if (at !== "/") directory(path.posix.dirname(at));
    nodes.set(at, { kind: "directory", ino: ino++, mode: 0o40755, time: counter++, content: Buffer.alloc(0) });
  }
  function write(at, bytes, mode = 0o100644) {
    directory(path.posix.dirname(at));
    nodes.set(at, { kind: "file", ino: ino++, mode, time: counter++, content: Buffer.from(bytes) });
  }
  function node(at) { const value = nodes.get(at); if (!value) throw new Error("SYNTHETIC_MISSING"); return value; }
  function stat(at) {
    const value = node(at);
    return { dev: 1, ino: value.ino, size: value.content.length, mode: value.mode, mtimeMs: value.time, ctimeMs: value.time,
      isSymbolicLink: () => value.kind === "link", isDirectory: () => value.kind === "directory", isFile: () => value.kind === "file" };
  }
  const io = {
    lstatSync: stat, realpathSync: at => node(at).realpath ?? at,
    openSync(at, flags) { assert.equal(flags, "r"); const fd = counter++; handles.set(fd, { at, position: 0 }); return fd; },
    fstatSync(fd) { return stat(handles.get(fd).at); },
    readSync(fd, buffer, offset, length, position) {
      assert.equal(position, null); const handle = handles.get(fd), value = node(handle.at);
      const count = value.content.copy(buffer, offset, handle.position, handle.position + length);
      handle.position += count; calls.reads++;
      onRead?.(handle.at, count);
      return count;
    },
    closeSync(fd) { assert.ok(handles.delete(fd)); },
  };
  write(driverPath, JSON.stringify({ name: "@playwright/test", version: "1.61.1", dependencies: { playwright: "1.61.1" } }));
  write(playwrightPath, JSON.stringify({ name: "playwright", version: "1.61.1", dependencies: { "playwright-core": "1.61.1" } }));
  write(corePath, JSON.stringify({ name: "playwright-core", version: "1.61.1" }));
  write(registry, registryBytes);
  write(sourcePath, JSON.stringify({ name: "playwright-core", version: "1.65.0-alpha-2026-10-23" }));
  write(sourceRegistry, sourceRegistryBytes);
  const elf = Buffer.alloc(1024 * 1024 + 29, 0x61);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(elf); elf.writeUInt16LE(62, 18);
  write(executable, elf, 0o100755);
  const parameters = { filesystem: io, platform: "linux", architecture: "x64", userHome: home,
    driverPackagePath: driverPath, playwrightPackagePath: playwrightPath, corePackagePath: corePath, sourcePackagePath: sourcePath,
    expectedExecutableSha256: hash(elf), expectedExecutableBytes: elf.byteLength,
    probeVersion(at, args, options) { calls.probes.push({ at, args, options }); return probe(at, args, options); } };
  return { home, root, driverPath, playwrightPath, corePath, registry, sourcePath, sourceRegistry, executable, nodes, node, write, calls, handles,
    setProbe(fn) { probe = fn; }, onRead(fn) { onRead = fn; },
    run(environment = { CI: "true", HOME: home }, overrides = {}) { return createP2CiBrowserLockGuard({ ...parameters, ...overrides })(environment); } };
}

test("Linux CI retains driver1.61.1 and selects fixed official157 / revision1251 with two independent registries", () => {
  assert.equal(hash(registryBytes), P2_CI_DRIVER_REGISTRY_SHA256);
  assert.equal(hash(sourceRegistryBytes), P2_CI_BROWSER_REGISTRY_SHA256);
  const f = fixture(), selected = f.run();
  assert.equal(selected.executablePath, f.executable); assert.equal(selected.browserVersion, "157.0.8103.6");
  assert.equal(selected.revision, "1251"); assert.equal(selected.executableSha256, hash(f.node(f.executable).content));
  assert.equal(selected.metadata.family, "p2_linux_ci_official_headless_shell_v2");
  assert.equal(selected.metadata.binaryDigestKind, "pinned_official_archive_v2"); assert.equal(selected.lockSha256, undefined);
  assert.equal(selected.metadata.driverRegistrySha256, P2_CI_DRIVER_REGISTRY_SHA256);
  assert.equal(selected.metadata.sourcePackageVersion, "1.65.0-alpha-2026-10-23");
  assert.equal(selected.metadata.registrySha256, P2_CI_BROWSER_REGISTRY_SHA256);
  assert.ok(Object.isFrozen(selected)); assert.ok(Object.isFrozen(selected.metadata)); assert.equal(f.handles.size, 0);
  assert.equal(f.calls.probes.length, 1); assert.deepEqual(f.calls.probes[0].args, ["--version"]);
  assert.deepEqual(f.calls.probes[0].options.env, { HOME: f.home, PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" });
  const use = p2PinnedBrowserUse(selected, { viewport: { width: 1440, height: 960 }, trace: "off" });
  assert.equal(use.browserName, "chromium"); assert.equal(use.headless, true); assert.equal(use.launchOptions.executablePath, f.executable);
  assert.equal(use.connectOptions, undefined); assert.equal(use.channel, undefined);
});

test("non-CI Linux, unsupported platforms and architectures reject before any files or executable probe", () => {
  for (const environment of [{}, { CI: "1" }, { CI: "false" }, { ci: "true" }]) {
    const f = fixture(); rejects(() => f.run(environment), "PLATFORM_REJECTED"); assert.equal(f.calls.reads, 0); assert.equal(f.calls.probes.length, 0);
  }
  for (const overrides of [{ platform: "darwin" }, { platform: "win32" }, { architecture: "arm64" }]) {
    const f = fixture(); rejects(() => f.run(undefined, overrides), "PLATFORM_REJECTED"); assert.equal(f.calls.reads, 0);
  }
});

test("remote transport and browser/cache/home/loader overrides cannot select a different runtime", () => {
  for (const name of ["PLAYWRIGHT_BROWSERS_PATH", "PLAYWRIGHT_DOWNLOAD_HOST", "PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST", "XDG_CACHE_HOME",
    "PW_TEST_CONNECT_WS_ENDPOINT", "pw_test_connect_headers", "PW_TEST_REUSE_CONTEXT", "PWDEBUG", "CHROME_BIN", "EXECUTABLE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH"]) {
    const f = fixture(); rejects(() => f.run({ CI: "true", [name]: "SYNTHETIC_OVERRIDE" }), "ENVIRONMENT_REJECTED");
    assert.equal(f.calls.reads, 0); assert.equal(f.calls.probes.length, 0);
  }
  rejects(() => fixture().run({ CI: "true", HOME: "/other" }), "ENVIRONMENT_REJECTED");
});

test("driver version/dependency and raw official registry bytes cannot drift", () => {
  for (const at of ["driverPath", "playwrightPath", "corePath"]) {
    const f = fixture(), pkg = JSON.parse(f.node(f[at]).content); pkg.version = "1.61.2"; f.write(f[at], JSON.stringify(pkg));
    rejects(() => f.run(), "DRIVER_CHANGED"); assert.equal(f.calls.probes.length, 0); assert.equal(f.handles.size, 0);
  }
  const dependency = fixture(), pkg = JSON.parse(dependency.node(dependency.driverPath).content); pkg.dependencies.playwright = "1.65.0";
  dependency.write(dependency.driverPath, JSON.stringify(pkg)); rejects(() => dependency.run(), "DRIVER_CHANGED");
  const changed = fixture(); changed.write(changed.registry, Buffer.concat([registryBytes, Buffer.from("\n")]));
  rejects(() => changed.run(), "REGISTRY_CHANGED"); assert.equal(changed.calls.probes.length, 0);
});

test("the independent browser source package and raw registry cannot impersonate the unchanged driver", () => {
  for (const field of ["name", "version"]) {
    const f = fixture(), pkg = JSON.parse(f.node(f.sourcePath).content); pkg[field] = "SYNTHETIC_OTHER_SOURCE";
    f.write(f.sourcePath, JSON.stringify(pkg)); rejects(() => f.run(), "SOURCE_CHANGED"); assert.equal(f.calls.probes.length, 0);
  }
  const raw = fixture(); raw.write(raw.sourceRegistry, Buffer.concat([sourceRegistryBytes, Buffer.from("\n")]));
  rejects(() => raw.run(), "REGISTRY_CHANGED"); assert.equal(raw.calls.probes.length, 0);
  const late = fixture(); late.setProbe(() => {
    late.write(late.sourcePath, JSON.stringify({ name: "playwright-core", version: "1.65.0-alpha-2026-10-22" }));
    return { status: 0, stdout: "Chromium 157.0.8103.6" };
  });
  rejects(() => late.run(), "SOURCE_CHANGED");
});

test("a valid ELF and claimed browser version still require the reviewed binary bytes and size", () => {
  const changed = fixture(); changed.node(changed.executable).content[30] ^= 1;
  rejects(() => changed.run(), "EXECUTABLE_CHANGED"); assert.equal(changed.calls.probes.length, 0);
  const size = fixture(); rejects(() => size.run(undefined, { expectedExecutableBytes: size.node(size.executable).content.length + 1 }), "EXECUTABLE_CHANGED");
  const missing = fixture(); rejects(() => missing.run(undefined, { expectedExecutableSha256: null }), "PIN_CHANGED");
});

test("every ancestor and the exact executable reject links, redirections, non-regular files and non-executable payloads", () => {
  for (const select of [f => f.home, f => `${f.home}/.cache`, f => path.posix.dirname(f.executable), f => f.executable, f => f.registry, f => f.sourceRegistry, f => f.sourcePath]) {
    const f = fixture(); f.node(select(f)).kind = "link"; rejects(() => f.run(), "LINK_REJECTED"); assert.equal(f.handles.size, 0);
  }
  const escape = fixture(); escape.node(escape.home).realpath = "/elsewhere"; rejects(() => escape.run(), "REALPATH_CHANGED");
  const nonregular = fixture(); nonregular.node(nonregular.executable).kind = "fifo"; rejects(() => nonregular.run(), "FILE_REJECTED");
  const mode = fixture(); mode.node(mode.executable).mode = 0o100644; rejects(() => mode.run(), "EXECUTABLE_REJECTED");
  const absent = fixture(); absent.nodes.delete(absent.executable); rejects(() => absent.run(), "IO_REJECTED");
});

test("the actual executable must be a 64-bit x86 ELF and report the pinned Chromium version", () => {
  for (const mutate of [bytes => { bytes[0] = 0; }, bytes => { bytes[4] = 1; }, bytes => bytes.writeUInt16LE(183, 18)]) {
    const f = fixture(); mutate(f.node(f.executable).content); rejects(() => f.run(), "EXECUTABLE_REJECTED"); assert.equal(f.calls.probes.length, 0);
  }
  for (const output of [{ status: 1, stdout: "Chromium 157.0.8103.6" }, { status: 0, stdout: "Chromium 157.0.8103.7" },
    { status: 0, stdout: "Firefox 157.0.8103.6" }, { status: 0, stdout: "Chromium 157.0.8103.6\nEXTRA" },
    { status: null, error: new Error("SYNTHETIC_TIMEOUT"), stdout: "" }]) {
    const f = fixture(); f.setProbe(() => output); rejects(() => f.run(), "VERSION_CHANGED"); assert.equal(f.handles.size, 0);
  }
});

test("bytes changed during hashing or the version probe cannot acquire or retain admission", () => {
  const during = fixture(); during.onRead((at, count) => { if (at === during.executable && count) { during.onRead(undefined); during.node(at).time++; } });
  rejects(() => during.run(), "FILE_CHANGED"); assert.equal(during.handles.size, 0);
  const probe = fixture(); probe.setProbe(() => { probe.node(probe.executable).content[30] ^= 1; return { status: 0, stdout: "Chromium 157.0.8103.6" }; });
  rejects(() => probe.run(), "EXECUTABLE_CHANGED");
  const late = fixture(), selected = late.run(); late.node(late.executable).content[30] ^= 1;
  rejects(() => p2PinnedBrowserUse(selected), "EXECUTABLE_CHANGED");
});

test("only the admitted object can build local headless Chromium options, with no inherited launch/remote override", () => {
  const f = fixture(), selected = f.run();
  rejects(() => p2PinnedBrowserUse({ ...selected }), "SELECTION_REQUIRED");
  for (const inherited of [{ launchOptions: {} }, { channel: "chrome" }, { connectOptions: { wsEndpoint: "ws://synthetic" } },
    { _optionConnectOptions: {} }, { browserName: "firefox" }, { defaultBrowserType: "webkit" }, { headless: false }]) {
    rejects(() => p2PinnedBrowserUse(selected, inherited), "LAUNCH_OVERRIDE_REJECTED");
  }
});
