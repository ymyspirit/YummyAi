import { Permission } from "@yummyai/authz";
import { connectDatabase, migrateDatabase } from "@yummyai/database";

const TENANT_ID = "019f7600-0000-7000-8000-000000000001";
const USER_ID = "019f7600-0000-7000-8000-000000000002";
const MEMBERSHIP_ID = "019f7600-0000-7000-8000-000000000003";
const ROLE_ID = "019f7600-0000-7000-8000-000000000004";
const EXTENSION_USER_ID = "019f7600-0000-7000-8000-000000000005";
const EXTENSION_MEMBERSHIP_ID = "019f7600-0000-7000-8000-000000000006";
const LOCAL_EXTENSION_ID = "pbfkpadkdjbjgmibceaelflmgjhclnhl";
const LEGACY_LOCAL_EXTENSION_ID = "kjknajpgoodonofageomfdenlhmmkmjb";
const LOCAL_EXTENSION_REDIRECT_URIS = [
  `https://${LOCAL_EXTENSION_ID}.chromiumapp.org/oidc`,
  `https://${LEGACY_LOCAL_EXTENSION_ID}.chromiumapp.org/oidc`,
];

async function main() {
  const issuer = required("OIDC_ISSUER");
  const issuerUrl = new URL(issuer);
  const keycloakBase = `${issuerUrl.protocol}//${issuerUrl.host}`;
  const realm = issuerUrl.pathname.split("/").filter(Boolean).at(-1);
  if (!realm) throw new Error("OIDC_ISSUER must contain a realm name");

  const clientId = required("LOCAL_OIDC_CLIENT_ID");
  const clientSecret = required("LOCAL_OIDC_CLIENT_SECRET");
  const adminToken = await form<{ access_token: string }>(
    `${keycloakBase}/realms/master/protocol/openid-connect/token`,
    {
      client_id: "admin-cli",
      grant_type: "password",
      password: required("KEYCLOAK_ADMIN_PASSWORD"),
      username: required("KEYCLOAK_ADMIN"),
    },
  );

  const headers = {
    authorization: `Bearer ${adminToken.access_token}`,
    "content-type": "application/json",
  };
  const adminBase = `${keycloakBase}/admin/realms/${encodeURIComponent(realm)}`;
  const clients = await json<Array<{ id: string }>>(
    `${adminBase}/clients?clientId=${encodeURIComponent(clientId)}`,
    { headers },
  );
  const representation = {
    clientId,
    directAccessGrantsEnabled: false,
    enabled: true,
    name: "YummyAI Local Web Server",
    protocol: "openid-connect",
    protocolMappers: [
      {
        config: {
          "access.token.claim": "true",
          "claim.name": "tenant_id",
          "claim.value": TENANT_ID,
          "id.token.claim": "true",
          "jsonType.label": "String",
        },
        consentRequired: false,
        name: "tenant-id",
        protocol: "openid-connect",
        protocolMapper: "oidc-hardcoded-claim-mapper",
      },
      {
        config: {
          "access.token.claim": "true",
          "included.custom.audience": required("OIDC_AUDIENCE"),
        },
        consentRequired: false,
        name: "api-audience",
        protocol: "openid-connect",
        protocolMapper: "oidc-audience-mapper",
      },
    ],
    publicClient: false,
    secret: clientSecret,
    serviceAccountsEnabled: true,
    standardFlowEnabled: false,
  };

  let internalClientId: string | undefined = clients[0]?.id;
  if (internalClientId) {
    const existing = await json<Record<string, unknown>>(
      `${adminBase}/clients/${internalClientId}`,
      { headers },
    );
    await ok(`${adminBase}/clients/${internalClientId}`, {
      body: JSON.stringify({ ...existing, ...representation }),
      headers,
      method: "PUT",
    });
  } else {
    const response = await ok(`${adminBase}/clients`, {
      body: JSON.stringify(representation),
      headers,
      method: "POST",
    });
    internalClientId = response.headers.get("location")?.split("/").at(-1);
  }
  if (!internalClientId) throw new Error("Keycloak did not return the local client ID");

  await ensureExtensionClientRedirectUris(adminBase, headers);
  const extensionUser = await ensureLocalExtensionUser(adminBase, headers);

  const serviceAccount = await json<{ id: string }>(
    `${adminBase}/clients/${internalClientId}/service-account-user`,
    { headers },
  );

  const database = connectDatabase();
  try {
    await migrateDatabase(database);
    await database.client.begin(async (transaction) => {
      await transaction.unsafe(
        `insert into organizations (id, name, slug)
         values ($1, 'YummyAI Local Workspace', 'yummyai-local-workspace')
         on conflict (id) do update set name = excluded.name, updated_at = now()`,
        [TENANT_ID],
      );
      await transaction.unsafe(
        `insert into app_users (id, oidc_subject, email, display_name)
         values ($1, $2, 'local-server@yummyai.invalid', 'YummyAI Local Server')
         on conflict (id) do update set oidc_subject = excluded.oidc_subject, updated_at = now()`,
        [USER_ID, serviceAccount.id],
      );
      await transaction.unsafe(
        `insert into memberships (id, tenant_id, user_id, status)
         values ($1, $2, $3, 'active')
         on conflict (tenant_id, user_id) do update set status = 'active', updated_at = now()`,
        [MEMBERSHIP_ID, TENANT_ID, USER_ID],
      );
      await transaction.unsafe(
        `insert into roles (id, tenant_id, name, permissions, data_scope)
         values ($1, $2, 'Local Administrator', $3::jsonb, 'tenant')
         on conflict (tenant_id, name) do update
         set permissions = excluded.permissions, data_scope = 'tenant', updated_at = now()`,
        [ROLE_ID, TENANT_ID, JSON.stringify(Object.values(Permission))],
      );
      await transaction.unsafe(
        `insert into membership_roles (tenant_id, membership_id, role_id)
         values ($1, $2, $3)
         on conflict do nothing`,
        [TENANT_ID, MEMBERSHIP_ID, ROLE_ID],
      );
      await transaction.unsafe(
        `insert into app_users (id, oidc_subject, email, display_name)
         values ($1, $2, $3, 'YummyAI Browser Extension')
         on conflict (id) do update
         set oidc_subject = excluded.oidc_subject, email = excluded.email,
             display_name = excluded.display_name, updated_at = now()`,
        [EXTENSION_USER_ID, extensionUser.id, extensionUser.email],
      );
      await transaction.unsafe(
        `insert into memberships (id, tenant_id, user_id, status)
         values ($1, $2, $3, 'active')
         on conflict (tenant_id, user_id) do update set status = 'active', updated_at = now()`,
        [EXTENSION_MEMBERSHIP_ID, TENANT_ID, EXTENSION_USER_ID],
      );
      await transaction.unsafe(
        `insert into membership_roles (tenant_id, membership_id, role_id)
         values ($1, $2, $3)
         on conflict do nothing`,
        [TENANT_ID, EXTENSION_MEMBERSHIP_ID, ROLE_ID],
      );
    });
  } finally {
    await database.client.end();
  }

  process.stdout.write(
    `${JSON.stringify({ clientId, extensionUser: extensionUser.username, serviceAccountSubject: serviceAccount.id, tenantId: TENANT_ID })}\n`,
  );
}

