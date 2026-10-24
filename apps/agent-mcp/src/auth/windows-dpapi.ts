import { spawn } from "node:child_process";
import path from "node:path";
import { AgentMcpAuthError, authCheck } from "./error.js";

export interface AgentMcpDataProtection {
  protect(plain: Uint8Array, entropy: Uint8Array): Promise<Uint8Array>;
  unprotect(cipher: Uint8Array, entropy: Uint8Array): Promise<Uint8Array>;
}

function executable(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  authCheck(process.platform === "win32" && systemRoot && path.isAbsolute(systemRoot) &&
    !systemRoot.startsWith("\\\\"), "mcp_auth_storage_unavailable");
  return path.join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
}
function systemEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  // Keep the Windows profile/browser functional without forwarding ERP, model,
  // database, object-storage, or other application credentials.
  for (const name of ["SystemRoot", "WINDIR", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
    "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "ProgramFiles", "ProgramFiles(x86)", "PATH"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  environment.SystemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  return environment;
}

const helper = [
  "$ErrorActionPreference='Stop'",
  "try {",
  " Add-Type -AssemblyName System.Security",
  " $p=[Console]::In.ReadLine() | ConvertFrom-Json",
  " if($p.operation -eq 'open') {",
  "  Start-Process -FilePath $p.url -ErrorAction Stop",
  "  [Console]::Out.Write('ok')",
  " } elseif($p.operation -eq 'secure') {",
  "  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User",
  "  $sections=[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner",
  "  $current=[IO.Directory]::GetAccessControl($p.path,$sections)",
  "  $owner=$current.GetOwner([Security.Principal.SecurityIdentifier])",
  "  $acl=[Security.AccessControl.DirectorySecurity]::new()",
  "  $acl.SetAccessRuleProtection($true,$false)",
  "  foreach($s in @($sid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {",
  "   $r=[Security.AccessControl.FileSystemAccessRule]::new($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow')",
  "   $acl.AddAccessRule($r)",
  "  }",
  "  if($owner.Value -ne $sid.Value) {",
  "   $acl.SetOwner($sid); Set-Acl -LiteralPath $p.path -AclObject $acl",
  "  } else {",
  "   [IO.Directory]::SetAccessControl($p.path,$acl)",
  "  }",
  "  $verified=[IO.Directory]::GetAccessControl($p.path,$sections)",
  "  if(-not $verified.AreAccessRulesProtected -or $verified.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'invalid'}",
  "  $rules=@($verified.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))",
  "  if($rules.Count -ne 2){throw 'invalid'}",
  "  $seen=@{}",
  "  foreach($rule in $rules) {",
  "   $identity=$rule.IdentityReference.Value",
  "   if(($identity -ne $sid.Value -and $identity -ne 'S-1-5-18') -or $seen.ContainsKey($identity) -or $rule.IsInherited -or",
  "    $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or",
  "    $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or",
  "    $rule.InheritanceFlags -ne ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit) -or",
  "    $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None){throw 'invalid'}",
  "   $seen[$identity]=$true",
  "  }",
  "  [Console]::Out.Write('ok')",
  " } else {",
  "  $bytes=[Convert]::FromBase64String($p.data); $entropy=[Convert]::FromBase64String($p.entropy)",
  "  try {",
  "   if($p.operation -eq 'protect') { $result=[Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,'CurrentUser') }",
  "   elseif($p.operation -eq 'unprotect') { $result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,'CurrentUser') }",
  "   else { throw 'invalid' }",
  "   try { [Console]::Out.Write([Convert]::ToBase64String($result)) } finally { [Array]::Clear($result,0,$result.Length) }",
  "  } finally { [Array]::Clear($bytes,0,$bytes.Length); [Array]::Clear($entropy,0,$entropy.Length) }",
  " }",
  "} catch { [Console]::Error.Write('mcp_auth_storage_unavailable'); exit 1 }",
].join("\n");

async function runHelper(payload: unknown): Promise<Buffer> {
  const input = Buffer.from(JSON.stringify(payload) + "\n");
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(executable(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", helper],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: systemEnvironment() });
      const chunks: Buffer[] = [];
      let length = 0, failed = false;
      const timer = setTimeout(() => { failed = true; child.kill(); }, 10_000);
      child.stdout.on("data", (chunk: Buffer) => {
        length += chunk.byteLength;
        if (length > 2 * 1024 * 1024) { failed = true; child.kill(); }
        else chunks.push(chunk);
      });
      child.stderr.on("data", () => { failed = true; });
      child.stdin.on("error", () => { failed = true; });
      child.once("error", () => { failed = true; });
      child.once("close", code => {
        clearTimeout(timer);
        const result = Buffer.concat(chunks); for (const chunk of chunks) chunk.fill(0);
        if (failed || code !== 0) { result.fill(0); reject(new AgentMcpAuthError("mcp_auth_storage_unavailable")); }
        else resolve(result);
      });
      child.stdin.end(input);
    });
  } finally { input.fill(0); }
}

