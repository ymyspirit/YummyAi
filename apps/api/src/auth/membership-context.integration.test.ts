import { randomBytes } from "node:crypto";

import { connectDatabase, migrateDatabase } from "@yummyai/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OidcClaims } from "./oidc-jwt.strategy.js";
import { DatabaseMembershipContextLoader } from "./tenant-context.guard.js";

function uuidV7(): string {
  const bytes = randomBytes(16);
  let timestamp = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function claims(subject: string, tenantId: string): OidcClaims {
  return { sub: subject, tenant_id: tenantId };
}

describe("database membership context", () => {
  const database = connectDatabase();
  const loader = new DatabaseMembershipContextLoader(database);
  const tenantId = uuidV7();
  const activeUserId = uuidV7();
  const disabledUserId = uuidV7();
  const activeMembershipId = uuidV7();
  const disabledMembershipId = uuidV7();
  const roleId = uuidV7();
  const activeSubject = `active-${activeUserId}`;
  const disabledSubject = `disabled-${disabledUserId}`;

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.begin(async (sql) => {
      await sql.unsafe(
        "insert into organizations (id, name, slug) values ($1, $2, $3)",
        [tenantId, "Auth tenant", `auth-${tenantId}`],
      );
      await sql.unsafe(
        `insert into app_users (id, oidc_subject, email, display_name)
         values ($1, $2, $3, $4), ($5, $6, $7, $8)`,
        [
          activeUserId,
          activeSubject,
          `${activeUserId}@example.test`,
          "Active User",
          disabledUserId,
          disabledSubject,
          `${disabledUserId}@example.test`,
          "Disabled User",
        ],
      );
      await sql.unsafe(
        `insert into memberships (id, tenant_id, user_id, status)
         values ($1, $2, $3, 'active'), ($4, $2, $5, 'disabled')`,
        [activeMembershipId, tenantId, activeUserId, disabledMembershipId, disabledUserId],
      );
      await sql.unsafe(
        `insert into roles (id, tenant_id, name, permissions, data_scope)
         values ($1, $2, 'Operator', $3::jsonb, 'tenant')`,
        [roleId, tenantId, JSON.stringify(["capture:read", "capture:write"])],
      );
      await sql.unsafe(
        "insert into membership_roles (tenant_id, membership_id, role_id) values ($1, $2, $3)",
        [tenantId, activeMembershipId, roleId],
      );
    });
  });

  afterAll(async () => {
    await database.client.end();
  });

  it("loads active membership permissions and the broadest data scope", async () => {
    await expect(loader.load(claims(activeSubject, tenantId))).resolves.toEqual({
      tenantId,
      userId: activeUserId,
      permissions: ["capture:read", "capture:write"],
      dataScope: "tenant",
    });
  });

  it("rejects a disabled membership", async () => {
    await expect(loader.load(claims(disabledSubject, tenantId))).resolves.toBeNull();
  });

  it("rejects a subject that has no membership in the requested tenant", async () => {
    await expect(loader.load(claims("unknown", tenantId))).resolves.toBeNull();
  });
});