async function ensureExtensionClientRedirectUris(
  adminBase: string,
  headers: Record<string, string>,
): Promise<void> {
  const clients = await json<Array<{ id: string }>>(
    `${adminBase}/clients?clientId=yummyai-extension`,
    { headers },
  );
  const id = clients[0]?.id;
  if (!id) throw new Error("Keycloak yummyai-extension client is missing");
  const current = await json<Record<string, unknown>>(`${adminBase}/clients/${id}`, { headers });
  await ok(`${adminBase}/clients/${id}`, {
    body: JSON.stringify({
      ...current,
      redirectUris: LOCAL_EXTENSION_REDIRECT_URIS,
    }),
    headers: { ...headers, "content-type": "application/json" },
    method: "PUT",
  });
}

async function ensureLocalExtensionUser(
  adminBase: string,
  headers: Record<string, string>,
): Promise<{ id: string; username: string; email: string }> {
  const username = process.env.LOCAL_EXTENSION_USER ?? "yummyai-local";
  const email = process.env.LOCAL_EXTENSION_USER_EMAIL ?? "yummyai-extension@yummyai.local";
  const password = process.env.LOCAL_EXTENSION_USER_PASSWORD ?? "yummyai-local-2026";
  const existing = await json<Array<{ id: string }>>(
    `${adminBase}/users?username=${encodeURIComponent(username)}&exact=true`,
    { headers },
  );
  const user = {
    username,
    email,
    enabled: true,
    emailVerified: true,
    attributes: { tenant_id: [TENANT_ID] },
  };
  let id = existing[0]?.id;
  if (id) {
    await ok(`${adminBase}/users/${id}`, {
      body: JSON.stringify(user),
      headers: { ...headers, "content-type": "application/json" },
      method: "PUT",
    });
  } else {
    const response = await ok(`${adminBase}/users`, {
      body: JSON.stringify({
        ...user,
        credentials: [{ type: "password", value: password, temporary: false }],
      }),
      headers: { ...headers, "content-type": "application/json" },
      method: "POST",
    });
    const locationId = response.headers.get("location")?.split("/").at(-1);
    if (locationId) id = locationId;
  }
  if (!id) throw new Error("Keycloak did not return the local extension user ID");
  await ok(`${adminBase}/users/${id}/reset-password`, {
    body: JSON.stringify({ type: "password", value: password, temporary: false }),
    headers: { ...headers, "content-type": "application/json" },
    method: "PUT",
  });
  return { id, username, email };
}

async function form<T>(url: string, values: Record<string, string>): Promise<T> {
  return json<T>(url, {
    body: new URLSearchParams(values),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await ok(url, init);
  return (await response.json()) as T;
}

async function ok(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Keycloak request failed (${response.status} ${response.statusText})`);
  }
  return response;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

void main();