export class WindowsAgentMcpDataProtection implements AgentMcpDataProtection {
  private async transform(operation: "protect" | "unprotect", data: Uint8Array, entropy: Uint8Array) {
    authCheck(data.byteLength > 0 && data.byteLength <= 256 * 1024 && entropy.byteLength <= 1024,
      "mcp_auth_storage_unavailable");
    const result = await runHelper({ operation, data: Buffer.from(data).toString("base64"),
      entropy: Buffer.from(entropy).toString("base64") });
    try {
      const encoded = result.toString("ascii");
      authCheck(encoded.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded), "mcp_auth_storage_unavailable");
      const decoded = Buffer.from(encoded, "base64");
      authCheck(decoded.byteLength > 0 && decoded.byteLength <= 256 * 1024 &&
        decoded.toString("base64") === encoded, "mcp_auth_storage_unavailable");
      return decoded;
    } finally { result.fill(0); }
  }
  protect(plain: Uint8Array, entropy: Uint8Array) { return this.transform("protect", plain, entropy); }
  unprotect(cipher: Uint8Array, entropy: Uint8Array) { return this.transform("unprotect", cipher, entropy); }
}

export async function secureAgentMcpAuthDirectory(directory: string): Promise<void> {
  const result = await runHelper({ operation: "secure", path: directory });
  try { authCheck(result.toString("ascii") === "ok", "mcp_auth_storage_unavailable"); }
  finally { result.fill(0); }
}

/** Called only by the explicit login command; the URL is passed through stdin. */
export async function openAgentMcpAuthorizationUrl(url: URL): Promise<void> {
  const result = await runHelper({ operation: "open", url: url.href });
  try { authCheck(result.toString("ascii") === "ok", "mcp_auth_login_failed"); }
  finally { result.fill(0); }
}

const lockHelper = [
  "$ErrorActionPreference='Stop'; $file=$null; $temporary=$null",
  "try {",
  " $p=[Console]::In.ReadLine() | ConvertFrom-Json",
  " if([IO.Path]::GetFileName($p.path) -ne 'credential.lock'){throw 'invalid'}",
  " $until=[DateTime]::UtcNow.AddSeconds(10)",
  " while($null -eq $file) {",
  "  try { $file=[IO.File]::Open($p.path,'OpenOrCreate','ReadWrite','None') }",
  "  catch [IO.IOException] { if([DateTime]::UtcNow -ge $until){throw 'busy'}; Start-Sleep -Milliseconds 25 }",
  " }",
  " [Console]::Out.WriteLine('locked'); [Console]::Out.Flush()",
  " $request=[Console]::In.ReadLine() | ConvertFrom-Json",
  " if($request.operation -eq 'commit') {",
  "  $directory=[IO.Path]::GetDirectoryName($p.path)",
  "  if(([IO.File]::GetAttributes($directory) -band [IO.FileAttributes]::ReparsePoint)){throw 'invalid'}",
  "  $destination=Join-Path $directory 'credential.bin'",
  "  if([IO.File]::Exists($destination) -and ([IO.File]::GetAttributes($destination) -band [IO.FileAttributes]::ReparsePoint)){throw 'invalid'}",
  "  $cipher=[Convert]::FromBase64String($request.cipher)",
  "  try {",
  "   if($cipher.Length -le 0 -or $cipher.Length -gt 262144){throw 'invalid'}",
  "   $temporary=Join-Path $directory ('.credential-'+[Guid]::NewGuid().ToString('N')+'.tmp')",
  "   $output=[IO.File]::Open($temporary,'CreateNew','Write','None')",
  "   try { $output.Write($cipher,0,$cipher.Length); $output.Flush($true) } finally { $output.Dispose() }",
  "   if([IO.File]::Exists($destination)){[IO.File]::Replace($temporary,$destination,[NullString]::Value)}else{[IO.File]::Move($temporary,$destination)}",
  "   $temporary=$null",
  "   [Console]::Out.WriteLine('committed'); [Console]::Out.Flush()",
  "  } finally { [Array]::Clear($cipher,0,$cipher.Length) }",
  " } elseif($request.operation -ne 'release'){throw 'invalid'}",
  "} catch { [Console]::Error.Write('mcp_auth_storage_unavailable'); exit 1 }",
  "finally { if($null -ne $temporary -and [IO.File]::Exists($temporary)){[IO.File]::Delete($temporary)}; if($null -ne $file){$file.Dispose()} }",
].join("\n");

