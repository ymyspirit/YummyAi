import { spawn } from "node:child_process";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { storeNodeDirectory } from "./config.js";
import { nodeCheck, StoreNodeError } from "./error.js";

function windowsPowerShell(): string {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  nodeCheck(process.platform === "win32" && root && path.isAbsolute(root) && !root.startsWith("\\\\"), "store_node_storage_unavailable");
  return path.join(root, "System32/WindowsPowerShell/v1.0/powershell.exe");
}
function systemEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}
const helper = [
  "$ErrorActionPreference='Stop';$lock=$null;$temporary=$null;$stage='initialize';$target='none'",
  "try{",
  " $p=[Console]::In.ReadLine()|ConvertFrom-Json;$directory=$p.path",
  " if(([IO.File]::GetAttributes($directory) -band [IO.FileAttributes]::ReparsePoint)){throw 'invalid'}",
  " $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$sections=[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner",
  " $stage='acl_read';$owner=[IO.Directory]::GetAccessControl($directory,$sections).GetOwner([Security.Principal.SecurityIdentifier])",
  " $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false)",
  " foreach($s in @($sid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}",
  " $stage='acl_apply';if($owner.Value -ne $sid.Value){$acl.SetOwner($sid);Set-Acl -LiteralPath $directory -AclObject $acl}else{[IO.Directory]::SetAccessControl($directory,$acl)}",
  " $stage='acl_verify';$verified=[IO.Directory]::GetAccessControl($directory,$sections);$rules=@($verified.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));$seen=@{}",
  " if(-not $verified.AreAccessRulesProtected -or $verified.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $rules.Count -ne 2){throw 'invalid'}",
  " foreach($rule in $rules){$id=$rule.IdentityReference.Value;if(($id -ne $sid.Value -and $id -ne 'S-1-5-18') -or $seen.ContainsKey($id) -or $rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl' -or $rule.InheritanceFlags -ne 'ContainerInherit,ObjectInherit' -or $rule.PropagationFlags -ne 'None'){throw 'invalid'};$seen[$id]=$true}",
  " $lockPath=Join-Path $directory 'node.lock';if([IO.File]::Exists($lockPath) -and ([IO.File]::GetAttributes($lockPath) -band [IO.FileAttributes]::ReparsePoint)){throw 'invalid'}",
  " $stage='acquire';$lock=[IO.File]::Open($lockPath,'OpenOrCreate','ReadWrite','None');[Console]::Out.WriteLine('locked');[Console]::Out.Flush();$stage='receive'",
  " while($null -ne ($line=[Console]::In.ReadLine())){",
  "  $stage='receive';$target='none';$request=$line|ConvertFrom-Json;if($request.operation -eq 'release'){break};if($request.operation -ne 'commit'){throw 'invalid'};$stage='validate'",
  "  if(([IO.File]::GetAttributes($directory) -band [IO.FileAttributes]::ReparsePoint)){throw 'invalid'}",
  "  $name='state.pe';$target='state';$maximum=100000;if($request.name -eq 'execution.pe'){$name='execution.pe';$target='journal';$maximum=67108864}elseif($null -ne $request.name -and $request.name -ne 'state.pe'){throw 'invalid'}",
  "  $destination=Join-Path $directory $name;if([IO.File]::Exists($destination) -and ([IO.File]::GetAttributes($destination) -band [IO.FileAttributes]::ReparsePoint)){throw 'invalid'}",
  "  $stage='decode';$bytes=[Convert]::FromBase64String($request.cipher);try{",
  "   if($bytes.Length -le 0 -or $bytes.Length -gt $maximum){throw 'invalid'}",
  "   $stage='create';$temporary=Join-Path $directory ('.state-'+[Guid]::NewGuid().ToString('N')+'.tmp');$stream=[IO.File]::Open($temporary,'CreateNew','Write','None')",
  "   try{$stage='write';$stream.Write($bytes,0,$bytes.Length);$stage='flush';$stream.Flush($true)}finally{$stream.Dispose()}",
  "   if([IO.File]::Exists($destination)){$stage='replace';[IO.File]::Replace($temporary,$destination,[NullString]::Value)}else{$stage='move';[IO.File]::Move($temporary,$destination)};$temporary=$null",
  "   $stage='ack';[Console]::Out.WriteLine('committed');[Console]::Out.Flush();$stage='receive';$target='none'",
  "  }finally{[Array]::Clear($bytes,0,$bytes.Length)}",
  " }",
  "}catch{$exception=$_.Exception;for($depth=0;$depth -lt 4 -and $null -ne $exception.InnerException;$depth++){$exception=$exception.InnerException};$type=$exception.GetType().Name;if($type -notin @('IOException','UnauthorizedAccessException','PrivilegeNotHeldException','ArgumentException','ArgumentNullException','PathTooLongException','NotSupportedException','SecurityException','InvalidOperationException','FormatException','OutOfMemoryException','MethodInvocationException','RuntimeException')){$type='Other'};[Console]::Error.WriteLine((@{code='store_node_storage_diagnostic';phase=$stage;target=$target;errorType=$type;hresult=[int]$exception.HResult}|ConvertTo-Json -Compress));[Console]::Error.WriteLine('store_node_storage_unavailable');exit 1}finally{if($null -ne $temporary -and [IO.File]::Exists($temporary)){[IO.File]::Delete($temporary)};if($null -ne $lock){$lock.Dispose()}}",
].join("\n");

