import { randomBytes } from "node:crypto";

import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { connectDatabase, migrateDatabase, modelProviderConfigs, withTenant } from "@yummyai/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { ModelConfigController } from "./model-config.controller.js";

describe("model provider configuration", () => {
  const database = connectDatabase();
  const vault = new SecretVault(randomBytes(32));
  const controller = new ModelConfigController(database, vault);
  const tenantId = createEntityId();
  const otherTenantId = createEntityId();
  const userId = createEntityId();
  const context: TenantContext = {
    tenantId,
    userId,
    permissions: [Permission.ModelConfigure],
    dataScope: "tenant",
  };
  const otherContext: TenantContext = {
    tenantId: otherTenantId,
    userId,
    permissions: [Permission.ModelConfigure],
    dataScope: "tenant",
  };
  const request: AuthenticatedRequest = { headers: {}, tenantContext: context };
  let configId: string;
  let encryptedCredential: string;

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe(
      `insert into organizations (id, name, slug) values ($1, 'AI tenant', $2), ($3, 'Other AI tenant', $4)`,
      [tenantId, `ai-${tenantId}`, otherTenantId, `other-ai-${otherTenantId}`],
    );
    await database.client.unsafe(
      `insert into app_users (id, oidc_subject, email, display_name) values ($1, $2, $3, 'AI Admin')`,
      [userId, `ai-${userId}`, `${userId}@example.test`],
    );
  });

  afterAll(async () => {
    await database.client.end();
  });

  it("stores the API key as authenticated ciphertext and never returns it", async () => {
    const created = await controller.create(request, {
      provider: "openai",
      label: "Primary OpenAI",
      apiKey: "sk-plaintext-must-not-persist",
    });
    configId = created.id;
    expect(created).toMatchObject({ provider: "openai", hasCredential: true });
    expect(JSON.stringify(created)).not.toContain("sk-plaintext");

    const [stored] = await withTenant(database.db, context, (tx) =>
      tx.select().from(modelProviderConfigs).where(eq(modelProviderConfigs.id, configId)),
    );
    encryptedCredential = stored!.encryptedApiKey;
    expect(encryptedCredential).not.toContain("sk-plaintext-must-not-persist");
    expect(vault.withSecret(encryptedCredential, (secret) => secret)).toBe("sk-plaintext-must-not-persist");
  });

  it("returns only redacted provider metadata", async () => {
    const rows = await controller.list(request);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: configId, hasCredential: true });
    expect(rows[0]).not.toHaveProperty("encryptedApiKey");
    expect(rows[0]).not.toHaveProperty("apiKey");
  });

  it("rotates credentials without exposing the new value", async () => {
    const updated = await controller.update(request, configId, { apiKey: "sk-rotated", status: "disabled" });
    expect(updated).toMatchObject({ id: configId, status: "disabled", hasCredential: true });
    const [stored] = await withTenant(database.db, context, (tx) =>
      tx.select().from(modelProviderConfigs).where(eq(modelProviderConfigs.id, configId)),
    );
    expect(stored!.encryptedApiKey).not.toBe(encryptedCredential);
    expect(vault.withSecret(stored!.encryptedApiKey, (secret) => secret)).toBe("sk-rotated");
  });

  it("does not reveal or mutate another tenant's configuration", async () => {
    const otherRequest: AuthenticatedRequest = { headers: {}, tenantContext: otherContext };
    await expect(controller.list(otherRequest)).resolves.toEqual([]);
    await expect(controller.update(otherRequest, configId, { status: "enabled" })).rejects.toMatchObject({ status: 404 });
  });
});