/** The same process holds the OS lock and performs the atomic ciphertext commit.
 * If that process dies, a late Node action cannot write or revive a credential. */
export async function withAgentMcpCredentialLock<T>(
  filename: string, action: (commit: (cipher: Uint8Array) => Promise<void>) => Promise<T>,
): Promise<T> {
  const child = spawn(executable(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", lockHelper],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: systemEnvironment() });
  let locked = false, failed = false, closed = false, commitAttempted = false, committed = false;
  const lifetime = setTimeout(() => { failed = true; child.kill(); }, 45_000);
  const completion = new Promise<void>((resolve, reject) => {
    child.once("close", code => {
      closed = true; clearTimeout(lifetime);
      if (code === 0 && !failed && (!commitAttempted || committed)) resolve();
      else reject(new AgentMcpAuthError("mcp_auth_storage_unavailable"));
    });
  });
  void completion.catch(() => {});
  const acquired = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { failed = true; child.kill(); reject(new AgentMcpAuthError("mcp_auth_storage_unavailable")); }, 12_000);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("ascii");
      let newline = output.indexOf("\n");
      while (newline >= 0) {
        const line = output.slice(0, newline).replace(/\r$/, ""); output = output.slice(newline + 1);
        if (line === "locked" && !locked) { clearTimeout(timer); locked = true; resolve(); }
        else if (line === "committed" && locked && commitAttempted && !committed) committed = true;
        else { failed = true; child.kill(); }
        newline = output.indexOf("\n");
      }
      if (output.length > 16) { failed = true; child.kill(); }
    });
    child.once("error", () => { failed = true; clearTimeout(timer); reject(new AgentMcpAuthError("mcp_auth_storage_unavailable")); });
    child.once("close", () => { clearTimeout(timer); if (!locked) reject(new AgentMcpAuthError("mcp_auth_storage_unavailable")); });
    child.stderr.on("data", () => { failed = true; });
    child.stdin.on("error", () => { failed = true; });
  });
  child.stdin.write(JSON.stringify({ path: filename }) + "\n");
  try {
    await acquired;
    return await action(async cipher => {
      authCheck(!commitAttempted && !closed && locked && !failed && cipher.byteLength > 0 &&
        cipher.byteLength <= 256 * 1024, "mcp_auth_storage_unavailable");
      commitAttempted = true;
      const input = Buffer.from(JSON.stringify({ operation: "commit", cipher: Buffer.from(cipher).toString("base64") }) + "\n");
      try { child.stdin.end(input); await completion; }
      finally { input.fill(0); }
    });
  } finally {
    if (!commitAttempted && !closed) child.stdin.end(JSON.stringify({ operation: "release" }) + "\n");
    if (!locked && !closed) child.kill();
    await completion;
  }
}