export interface StoreNodeLocalLock { signal: AbortSignal; assertHeld(): void; commit(cipher: Uint8Array): Promise<void>; commitJournal(cipher: Uint8Array): Promise<void> }
/** The process owning FileShare.None also performs each ciphertext replacement.
 * Killing either process cannot leave a late Node rename capable of reviving identity. */
export async function withStoreNodeLock<T>(directory: string, action: (lock: StoreNodeLocalLock) => Promise<T>): Promise<T> {
  storeNodeDirectory(directory); await ensureDirectory(directory);
  const child = spawn(windowsPowerShell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", helper],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: systemEnvironment() });
  const abort = new AbortController();
  let locked = false, closed = false, failed = false, output = "", pending: { resolve(): void; reject(error: Error): void } | null = null;
  let resolveLocked: () => void, rejectLocked: (error: Error) => void;
  const acquired = new Promise<void>((resolve, reject) => { resolveLocked = resolve; rejectLocked = reject; });
  const timer = setTimeout(() => { failed = true; child.kill(); }, 10000);
  const completion = new Promise<void>((resolve, reject) => {
    child.once("error", () => { failed = true; });
    child.once("close", code => {
      closed = true; clearTimeout(timer); abort.abort();
      const error = new StoreNodeError("store_node_storage_unavailable");
      rejectLocked(error); pending?.reject(error); pending = null;
      if (code === 0 && !failed) resolve(); else reject(error);
    });
  });
  void completion.catch(() => undefined);
  let diagnosticBuffer = "", diagnosticForwarded = false;
  child.stderr.on("data", (bytes: Buffer) => {
    failed = true;
    if (diagnosticForwarded) return;
    diagnosticBuffer += bytes.toString("utf8");
    if (diagnosticBuffer.length > 2048) { diagnosticBuffer = ""; return; }
    let end: number;
    while ((end = diagnosticBuffer.indexOf("\n")) >= 0) {
      const line = diagnosticBuffer.slice(0, end).replace(/\r$/, ""); diagnosticBuffer = diagnosticBuffer.slice(end + 1);
      try {
        const raw: unknown = JSON.parse(line);
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const value = raw as Record<string, unknown>;
        if (Object.keys(value).sort().join(",") !== "code,errorType,hresult,phase,target" || value.code !== "store_node_storage_diagnostic"
          || !["initialize", "acl_read", "acl_apply", "acl_verify", "acquire", "receive", "validate", "decode", "create", "write", "flush", "replace", "move", "ack"].includes(value.phase as string)
          || !["none", "state", "journal"].includes(value.target as string)
          || !["IOException", "UnauthorizedAccessException", "PrivilegeNotHeldException", "ArgumentException", "ArgumentNullException", "PathTooLongException", "NotSupportedException", "SecurityException", "InvalidOperationException", "FormatException", "OutOfMemoryException", "MethodInvocationException", "RuntimeException", "Other"].includes(value.errorType as string)
          || typeof value.hresult !== "number" || !Number.isInteger(value.hresult) || value.hresult < -2147483648 || value.hresult > 2147483647) continue;
        process.stderr.write(JSON.stringify(value) + "\n"); diagnosticForwarded = true; break;
      } catch { /* Unrecognized child output is never forwarded. */ }
    }
  });
  child.stdin.on("error", () => { failed = true; });
  child.stdout.on("data", (bytes: Buffer) => {
    output += bytes.toString("ascii"); let index: number;
    while ((index = output.indexOf("\n")) >= 0) {
      const line = output.slice(0, index).replace(/\r$/, ""); output = output.slice(index + 1);
      if (line === "locked" && !locked) { locked = true; clearTimeout(timer); resolveLocked(); }
      else if (line === "committed" && pending) { const result = pending; pending = null; result.resolve(); }
      else { failed = true; child.kill(); }
    }
    if (output.length > 20) { failed = true; child.kill(); }
  });
  child.stdin.write(JSON.stringify({ path: directory }) + "\n");
  const assertHeld = () => nodeCheck(locked && !closed && !failed && !abort.signal.aborted, "store_node_storage_unavailable");
  let writes = Promise.resolve();
  const commit = (name: "state.pe" | "execution.pe", cipher: Uint8Array): Promise<void> => {
    const maximum = name === "state.pe" ? 100000 : 64 * 1024 * 1024;
    nodeCheck(cipher.byteLength > 0 && cipher.byteLength <= maximum, "store_node_storage_unavailable");
    const copy = Buffer.from(cipher);
    const action = writes.then(async () => {
      assertHeld(); nodeCheck(!pending, "store_node_storage_unavailable");
      const payload = Buffer.from(JSON.stringify({ operation: "commit", name, cipher: copy.toString("base64") }) + "\n");
      const acknowledgement = new Promise<void>((resolve, reject) => { pending = { resolve, reject }; });
      const deadline = setTimeout(() => { failed = true; child.kill(); }, 10000);
      try { child.stdin.write(payload); await acknowledgement; assertHeld(); }
      finally { clearTimeout(deadline); payload.fill(0); }
    }).finally(() => copy.fill(0));
    writes = action.catch(() => undefined); return action;
  };
  try {
    await acquired;
    return await action({ signal: abort.signal, assertHeld, commit: cipher => commit("state.pe", cipher), commitJournal: cipher => commit("execution.pe", cipher) });
  } finally {
    await writes;
    if (!closed) child.stdin.end(JSON.stringify({ operation: "release" }) + "\n");
    const shutdown = setTimeout(() => { failed = true; child.kill(); }, 5000);
    try { await completion; } finally { clearTimeout(shutdown); }
  }
}
export async function readStoreNodeJournal(directory: string): Promise<Buffer | null> {
  const filename = path.join(directory, "execution.pe");
  try { await noLinks(filename); const stat = await lstat(filename); nodeCheck(stat.isFile() && stat.size <= 64 * 1024 * 1024, "store_node_storage_unavailable");
    const bytes = await readFile(filename); nodeCheck(bytes.length <= 64 * 1024 * 1024, "store_node_storage_unavailable"); return bytes;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export async function ensureDirectory(directory: string): Promise<void> {
  storeNodeDirectory(directory); await noLinks(directory, true); await mkdir(directory, { recursive: true, mode: 0o700 }); await noLinks(directory);
}
export async function noLinks(target: string, allowMissing = false): Promise<void> {
  target = path.resolve(target);
  let current = path.parse(target).root;
  for (const segment of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try { const stat = await lstat(current); nodeCheck(!stat.isSymbolicLink(), "store_node_storage_unavailable"); }
    catch (error) { if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  }
}
export async function readStoreNodeFile(directory: string, name: "public-key.pem" | "private-key.pem" | "state.pe"): Promise<Buffer> {
  const filename = path.join(directory, name); await noLinks(filename);
  const stat = await lstat(filename); nodeCheck(stat.isFile() && stat.size <= 100000, "store_node_storage_unavailable");
  const bytes = await readFile(filename); nodeCheck(bytes.length <= 100000, "store_node_storage_unavailable"); return bytes;
}
export async function createStoreNodeFile(directory: string, name: "public-key.pem" | "private-key.pem", data: string): Promise<void> {
  await noLinks(directory); const file = await open(path.join(directory, name), "wx", 0o600);
  try { await file.writeFile(data, "utf8"); await file.sync(); } finally { await file.close(); }
}
