import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const legacyRoot = resolve(root, "tmp/store-node-identity-20261022-c7e3a6d2/old178-source");
const checkpoint = resolve(root, "docs/project-control/checkpoints/2026-10-22-store-node-identity-c7e3a6d2");
/** Pure filesystem preflight. Never imports current contracts, database or a current service. */
export async function assertStoreNodeOriginal178Graph(candidate: string) {
  if (resolve(candidate) !== legacyRoot) throw new Error("store_node_original178_root_invalid");
  const source = JSON.parse(await readFile(checkpoint + "-source-before.json", "utf8")) as { sha256: string; files: Array<{ path: string; sha256: string }> };
  const graph = JSON.parse(await readFile(checkpoint + "-old178-source.json", "utf8")) as { operation: string; sourceRoot: string; sourceFiles: number; sourceSha256: string;
    workspaceDependenciesPinned: boolean; links: Array<{ path: string; target: string }> };
  if (graph.operation !== "c7e3a6d2" || graph.sourceFiles !== 3487 || source.files.length !== 3487 || graph.links.length !== 392 || !graph.workspaceDependenciesPinned ||
    resolve(graph.sourceRoot) !== legacyRoot || source.sha256 !== "0062ec425007d9cd75759df1fa43f406ba77f4746532e93a107b4dd907afac5c" || graph.sourceSha256 !== source.sha256)
    throw new Error("store_node_original178_manifest_invalid");
  for (const file of source.files) { const path = resolve(candidate, file.path), rel = relative(candidate, path);
    if (rel.startsWith("..") || isAbsolute(rel) || createHash("sha256").update(await readFile(path)).digest("hex") !== file.sha256) throw new Error("store_node_original178_bytes_changed"); }
  for (const link of graph.links) if (await realpath(link.path) !== await realpath(link.target)) throw new Error("store_node_original178_dependency_changed");
  for (const name of ["contracts", "database", "authz", "marketplace-connectors"])
    if (await realpath(resolve(candidate, "apps/api/node_modules/@yummyai", name)) !== await realpath(resolve(candidate, "packages", name))) throw new Error("store_node_original178_workspace_escaped");
  const contract = JSON.parse(await readFile(resolve(candidate, "packages/contracts/package.json"), "utf8")) as { exports: Record<string, unknown> };
  if (contract.exports["./marketplace/store-node"]) throw new Error("store_node_new_export_reachable_from_original178");
  const journal = JSON.parse(await readFile(resolve(candidate, "packages/database/migrations/meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  if (journal.entries.length !== 178 || !journal.entries.at(-1)?.tag.startsWith("0178_")) throw new Error("store_node_original178_journal_changed");
}
