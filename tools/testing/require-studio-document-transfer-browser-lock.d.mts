import type { Stats } from "node:fs";

export const STUDIO_DOCUMENT_TRANSFER_BROWSER_LOCK_SHA256: string;
export type StudioTransferBrowserLockFileSystem = {
  lstatSync(path: string): Stats;
  realpathSync(path: string): string;
  readdirSync(path: string): string[];
  openSync(path: string, flags: "r"): number;
  fstatSync(fd: number): Stats;
  readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: null): number;
  closeSync(fd: number): void;
};
export type VerifiedStudioTransferBrowserLock = Readonly<{
  executablePath: string; executableSha256: string; executableBytes: number; browserVersion: string; revision: string; lockSha256: string;
  metadata: Readonly<{
    family: string; lockSha256: string; driverVersion: string; sourcePackageVersion: string; sourcePackageGitHead: string;
    sourcePackageIntegrity: string; registrySha256: string; browserName: string; browserVersion: string; revision: string;
    payloadReceiptSha256: string; payloadFiles: number; payloadBytes: number; executablePath: string; executableSha256: string; executableBytes: number;
  }>;
}>;
export function createStudioDocumentTransferBrowserLockGuard(input: {
  filesystem: StudioTransferBrowserLockFileSystem; workspaceRoot: string; expectedLockSha256: string; driverVersion: string;
}): (environment?: NodeJS.ProcessEnv) => VerifiedStudioTransferBrowserLock;
export function requireStudioDocumentTransferBrowserLock(environment?: NodeJS.ProcessEnv): VerifiedStudioTransferBrowserLock;
export function studioDocumentTransferPinnedBrowserUse<T extends Record<string, unknown>>(selection: VerifiedStudioTransferBrowserLock, inheritedUse?: T):
  T & { browserName: "chromium"; headless: true; channel: undefined; connectOptions: undefined; launchOptions: { executablePath: string } };
