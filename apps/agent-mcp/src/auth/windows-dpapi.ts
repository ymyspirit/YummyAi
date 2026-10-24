import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
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

const nativePhases = ["initialize", "import_util", "import_mgmt", "import_sec", "add_type", "stdin_wait", "json_parse", "identity",
  "acl_read", "acl_apply", "acl_verify", "open_browser", "protect", "unprotect", "lock_wait", "lock_held", "commit_wait",
  "commit_parse", "commit_write", "commit_ack", "release"] as const;
type NativeState = { resultStarted?: boolean; invalidFrame?: boolean; locked?: boolean; commitAttempted?: boolean; committed?: boolean };

function observeNative(child: ChildProcess, kind: "helper" | "lock", markFailed: () => void) {
  const startedAt = performance.now();
  let phase: typeof nativePhases[number] | "unobserved" = "unobserved", frames = 0;
  let deadline: "helper" | "acquire" | "lifetime" | null = null;
  let spawned = false, stdinFailed = false, stderrBytes = 0, stderrTruncated = false;
  let spawnError: "ENOENT" | "EACCES" | "EPERM" | "other" | null = null;
  child.once("spawn", () => { spawned = true; });
  child.once("error", (cause: NodeJS.ErrnoException) => {
    markFailed();
    spawnError = cause.code === "ENOENT" || cause.code === "EACCES" || cause.code === "EPERM" ? cause.code : "other";
  });
  child.stderr?.on("data", (bytes: Buffer) => {
    markFailed(); // No stderr frame, including diagnostic-looking text, can grant success.
    stderrTruncated ||= stderrBytes + bytes.length > 65_536;
    stderrBytes = Math.min(65_536, stderrBytes + bytes.length);
  });
  child.stdin?.on("error", () => { markFailed(); stdinFailed = true; });
  return {
    phase(line: string): boolean {
      const selected = nativePhases.find(value => line === `p:${value}`);
      if (!selected || frames >= 32) return false;
      frames++; phase = selected; return true;
    },
    result(): boolean { if (frames >= 32) return false; frames++; return true; },
    timeout(value: "helper" | "acquire" | "lifetime") { deadline = value; },
    failure(exitCode: number | null, signal: NodeJS.Signals | null, state: NativeState = {}) {
      const error = new AgentMcpAuthError("mcp_auth_storage_unavailable");
      error.cause = Object.freeze({ code: "mcp_auth_native_lifecycle", helper: kind, nativePhase: phase, deadlinePhase: deadline,
        elapsedMs: Math.round(performance.now() - startedAt), spawned, spawnError, stdinFailed, stderrBytes, stderrTruncated,
        resultStarted: state.resultStarted === true, invalidFrame: state.invalidFrame === true, locked: state.locked === true,
        commitAttempted: state.commitAttempted === true, committed: state.committed === true,
        exitCode, exitSignal: signal === "SIGTERM" || signal === "SIGKILL" ? signal : signal ? "other" : null });
      process.stderr.write(JSON.stringify(error.cause) + "\n");
      return error;
    },
  };
}

const nativePrelude = [
  "$ErrorActionPreference='Stop'",
  "function Write-AuthPhase([string]$value){[Console]::Out.WriteLine('p:'+$value);[Console]::Out.Flush()}",
  "Write-AuthPhase 'initialize'",
];
const systemModuleImports = [
  " Write-AuthPhase 'import_util';Microsoft.PowerShell.Core\\Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop",
  " Write-AuthPhase 'import_mgmt';Microsoft.PowerShell.Core\\Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Management','Microsoft.PowerShell.Management.psd1')) -ErrorAction Stop",
  " Write-AuthPhase 'import_sec';Microsoft.PowerShell.Core\\Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Security','Microsoft.PowerShell.Security.psd1')) -ErrorAction Stop",
];

