import { execFile } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, randomBytes, X509Certificate } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { ServerOptions } from "node:https";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { StoreNodeEnrollmentResultSchema, StoreNodePublicKeySchema, STORE_NODE_PROTOCOL,
  type StoreNodeEnrollmentResult, type StoreNodeWorkspace } from "@yummyai/contracts/marketplace/store-node";

import { StoreNodeCertificateIssuer, storeNodeCertificateValidity } from "./store-node.types.js";

export class StoreNodePkiError extends Error {
  constructor(readonly code: "store_node_configuration_invalid" | "store_node_runtime_disabled" | "store_node_certificate_issue_failed") {
    super(code); this.name = "StoreNodePkiError";
  }
}

type EnabledConfiguration = { openssl: string; caPath: string; caKeyPath: string; caPem: string; ca: X509Certificate;
  serverPem: string; serverKey: Buffer; enrollmentOrigin: string; runtimeOrigin: string; host: string; port: number };

export function storeNodePublicKey(publicKeyPem: string) {
  StoreNodePublicKeySchema.parse(publicKeyPem);
  const key = createPublicKey(publicKeyPem);
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (key.asymmetricKeyType !== "rsa" || bits < 3072 || bits > 4096
    || key.export({ type: "spki", format: "pem" }).toString() !== publicKeyPem) throw new StoreNodePkiError("store_node_certificate_issue_failed");
  return { key, sha256: createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex") };
}

/** Format the shared claim-clock interval for OpenSSL without consulting its clock. */
export function storeNodeCertificateTimeArguments(validity: { startsAt: Date; expiresAt: Date }): string[] {
  const { startsAt, expiresAt } = validity;
  if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(expiresAt.getTime())
    || startsAt.getUTCFullYear() < 1 || expiresAt.getUTCFullYear() > 9999)
    throw new StoreNodePkiError("store_node_certificate_issue_failed");
  const opensslTime = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace("T", "").replace(".000Z", "Z");
  return ["-not_before", opensslTime(startsAt), "-not_after", opensslTime(expiresAt)];
}

export class StoreNodePki extends StoreNodeCertificateIssuer {
  private constructor(private readonly enabled: EnabledConfiguration | null) { super(); }

  static async fromEnvironment(env: NodeJS.ProcessEnv = process.env): Promise<StoreNodePki> {
    if (env.STORE_NODE_RUNTIME_ENABLED !== "1") {
      if (env.STORE_NODE_RUNTIME_ENABLED !== undefined && env.STORE_NODE_RUNTIME_ENABLED !== "0") throw new StoreNodePkiError("store_node_configuration_invalid");
      return new StoreNodePki(null);
    }
    let serverKey: Buffer | undefined;
    try {
      rejectKeyLogging(env);
      const openssl = await regularFile(env.STORE_NODE_OPENSSL_PATH);
      const caPath = await regularFile(env.STORE_NODE_CA_CERT_PATH), caKeyPath = await regularFile(env.STORE_NODE_CA_KEY_PATH);
      const serverPath = await regularFile(env.STORE_NODE_SERVER_CERT_PATH), serverKeyPath = await regularFile(env.STORE_NODE_SERVER_KEY_PATH);
      const enrollmentOrigin = origin(env.STORE_NODE_ENROLLMENT_ORIGIN), runtimeOrigin = origin(env.STORE_NODE_RUNTIME_ORIGIN);
      const host = env.STORE_NODE_RUNTIME_HOST ?? "127.0.0.1";
      if (!host || host.length > 253 || !/^[A-Za-z0-9.:-]+$/.test(host)) throw new Error();
      if (!env.STORE_NODE_RUNTIME_PORT || !/^[1-9]\d{0,4}$/.test(env.STORE_NODE_RUNTIME_PORT)) throw new Error();
      const port = Number(env.STORE_NODE_RUNTIME_PORT);
      if (port > 65535) throw new Error();
      const version = await execute(openssl, ["version"]);
      if (!/^OpenSSL 3\./.test(version)) throw new Error();
      const caPem = normalizePem(await boundedRead(caPath, 16_384)), cas = certificates(caPem);
      const ca = cas[0]!;
      if (!ca.ca || cas.some(cert => !cert.ca)) throw new Error();
      validateChain(cas, [cas.at(-1)!], new Date());
      const caKeyBytes = await boundedRead(caKeyPath, 32_768);
      try { if (!ca.checkPrivateKey(createPrivateKey(caKeyBytes))) throw new Error(); }
      finally { caKeyBytes.fill(0); }
      const serverPem = normalizePem(await boundedRead(serverPath, 32_768)), servers = certificates(serverPem);
      const server = servers[0]!;
      validateChain(servers, cas, new Date());
      const hostname = new URL(runtimeOrigin).hostname.replace(/^\[|\]$/g, "");
      if (server.ca || !server.keyUsage?.includes("1.3.6.1.5.5.7.3.1")
        || !(isIP(hostname) ? server.checkIP(hostname) : server.checkHost(hostname))) throw new Error();
      serverKey = await boundedRead(serverKeyPath, 32_768);
      if (!server.checkPrivateKey(createPrivateKey(serverKey))) throw new Error();
      return new StoreNodePki({ openssl, caPath, caKeyPath, caPem, ca, serverPem, serverKey,
        enrollmentOrigin, runtimeOrigin, host, port });
    } catch { serverKey?.fill(0); throw new StoreNodePkiError("store_node_configuration_invalid"); }
  }

