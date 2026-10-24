import { cp, mkdir, rm, symlink, access, writeFile } from "node:fs/promises";
import { resolve, join, sep, basename } from "node:path";
import { fileURLToPath } from "node:url";

type BrowserSandboxPurpose = "knowledge" | "workflow-operator" | "research-media" | "factory-portal";
function sandboxPath(token: string, purpose: BrowserSandboxPurpose) {
  if (!/^[a-f0-9]{32}$/.test(token)) throw new Error("Invalid knowledge sandbox identity");
  if (!["knowledge", "workflow-operator", "research-media", "factory-portal"].includes(purpose))
    throw new Error("Invalid browser sandbox configuration");
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const scratch = resolve(repo, "tmp"),
    root = resolve(scratch, purpose + "-web-" + token);
  if (!root.startsWith(scratch + sep) || basename(root) !== purpose + "-web-" + token)
    throw new Error("Knowledge sandbox escaped its scratch directory");
  return { repo, root };
}

/** Resume only a specifically identified owned snapshot, including after interruption. */
export async function cleanupKnowledgeBrowserSandbox(
  token: string,
  purpose: BrowserSandboxPurpose = "knowledge",
) {
  const { root } = sandboxPath(token, purpose);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  try {
    await access(root);
    throw new Error("Knowledge browser sandbox retained");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Snapshot current Web sources with an independent Next cache/lock.
 * Dependencies/contracts are shared read-only; no environment files are copied. */
export async function createKnowledgeBrowserSandbox(
  token: string,
  port = 3122,
  purpose: BrowserSandboxPurpose = "knowledge",
) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid browser sandbox configuration");
  const { repo, root } = sandboxPath(token, purpose),
    web = join(root, "apps", "web");
  const cleanup = () => cleanupKnowledgeBrowserSandbox(token, purpose);
  try {
    await mkdir(web, { recursive: true });
    await cp(join(repo, "apps", "web", "src"), join(web, "src"), { recursive: true });
    for (const file of [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.base.json",
    ])
      await cp(join(repo, file), join(root, file));
    for (const file of ["package.json", "tsconfig.json", "next-env.d.ts"])
      await cp(join(repo, "apps", "web", file), join(web, file));
    await symlink(join(repo, "node_modules"), join(root, "node_modules"), "junction");
    await symlink(join(repo, "packages"), join(root, "packages"), "junction");
    await symlink(join(repo, "apps", "web", "node_modules"), join(web, "node_modules"), "junction");
    await symlink(join(repo, "apps", "web", "public"), join(web, "public"), "junction");
    const config = join(repo, "apps", "web", "next.config.ts").replaceAll("\\", "/");
    await writeFile(
      join(web, "next.config.ts"),
      "import original from " +
        JSON.stringify(config) +
        ";\nexport default {...original,experimental:{...original.experimental,turbopackFileSystemCacheForDev:false},turbopack:{...original.turbopack,root:" +
        JSON.stringify(repo) +
        "}};\n",
    );
    const nextCli = join(repo, "apps", "web", "node_modules", "next", "dist", "bin", "next");
    return {
      cwd: web,
      command: '"' + process.execPath + '" "' + nextCli + '" dev --hostname 127.0.0.1 --port ' + port,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
