import type { Stats } from "node:fs";
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import type { VerifiedStudioTransferBrowserLock } from "./require-studio-document-transfer-browser-lock.mjs";
export const P2_CI_BROWSER_REGISTRY_SHA256: string;
export const P2_CI_DRIVER_REGISTRY_SHA256: string;
export type P2CiBrowserFileSystem = {
  lstatSync(path: string): Stats; realpathSync(path: string): string; openSync(path: string, flags: "r"): number;
  fstatSync(fd: number): Stats; readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: null): number;
  closeSync(fd: number): void;
};
export type VerifiedP2CiBrowserLock = Readonly<{
  executablePath: string; executableSha256: string; executableBytes: number; browserVersion: string; revision: string; registrySha256: string;
  metadata: Readonly<{ family: "p2_linux_ci_official_headless_shell_v2"; platform: "linux-x64"; driverVersion: string;
    sourcePackageVersion: string; sourcePackageIntegrity: string; sourcePackageGitHead: string; driverRegistrySha256: string; registrySha256: string; browserName: "chromium-headless-shell";
    browserVersion: string; revision: string; cacheKind: "os_account_default"; executablePath: string; executableSha256: string;
    executableBytes: number; executableVersionOutput: string; binaryDigestKind: "pinned_official_archive_v2" }>;
}>;
export function createP2CiBrowserLockGuard(input: {
  filesystem: P2CiBrowserFileSystem; platform: string; architecture: string; userHome: string;
  driverPackagePath: string; playwrightPackagePath: string; corePackagePath: string; sourcePackagePath: string;
  expectedExecutableSha256?: string; expectedExecutableBytes?: number;
  probeVersion(path: string, args: string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string>;
}): (environment?: NodeJS.ProcessEnv) => VerifiedP2CiBrowserLock;
export function requireP2BrowserLock(environment?: NodeJS.ProcessEnv): VerifiedP2CiBrowserLock | VerifiedStudioTransferBrowserLock;
export function p2PinnedBrowserUse<T extends Record<string, unknown>>(selection: VerifiedP2CiBrowserLock | VerifiedStudioTransferBrowserLock, inheritedUse?: T):
  T & { browserName: "chromium"; headless: true; channel: undefined; connectOptions: undefined; launchOptions: { executablePath: string } };