  configuration(): StoreNodeWorkspace["configuration"] {
    const value = this.enabled;
    return { enabled: Boolean(value), enrollmentOrigin: value?.enrollmentOrigin ?? null, runtimeOrigin: value?.runtimeOrigin ?? null,
      caCertificateSha256: value ? createHash("sha256").update(value.caPem).digest("hex") : null };
  }
  caCertificatePem(): string { return this.requireEnabled().caPem; }
  runtimeAddress() { const value = this.requireEnabled(); return { host: value.host, port: value.port }; }
  runtimeServerOptions(): ServerOptions {
    rejectKeyLogging(process.env);
    const value = this.requireEnabled();
    return { key: value.serverKey, cert: value.serverPem, ca: value.caPem, minVersion: "TLSv1.3",
      requestCert: true, rejectUnauthorized: true, allowPartialTrustChain: true, enableTrace: false };
  }

  async issue(input: { nodeId: string; accountId: string; publicKeyPem: string; certificateGeneration: number; issuedAt: Date }): Promise<StoreNodeEnrollmentResult> {
    const value = this.requireEnabled();
    let directory: string | undefined;
    try {
      EntityIdSchema.parse(input.nodeId); EntityIdSchema.parse(input.accountId);
      if (!Number.isSafeInteger(input.certificateGeneration) || input.certificateGeneration < 1 || !Number.isFinite(input.issuedAt.getTime())) throw new Error();
      const validity = storeNodeCertificateValidity(input.issuedAt);
      const { key, sha256 } = storeNodePublicKey(input.publicKeyPem);
      directory = await mkdtemp(path.join(tmpdir(), "yummyai-store-node-pki-"));
      await secureDirectory(directory);
      const publicPath = path.join(directory, "public.pem"), extensionPath = path.join(directory, "client.ext"), certificatePath = path.join(directory, "client.pem");
      await writeFile(publicPath, input.publicKeyPem, { flag: "wx", mode: 0o600 });
      await writeFile(extensionPath, `[node_client]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,clientAuth\nsubjectAltName=URI:urn:yummyai:store-node:${input.nodeId}\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n`, { flag: "wx", mode: 0o600 });
      const serial = randomBytes(20); serial[0] = (serial[0]! & 0x7f) | 1;
      await execute(value.openssl, ["x509", "-new", "-force_pubkey", publicPath, "-subj", `/CN=store-node-${input.nodeId}`,
        "-CA", value.caPath, "-CAkey", value.caKeyPath, "-set_serial", `0x${serial.toString("hex")}`, ...storeNodeCertificateTimeArguments(validity), "-sha256",
        "-extfile", extensionPath, "-extensions", "node_client", "-out", certificatePath]);
      const certificatePem = normalizePem(await boundedRead(certificatePath, 16_384)), leaf = new X509Certificate(certificatePem);
      const expiresAt = new Date(leaf.validTo), startsAt = new Date(leaf.validFrom);
      if (leaf.ca || !leaf.checkIssued(value.ca) || !leaf.verify(value.ca.publicKey)
        || leaf.subjectAltName !== `URI:urn:yummyai:store-node:${input.nodeId}`
        || leaf.keyUsage?.length !== 1 || leaf.keyUsage[0] !== "1.3.6.1.5.5.7.3.2"
        || startsAt.getTime() !== validity.startsAt.getTime() || expiresAt.getTime() !== validity.expiresAt.getTime()
        || createHash("sha256").update(leaf.publicKey.export({ type: "spki", format: "der" })).digest("hex") !== sha256
        || !leaf.publicKey.equals(key)) throw new Error();
      await execute(value.openssl, ["verify", "-CAfile", value.caPath, "-partial_chain", "-purpose", "sslclient", certificatePath]);
      return StoreNodeEnrollmentResultSchema.parse({ protocol: STORE_NODE_PROTOCOL, nodeId: input.nodeId, accountId: input.accountId,
        certificateGeneration: input.certificateGeneration, certificatePem, caCertificatePem: value.caPem,
        runtimeOrigin: value.runtimeOrigin, expiresAt: expiresAt.toISOString() });
    } catch { throw new StoreNodePkiError("store_node_certificate_issue_failed"); }
    finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  }

