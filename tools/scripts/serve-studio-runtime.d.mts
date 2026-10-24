import type { Server } from "node:http";
export interface StudioRuntimeManifest {
  readonly schemaVersion: 1;
  readonly kind: "yummyai-studio-runtime";
  readonly id: string;
  readonly sourceStamp: string;
  readonly upstream: Readonly<{ tag: string; commit: string; adapterVersion: string; lockSha256: string }>;
  readonly files: readonly Readonly<{ path: string; bytes: number; sha256: string }>[];
}
export interface StudioRuntimeDescriptor {
  id: string;
  directory: string;
  manifestPath: string;
  manifest: StudioRuntimeManifest;
}
export function studioRuntimeManifestId(core: Omit<StudioRuntimeManifest, "id">): string;
export function studioRuntimePath(target: string, kind: "directory" | "file"): Promise<string>;
export function readStudioRuntimeFile(target: string, maxBytes?: number): Promise<Buffer>;
export function studioRuntimeInventory(directory: string, prefix?: string): Promise<Array<{ path: string; bytes: number; sha256: string }>>;
export function verifyStudioRuntime(manifestPath: string): Promise<StudioRuntimeDescriptor>;
export function startSealedStudioRuntime(options: { manifestPath: string; host?: "127.0.0.1" | "0.0.0.0"; port: number; parentOrigins: string[] }): Promise<Server>;
