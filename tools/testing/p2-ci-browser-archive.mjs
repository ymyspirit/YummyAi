import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import { setTimeout, clearTimeout } from "node:timers";

const MiB = 1024 * 1024;
export const P2_BROWSER_ARCHIVE_LIMITS = Object.freeze({ packageBytes: 32 * MiB, archiveBytes: 512 * MiB,
  memberBytes: 512 * MiB, expandedBytes: 1024 * MiB, members: 2048, metadataBytes: 256 * 1024 });
const fail = code => { throw new Error("P2_BROWSER_ARCHIVE_" + code); };
const digest = (bytes, algorithm = "sha256", encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);
const json = bytes => { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return fail("JSON_REJECTED"); } };

export function assertP2BrowserPin(pin) {
  const browser = pin?.browser, source = pin?.sourcePackage;
  if (pin?.version !== 2 || pin.driver?.version !== "1.61.1" || !/^[a-f0-9]{64}$/.test(pin.driver?.registrySha256 ?? "")
    || source?.name !== "playwright-core" || typeof source.version !== "string" || !/^[a-f0-9]{40}$/.test(source.gitHead ?? "")
    || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(source.integrity ?? "") || !/^[a-f0-9]{64}$/.test(source.registrySha256 ?? "")
    || source.url !== "https://registry.npmjs.org/playwright-core/-/playwright-core-" + source.version + ".tgz"
    || source.relative !== ".artifacts/toolchains/p2-linux-browser-157/source-package"
    || browser?.name !== "chromium-headless-shell" || browser.revision !== "1251" || browser.version !== "157.0.8103.6"
    || browser.url !== "https://cdn.playwright.dev/builds/cft/157.0.8103.6/linux64/chrome-headless-shell-linux64.zip") fail("PIN_REJECTED");
  if (!/^[a-f0-9]{64}$/.test(browser.archiveSha256 ?? "") || !/^[a-f0-9]{64}$/.test(browser.executableSha256 ?? "")
    || !Number.isSafeInteger(browser.archiveBytes) || browser.archiveBytes < 1 || browser.archiveBytes > P2_BROWSER_ARCHIVE_LIMITS.archiveBytes
    || !Number.isSafeInteger(browser.executableBytes) || browser.executableBytes < 64 || browser.executableBytes > P2_BROWSER_ARCHIVE_LIMITS.memberBytes) fail("PIN_INCOMPLETE");
}

/** tar is injected for pure tests. The installer runs only the system tar,
 * twice over stdin; no package JavaScript or archive paths are executed. */
export function readPinnedSourcePackage(bytes, pin, runTar) {
  assertP2BrowserPin(pin);
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > P2_BROWSER_ARCHIVE_LIMITS.packageBytes
    || "sha512-" + digest(bytes, "sha512", "base64") !== pin.sourcePackage.integrity) fail("PACKAGE_INTEGRITY_REJECTED");
  const packageBytes = runTar("package/package.json", bytes, P2_BROWSER_ARCHIVE_LIMITS.metadataBytes),
    registryBytes = runTar("package/browsers.json", bytes, 64 * 1024);
  if (!Buffer.isBuffer(packageBytes) || packageBytes.length < 1 || packageBytes.length > P2_BROWSER_ARCHIVE_LIMITS.metadataBytes
    || !Buffer.isBuffer(registryBytes) || registryBytes.length < 1 || registryBytes.length > 64 * 1024) fail("PACKAGE_METADATA_REJECTED");
  const pkg = json(packageBytes), registry = json(registryBytes);
  // npm's gitHead is registry provenance and need not occur inside package.json.
  // The pinned tgz integrity authenticates both extracted metadata files.
  if (pkg?.name !== pin.sourcePackage.name || pkg.version !== pin.sourcePackage.version
    || pkg.gitHead !== undefined && pkg.gitHead !== pin.sourcePackage.gitHead
    || digest(registryBytes) !== pin.sourcePackage.registrySha256) fail("PACKAGE_METADATA_REJECTED");
  const selected = registry?.browsers?.filter(value => value.name === pin.browser.name);
  if (!Array.isArray(selected) || selected.length !== 1 || selected[0].revision !== pin.browser.revision
    || selected[0].browserVersion !== pin.browser.version || selected[0].installByDefault !== true) fail("BROWSER_DEFINITION_REJECTED");
  return Object.freeze({ packageBytes, registryBytes });
}

/** Inspect raw central names/types before JSZip can normalize them. Neither
 * stage writes files; returned reads address only the exact reviewed members. */