  private requireEnabled() { if (!this.enabled) throw new StoreNodePkiError("store_node_runtime_disabled"); return this.enabled; }
}

function origin(value: string | undefined): string {
  if (!value) throw new Error();
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.origin !== value.replace(/\/$/, "")) throw new Error();
  return url.origin;
}
async function regularFile(value: string | undefined) {
  if (!value || !path.isAbsolute(value) || value.startsWith("\\\\") || value.startsWith("//")) throw new Error();
  value = path.resolve(value); await noLinks(value);
  const stat = await lstat(value);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
  return value;
}
async function noLinks(target: string) {
  target = path.resolve(target); let current = path.parse(target).root;
  for (const segment of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment); if ((await lstat(current)).isSymbolicLink()) throw new Error();
  }
}
async function boundedRead(file: string, maximum: number) { await noLinks(file); const stat = await lstat(file); if (!stat.isFile() || stat.size > maximum) throw new Error(); const bytes = await readFile(file); if (bytes.length > maximum) { bytes.fill(0); throw new Error(); } return bytes; }
function normalizePem(bytes: Buffer) { return bytes.toString("utf8").replace(/\r\n/g, "\n").trim() + "\n"; }
function certificates(pem: string) {
  const parts = pem.match(/-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE-----\n/g);
  if (!parts || parts.length > 4 || parts.join("") !== pem) throw new Error();
  return parts.map(part => new X509Certificate(part));
}
function validateChain(chain: X509Certificate[], trusted: X509Certificate[], now: Date) {
  for (const certificate of chain) if (new Date(certificate.validFrom) > now || new Date(certificate.validTo) <= now
    || (certificate.subject === certificate.issuer && !certificate.verify(certificate.publicKey))) throw new Error();
  for (let index = 0; index < chain.length - 1; index++)
    if (!chain[index]!.checkIssued(chain[index + 1]!) || !chain[index]!.verify(chain[index + 1]!.publicKey)) throw new Error();
  const last = chain.at(-1)!;
  if (!trusted.some(ca => ca.ca && (last.raw.equals(ca.raw) || (last.checkIssued(ca) && last.verify(ca.publicKey))))) throw new Error();
}
function rejectKeyLogging(env: NodeJS.ProcessEnv) {
  if (env.SSLKEYLOGFILE || /(?:^|\s)--tls-keylog(?:=|\s|$)/.test(env.NODE_OPTIONS ?? "")
    || process.execArgv.some(argument => argument === "--tls-keylog" || argument.startsWith("--tls-keylog="))) throw new StoreNodePkiError("store_node_configuration_invalid");
}
function childEnvironment() {
  return Object.fromEntries(["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}
function execute(executable: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, { windowsHide: true, timeout: 15_000, maxBuffer: 131_072, env: childEnvironment() },
      (error, stdout) => error ? reject(new Error("store_node_certificate_issue_failed")) : resolve(stdout));
    child.stdin?.on("error", () => undefined); child.stdin?.end(input);
  });
}
async function secureDirectory(directory: string) {
  if (process.platform !== "win32") return;
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!root || !path.isAbsolute(root)) throw new Error();
  const script = "$ErrorActionPreference='Stop';try{$p=[Console]::In.ReadLine()|ConvertFrom-Json;$s=[Security.Principal.WindowsIdentity]::GetCurrent().User;$a=[Security.AccessControl.DirectorySecurity]::new();$a.SetAccessRuleProtection($true,$false);foreach($i in @($s,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($i,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))};$o=[IO.Directory]::GetAccessControl($p.path).GetOwner([Security.Principal.SecurityIdentifier]);if($o.Value -ne $s.Value){$a.SetOwner($s);Set-Acl -LiteralPath $p.path -AclObject $a}else{[IO.Directory]::SetAccessControl($p.path,$a)};$v=[IO.Directory]::GetAccessControl($p.path);if(-not $v.AreAccessRulesProtected -or $v.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $s.Value -or @($v.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])).Count -ne 2){throw 'invalid'};[Console]::Out.Write('ok')}catch{exit 1}";
  if (await execute(path.join(root, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], JSON.stringify({ path: directory }) + "\n") !== "ok") throw new Error();
}