const helper = [
  ...nativePrelude,
  "try {",
  ...systemModuleImports,
  " Write-AuthPhase 'add_type';Microsoft.PowerShell.Utility\\Add-Type -AssemblyName System.Security",
  " Write-AuthPhase 'stdin_wait';$raw=[Console]::In.ReadLine();Write-AuthPhase 'json_parse';$p=$raw | Microsoft.PowerShell.Utility\\ConvertFrom-Json",
  " if($p.operation -eq 'open') {",
  "  Write-AuthPhase 'open_browser';Microsoft.PowerShell.Management\\Start-Process -FilePath $p.url -ErrorAction Stop",
  "  Write-AuthPhase 'result';[Console]::Out.Write('ok')",
  " } elseif($p.operation -eq 'secure') {",
  "  Write-AuthPhase 'identity';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User",
  "  $sections=[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner",
  "  Write-AuthPhase 'acl_read';$current=[IO.Directory]::GetAccessControl($p.path,$sections)",
  "  $owner=$current.GetOwner([Security.Principal.SecurityIdentifier])",
  "  $acl=[Security.AccessControl.DirectorySecurity]::new()",
  "  $acl.SetAccessRuleProtection($true,$false)",
  "  foreach($s in @($sid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {",
  "   $r=[Security.AccessControl.FileSystemAccessRule]::new($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow')",
  "   $acl.AddAccessRule($r)",
  "  }",
  "  Write-AuthPhase 'acl_apply';if($owner.Value -ne $sid.Value) {",
  "   $acl.SetOwner($sid); Microsoft.PowerShell.Security\\Set-Acl -LiteralPath $p.path -AclObject $acl",
  "  } else {",
  "   [IO.Directory]::SetAccessControl($p.path,$acl)",
  "  }",
  "  Write-AuthPhase 'acl_verify';$verified=[IO.Directory]::GetAccessControl($p.path,$sections)",
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
  "  Write-AuthPhase 'result';[Console]::Out.Write('ok')",
  " } else {",
  "  $bytes=[Convert]::FromBase64String($p.data); $entropy=[Convert]::FromBase64String($p.entropy)",
  "  try {",
  "   if($p.operation -eq 'protect') { Write-AuthPhase 'protect';$result=[Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,'CurrentUser') }",
  "   elseif($p.operation -eq 'unprotect') { Write-AuthPhase 'unprotect';$result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,'CurrentUser') }",
  "   else { throw 'invalid' }",
  "   try { Write-AuthPhase 'result';[Console]::Out.Write([Convert]::ToBase64String($result)) } finally { [Array]::Clear($result,0,$result.Length) }",
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
      let length = 0, failed = false, resultStarted = false, invalidFrame = false, frame = "";
      const observed = observeNative(child, "helper", () => { failed = true; });
      const rejectFrame = () => { invalidFrame = true; failed = true; child.kill(); };
      const timer = setTimeout(() => { observed.timeout("helper"); failed = true; child.kill(); }, 10_000);
      child.stdout.on("data", (chunk: Buffer) => {
        if (failed) { chunk.fill(0); return; }
        let offset = 0;
        // Only fixed short lines may precede the result. Never decode result bytes as diagnostic text.
        while (!resultStarted && offset < chunk.byteLength) {
          const byte = chunk[offset++]!;
          if (byte === 10) {
            const line = frame.replace(/\r$/, ""); frame = "";
            if (line === "p:result") {
              if (!observed.result()) { rejectFrame(); break; }
              resultStarted = true;
            } else if (!observed.phase(line)) { rejectFrame(); break; }
          } else {
            if (byte !== 13 && (byte < 32 || byte > 126)) { rejectFrame(); break; }
            frame += String.fromCharCode(byte);
            if (frame.length > 16) { rejectFrame(); break; }
          }
        }
        if (failed) { chunk.fill(0); return; }
        if (resultStarted && offset < chunk.byteLength) {
          const body = chunk.subarray(offset);
          length += body.byteLength;
          if (length > 2 * 1024 * 1024) { chunk.fill(0); failed = true; child.kill(); }
          else chunks.push(body);
        } else chunk.fill(0);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        const result = Buffer.concat(chunks); for (const chunk of chunks) chunk.fill(0);
        if (!resultStarted || frame) invalidFrame = true;
        if (failed || code !== 0 || !resultStarted || frame) {
          result.fill(0); reject(observed.failure(code, signal, { resultStarted, invalidFrame }));
        }
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
  ...nativePrelude,
  "$file=$null; $temporary=$null",
  "try {",
  ...systemModuleImports,
  " Write-AuthPhase 'stdin_wait';$raw=[Console]::In.ReadLine();Write-AuthPhase 'json_parse';$p=$raw | Microsoft.PowerShell.Utility\\ConvertFrom-Json",
  " if([IO.Path]::GetFileName($p.path) -ne 'credential.lock'){throw 'invalid'}",
  " Write-AuthPhase 'lock_wait';$until=[DateTime]::UtcNow.AddSeconds(10)",
  " while($null -eq $file) {",
  "  try { $file=[IO.File]::Open($p.path,'OpenOrCreate','ReadWrite','None') }",
  "  catch [IO.IOException] { if([DateTime]::UtcNow -ge $until){throw 'busy'}; Microsoft.PowerShell.Utility\\Start-Sleep -Milliseconds 25 }",
  " }",
  " Write-AuthPhase 'lock_held';[Console]::Out.WriteLine('locked'); [Console]::Out.Flush()",
  " Write-AuthPhase 'commit_wait';$raw=[Console]::In.ReadLine();Write-AuthPhase 'commit_parse';$request=$raw | Microsoft.PowerShell.Utility\\ConvertFrom-Json",
  " if($request.operation -eq 'commit') {",
  "  Write-AuthPhase 'commit_write';$directory=[IO.Path]::GetDirectoryName($p.path)",
  "  if(([IO.File]::GetAttributes($directory) -band [IO.FileAttributes]::ReparsePoint)){throw 'invalid'}",
  "  $destination=Microsoft.PowerShell.Management\\Join-Path $directory 'credential.bin'",
  "  if([IO.File]::Exists($destination) -and ([IO.File]::GetAttributes($destination) -band [IO.FileAttributes]::ReparsePoint)){throw 'invalid'}",
  "  $cipher=[Convert]::FromBase64String($request.cipher)",
  "  try {",
  "   if($cipher.Length -le 0 -or $cipher.Length -gt 262144){throw 'invalid'}",
  "   $temporary=Microsoft.PowerShell.Management\\Join-Path $directory ('.credential-'+[Guid]::NewGuid().ToString('N')+'.tmp')",
  "   $output=[IO.File]::Open($temporary,'CreateNew','Write','None')",
  "   try { $output.Write($cipher,0,$cipher.Length); $output.Flush($true) } finally { $output.Dispose() }",
  "   if([IO.File]::Exists($destination)){[IO.File]::Replace($temporary,$destination,[NullString]::Value)}else{[IO.File]::Move($temporary,$destination)}",
  "   $temporary=$null",
  "   Write-AuthPhase 'commit_ack';[Console]::Out.WriteLine('committed'); [Console]::Out.Flush()",
  "  } finally { [Array]::Clear($cipher,0,$cipher.Length) }",
  " } elseif($request.operation -ne 'release'){throw 'invalid'}else{Write-AuthPhase 'release'}",
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
  let locked = false, failed = false, closed = false, commitAttempted = false, committed = false, invalidFrame = false, output = "";
  const observed = observeNative(child, "lock", () => { failed = true; });
  const lifetime = setTimeout(() => { observed.timeout("lifetime"); failed = true; child.kill(); }, 45_000);
  const completion = new Promise<void>((resolve, reject) => {
    child.once("close", (code, signal) => {
      closed = true; clearTimeout(lifetime);
      if (output) { failed = true; invalidFrame = true; }
      if (code === 0 && !failed && (!commitAttempted || committed)) resolve();
      else reject(observed.failure(code, signal, { invalidFrame, locked, commitAttempted, committed }));
    });
  });
  void completion.catch(() => {});
  const acquired = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { observed.timeout("acquire"); failed = true; child.kill(); reject(new AgentMcpAuthError("mcp_auth_storage_unavailable")); }, 12_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.some(byte => byte !== 10 && byte !== 13 && (byte < 32 || byte > 126))) {
        invalidFrame = true; failed = true; child.kill(); return;
      }
      output += chunk.toString("ascii");
      let newline = output.indexOf("\n");
      while (newline >= 0) {
        const line = output.slice(0, newline).replace(/\r$/, ""); output = output.slice(newline + 1);
        if (observed.phase(line)) { /* Fixed control metadata cannot acquire or commit the lock. */ }
        else if (line === "locked" && !locked) { clearTimeout(timer); locked = true; resolve(); }
        else if (line === "committed" && locked && commitAttempted && !committed) committed = true;
        else { invalidFrame = true; failed = true; child.kill(); }
        newline = output.indexOf("\n");
      }
      if (output.length > 16) { invalidFrame = true; failed = true; child.kill(); }
    });
    child.once("error", () => { failed = true; clearTimeout(timer); reject(new AgentMcpAuthError("mcp_auth_storage_unavailable")); });
    child.once("close", () => { clearTimeout(timer); if (!locked) reject(new AgentMcpAuthError("mcp_auth_storage_unavailable")); });
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