export async function inspectPinnedBrowserArchive(bytes, pin, { yauzl, JSZip }) {
  assertP2BrowserPin(pin);
  if (!Buffer.isBuffer(bytes) || bytes.length !== pin.browser.archiveBytes || digest(bytes) !== pin.browser.archiveSha256) fail("ZIP_INTEGRITY_REJECTED");
  const members = [], names = new Set(), prefix = "chrome-headless-shell-linux64/";
  let expanded = 0, compressed = 0;
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(bytes,
    { lazyEntries: true, decodeStrings: false, validateEntrySizes: true, strictFileNames: true },
    (error, value) => error ? reject(error) : resolve(value)));
  try {
    if (!Number.isSafeInteger(zip.entryCount) || zip.entryCount < 1 || zip.entryCount > P2_BROWSER_ARCHIVE_LIMITS.members) fail("MEMBER_COUNT_REJECTED");
    const forbidden = () => fail("EARLY_CONTENT_READ_REJECTED");
    zip.openReadStream = forbidden; zip.openReadStreamLowLevel = forbidden; zip.readLocalFileHeader = forbidden;
    await new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => rejectOnce(new Error("P2_BROWSER_ARCHIVE_DIRECTORY_TIMEOUT")), 15_000);
      const rejectOnce = error => { if (!done) { done = true; clearTimeout(timer); zip.close(); reject(error); } };
      zip.on("error", rejectOnce); zip.on("end", () => { if (!done) { done = true; clearTimeout(timer); resolve(); } });
      zip.on("entry", entry => {
        if (done) return;
        try {
          const raw = entry.fileNameRaw;
          if (!Buffer.isBuffer(raw) || raw.length < 1 || raw.length > 512 || !raw.every(byte => byte >= 0x21 && byte <= 0x7e)) fail("NAME_REJECTED");
          const name = raw.toString("ascii"), directory = name.endsWith("/"), parts = name.split("/");
          if (directory) parts.pop();
          if (yauzl.getFileNameLowLevel(entry.generalPurposeBitFlag, raw, entry.extraFields, true) !== name
            || !name.startsWith(prefix) || name.includes("\\") || name.includes(":") || parts.some(part => !/^[A-Za-z0-9_.+-]+$/.test(part) || [".", ".."].includes(part))
            || names.has(name.replace(/\/$/, "").toLowerCase())) fail("NAME_REJECTED");
          names.add(name.replace(/\/$/, "").toLowerCase());
          const type = (entry.externalFileAttributes >>> 16) & 0o170000, mode = (entry.externalFileAttributes >>> 16) & 0o7777;
          if (type !== 0 && type !== (directory ? 0o040000 : 0o100000) || mode & 0o7000
            || entry.externalFileAttributes & (0x8 | 0x400) || entry.externalFileAttributes & 0x10 && !directory
            || entry.generalPurposeBitFlag & (0x1 | 0x40) || ![0, 8].includes(entry.compressionMethod)) fail("MEMBER_TYPE_REJECTED");
          for (const value of [entry.compressedSize, entry.uncompressedSize, entry.relativeOffsetOfLocalHeader])
            if (!Number.isSafeInteger(value) || value < 0) fail("SIZE_REJECTED");
          if (entry.relativeOffsetOfLocalHeader >= bytes.length || entry.compressedSize > bytes.length || entry.relativeOffsetOfLocalHeader + entry.compressedSize > bytes.length
            || entry.uncompressedSize > P2_BROWSER_ARCHIVE_LIMITS.memberBytes || directory && entry.uncompressedSize !== 0) fail("SIZE_REJECTED");
          expanded += entry.uncompressedSize; compressed += entry.compressedSize;
          if (expanded > P2_BROWSER_ARCHIVE_LIMITS.expandedBytes || compressed > bytes.length) fail("SIZE_REJECTED");
          members.push(Object.freeze({ name, directory, bytes: entry.uncompressedSize, mode: mode & 0o111 ? 0o755 : 0o644 }));
          zip.readEntry();
        } catch (error) { rejectOnce(error); }
      }); zip.readEntry();
    });
    if (members.length !== zip.entryCount || !members.some(value => value.name === prefix + "chrome-headless-shell" && !value.directory)) fail("MEMBER_COUNT_REJECTED");
    const kinds = new Map(members.map(value => [value.name.replace(/\/$/, "").toLowerCase(), value.directory]));
    for (const member of members) {
      const parents = member.name.replace(/\/$/, "").split("/"); parents.pop();
      while (parents.length) { if (kinds.get(parents.join("/").toLowerCase()) === false) fail("PARENT_FILE_REJECTED"); parents.pop(); }
    }
  } finally { zip.close(); }
  const decoded = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("P2_BROWSER_ARCHIVE_CRC_TIMEOUT")), 120_000);
    Promise.resolve().then(() => JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false }))
      .then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
  if (Object.keys(decoded.files).length !== members.length) fail("DECODED_MEMBERS_REJECTED");
  const map = new Map(members.map(value => [value.name, value]));
  for (const name of Object.keys(decoded.files)) {
    const member = map.get(name), file = decoded.files[name];
    if (!member || member.directory !== file.dir || !file.dir && file.unsafeOriginalName !== name) fail("DECODED_MEMBERS_REJECTED");
  }
  return Object.freeze({ members: Object.freeze(members), async readMember(name) {
    const member = map.get(name); if (!member || member.directory) fail("MEMBER_READ_REJECTED");
    const content = await decoded.files[name].async("nodebuffer");
    if (content.length !== member.bytes) fail("MEMBER_SIZE_REJECTED");
    return content;
  } });
}
