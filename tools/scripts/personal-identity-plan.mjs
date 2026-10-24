import { URL } from "node:url";

export class PersonalIdentitySetupError extends Error {
  constructor(code) { super(code); this.code = code; this.name = "PersonalIdentitySetupError"; }
}
const fail = code => { throw new PersonalIdentitySetupError(code); };
export function localPersonalCallback(origin) {
  let value;
  try { value = new URL(origin); } catch { fail("personal_origin_invalid"); }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(value.hostname) || !["http:", "https:"].includes(value.protocol) || value.username || value.password || value.search || value.hash || value.pathname !== "/") fail("personal_origin_requires_loopback");
  return value.origin + "/api/erp-auth/callback";
}
export function planPersonalClient(client, callback, audience) {
  if (client.enabled !== true || client.publicClient !== true || client.standardFlowEnabled !== true || client.directAccessGrantsEnabled !== false || client.attributes?.["pkce.code.challenge.method"] !== "S256") fail("personal_client_contract_mismatch");
  const tenantMapper = client.protocolMappers?.find(m => m.config?.["claim.name"] === "tenant_id");
  if (tenantMapper?.protocolMapper !== "oidc-usermodel-attribute-mapper" || tenantMapper.config?.["user.attribute"] !== "tenant_id" || tenantMapper.config?.["jsonType.label"] !== "String" || tenantMapper.config?.["access.token.claim"] !== "true" || tenantMapper.config?.["id.token.claim"] !== "true") fail("personal_tenant_mapper_mismatch");
  if (!audience || !client.protocolMappers?.some(m => m.protocolMapper === "oidc-audience-mapper" && m.config?.["included.custom.audience"] === audience && m.config?.["access.token.claim"] === "true")) fail("personal_audience_mapper_mismatch");
  if (!Array.isArray(client.redirectUris) || client.redirectUris.some(v => typeof v !== "string")) fail("personal_client_redirects_invalid");
  return { changed: !client.redirectUris.includes(callback), redirects: [...new Set([...client.redirectUris, callback])] };
}
export function planPersonalProfile(profile) {
  if (!Array.isArray(profile.attributes)) fail("personal_profile_invalid");
  const existing = profile.attributes.filter(a => a.name === "tenant_id");
  if (existing.length > 1) fail("personal_tenant_attribute_ambiguous");
  if (existing.length) {
    for (const kind of ["view", "edit"]) if (existing[0].permissions?.[kind]?.length !== 1 || existing[0].permissions[kind][0] !== "admin") fail("personal_tenant_attribute_requires_admin_control");
    if (existing[0].multivalued === true) fail("personal_tenant_attribute_ambiguous");
    return { changed: false, profile };
  }
  return { changed: true, profile: { ...profile, attributes: [...profile.attributes, {
    name: "tenant_id", displayName: "ERP organization ID", multivalued: false,
    permissions: { view: ["admin"], edit: ["admin"] },
    validations: { pattern: { pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", "error-message": "A valid organization ID is required" } },
  }] } };
}
export function planPersonalMember(user, activeTenantIds) {
  if (user.enabled !== true || user.serviceAccountClientId || user.username?.startsWith("service-account-")) return { changed: false, reason: "not_enabled_personal_account" };
  const ids = [...new Set(activeTenantIds)];
  if (ids.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) fail("personal_membership_identifier_invalid");
  const existing = user.attributes?.tenant_id ?? [];
  if (!Array.isArray(existing) || existing.length > 1) fail("personal_existing_tenant_claim_ambiguous");
  if (existing.length) {
    if (!ids.includes(existing[0])) fail("personal_existing_tenant_claim_not_authorized");
    return { changed: false, reason: "existing_authorized_claim", tenantId: existing[0] };
  }
  if (!ids.length) return { changed: false, reason: "not_existing_erp_member" };
  if (ids.length !== 1) fail("personal_workspace_selection_required");
  return { changed: true, reason: "existing_unique_membership", tenantId: ids[0], attributes: { ...user.attributes, tenant_id: [ids[0]] } };
}
