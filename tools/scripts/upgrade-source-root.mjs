import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { BackupOperationError, resolveWorkspacePath } from "./backup-restore.mjs";

/** @param {{root:string, sourceRoot?:string, executingSourceRoot:string}} input */
export async function resolveUpgradeSourceRoot({ root, sourceRoot, executingSourceRoot }) {
  // Existing callers retain their original workspace boundary. An explicit
  // split keeps business backups at the operational root and binds migration
  // evidence to the exact snapshot executing this module.
  if (sourceRoot === undefined) return root;
  const requested = path.resolve(root, sourceRoot), operational = path.resolve(root);
  const selected = requested === operational ? operational : await resolveWorkspacePath(root, sourceRoot);
  const metadata = await fs.lstat(selected);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new BackupOperationError("upgrade_source_not_regular_directory");
  const normalize = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (normalize(selected) !== normalize(executingSourceRoot)) throw new BackupOperationError("upgrade_executing_source_mismatch");
  return selected;
}
