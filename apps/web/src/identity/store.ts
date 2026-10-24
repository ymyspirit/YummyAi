import Redis from "ioredis";
import { createHash } from "node:crypto";

export interface PersonalSessionStore {
  get(kind: "flow" | "session", id: string): Promise<string | null>;
  put(kind: "flow" | "session", id: string, value: string, ttlSeconds: number): Promise<void>;
  consumeFlow(id: string, expected: string): Promise<boolean>;
  replaceSession(id: string, previous: string, next: string): Promise<boolean>;
  removeSession(id: string): Promise<void>;
  takeRefreshLock(id: string, owner: string): Promise<boolean>;
  isRefreshLocked(id: string): Promise<boolean>;
  releaseRefreshLock(id: string, owner: string): Promise<void>;
}
const compareDelete =
  "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";
const replaceKeepingExpiry =
  "if redis.call('get',KEYS[1])==ARGV[1] then redis.call('set',KEYS[1],ARGV[2],'KEEPTTL'); return 1 else return 0 end";
export class RedisPersonalSessionStore implements PersonalSessionStore {
  private readonly client: Redis;
  private readonly ready: Promise<void>;
  constructor(
    url: string,
    private readonly namespace: string,
  ) {
    this.client = new Redis(url, {
      lazyConnect: true,
      connectTimeout: 5000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    // Do not log a connection error containing an identity-store credential URL.
    this.client.on("error", () => {});
    this.ready = this.client.connect();
    void this.ready.catch(() => {});
  }
  private key(kind: string, id: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) throw Error("Invalid opaque session identifier");
    return `${this.namespace}:${kind}:${createHash("sha256").update(id).digest("hex")}`;
  }
  async get(kind: "flow" | "session", id: string) {
    await this.ready;
    return this.client.get(this.key(kind, id));
  }
  async put(kind: "flow" | "session", id: string, value: string, ttlSeconds: number) {
    await this.ready;
    await this.client.set(this.key(kind, id), value, "EX", ttlSeconds);
  }
  async consumeFlow(id: string, expected: string) {
    await this.ready;
    return Number(await this.client.eval(compareDelete, 1, this.key("flow", id), expected)) === 1;
  }
  async replaceSession(id: string, previous: string, next: string) {
    await this.ready;
    return (
      Number(
        await this.client.eval(replaceKeepingExpiry, 1, this.key("session", id), previous, next),
      ) === 1
    );
  }
  async removeSession(id: string) {
    await this.ready;
    await this.client.del(this.key("session", id));
  }
  async takeRefreshLock(id: string, owner: string) {
    await this.ready;
    return (await this.client.set(this.key("refresh", id), owner, "PX", 35000, "NX")) === "OK";
  }
  async isRefreshLocked(id: string) {
    await this.ready;
    return (await this.client.exists(this.key("refresh", id))) === 1;
  }
  async releaseRefreshLock(id: string, owner: string) {
    await this.ready;
    await this.client.eval(compareDelete, 1, this.key("refresh", id), owner);
  }
  get closed() {
    return this.client.status === "end";
  }
  async close() {
    await this.ready.catch(() => {});
    this.client.disconnect();
  }
}
