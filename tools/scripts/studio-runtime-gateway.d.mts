import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface StudioRuntimeGatewayOptions {
  readonly upstreamHost: "yummyai-studio-runtime" | "127.0.0.1" | "::1";
  readonly upstreamPort: number;
  readonly host?: "127.0.0.1" | "::1" | "0.0.0.0";
  readonly port?: number;
  readonly bundleId: string;
}
export interface StudioRuntimeGateway {
  readonly server: Server;
  address(): AddressInfo | null;
  close(): Promise<void>;
}
export function createStudioRuntimeGateway(options: StudioRuntimeGatewayOptions): Promise<StudioRuntimeGateway>;
export function studioGatewayProgram(bundleId: string): string;
