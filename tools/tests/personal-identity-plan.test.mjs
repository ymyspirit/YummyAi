import test from "node:test";
import assert from "node:assert/strict";
import { localPersonalCallback, planPersonalClient, planPersonalProfile, planPersonalMember } from "../scripts/personal-identity-plan.mjs";
const tenant = "0198fbef-4a10-7000-8000-000000000041", other = "0198fbef-4a10-7000-8000-000000000042";
const audience = "yummyai-api";
const client = () => ({ enabled: true, publicClient: true, standardFlowEnabled: true, directAccessGrantsEnabled: false, attributes: { "pkce.code.challenge.method": "S256" }, redirectUris: ["http://localhost:3000/auth/callback"], protocolMappers: [{ protocolMapper: "oidc-usermodel-attribute-mapper", config: { "claim.name": "tenant_id", "user.attribute": "tenant_id", "jsonType.label": "String", "access.token.claim": "true", "id.token.claim": "true" } }, { protocolMapper: "oidc-audience-mapper", config: { "included.custom.audience": audience, "access.token.claim": "true" } }] });
test("adds only the exact new callback, preserving the existing login path and retrying idempotently", () => {
  const callback = localPersonalCallback("http://localhost:3000"), current = client(), plan = planPersonalClient(current, callback, audience);
  assert.equal(callback, "http://localhost:3000/api/erp-auth/callback");
  assert.deepEqual(plan.redirects, [...current.redirectUris, callback]);
  assert.equal(planPersonalClient({ ...current, redirectUris: plan.redirects }, callback, audience).changed, false);
});
test("local bootstrap rejects external, credential-bearing and path-selected origins", () => {
  for (const origin of ["https://erp.example", "http://user:secret@localhost:3000", "http://localhost:3000/path", "http://localhost:3000/?secret=value", "http://localhost:3000/#callback"])
    assert.throws(() => localPersonalCallback(origin));
});
test("requires public S256 authorization-code authentication with password grants disabled", () => {
  for (const patch of [{ publicClient: false }, { publicClient: "true" }, { standardFlowEnabled: false }, { directAccessGrantsEnabled: true }, { enabled: false }, { attributes: {} }])
    assert.throws(() => planPersonalClient({ ...client(), ...patch }, "http://localhost:3000/api/erp-auth/callback", audience), { code: "personal_client_contract_mismatch" });
});
test("does not adopt a hardcoded or missing tenant mapper", () => {
  for (const protocolMappers of [[], [{ protocolMapper: "oidc-hardcoded-claim-mapper", config: { "claim.name": "tenant_id", "claim.value": tenant } }]])
    assert.throws(() => planPersonalClient({ ...client(), protocolMappers }, "http://localhost:3000/api/erp-auth/callback", audience), { code: "personal_tenant_mapper_mismatch" });
});
test("requires tenant claims in both token types and the configured API audience", () => {
  const current = client(); current.protocolMappers[0].config["access.token.claim"] = "false";
  assert.throws(() => planPersonalClient(current, "http://localhost:3000/api/erp-auth/callback", audience), { code: "personal_tenant_mapper_mismatch" });
  assert.throws(() => planPersonalClient(client(), "http://localhost:3000/api/erp-auth/callback", "another-api"), { code: "personal_audience_mapper_mismatch" });
});
test("registers only an admin-controlled tenant attribute and preserves all existing profile metadata", () => {
  const source = { attributes: [{ name: "email", required: { roles: ["user"] } }], groups: [{ name: "contact" }], unmanagedAttributePolicy: "ADMIN_EDIT" };
  const result = planPersonalProfile(source);
  assert.deepEqual(result.profile.attributes[0], source.attributes[0]);
  assert.deepEqual(result.profile.groups, source.groups);
  assert.deepEqual(result.profile.attributes[1].permissions, { view: ["admin"], edit: ["admin"] });
  assert.equal(result.profile.unmanagedAttributePolicy, "ADMIN_EDIT");
  assert.equal(planPersonalProfile(result.profile).changed, false);
});
test("refuses to overwrite a user-editable or multivalued tenant attribute", () => {
  assert.throws(() => planPersonalProfile({ attributes: [{ name: "tenant_id", permissions: { view: ["admin"], edit: ["user", "admin"] } }] }), { code: "personal_tenant_attribute_requires_admin_control" });
  assert.throws(() => planPersonalProfile({ attributes: [{ name: "tenant_id", multivalued: true, permissions: { view: ["admin"], edit: ["admin"] } }] }), { code: "personal_tenant_attribute_ambiguous" });
});
test("uses only an existing unique membership and preserves other user attributes", () => {
  const user = { enabled: true, attributes: { existing: ["preserve"] } }, result = planPersonalMember(user, [tenant]);
  assert.deepEqual(result.attributes, { existing: ["preserve"], tenant_id: [tenant] });
  assert.equal(planPersonalMember({ ...user, attributes: result.attributes }, [tenant]).changed, false);
  assert.equal(user.attributes.tenant_id, undefined);
});
test("never invents membership or chooses between multiple workspaces", () => {
  assert.deepEqual(planPersonalMember({ enabled: true }, []), { changed: false, reason: "not_existing_erp_member" });
  assert.throws(() => planPersonalMember({ enabled: true }, [tenant, other]), { code: "personal_workspace_selection_required" });
  assert.equal(planPersonalMember({ enabled: true, username: "service-account-example" }, [tenant]).reason, "not_enabled_personal_account");
});
test("preserves an authorized workspace choice and refuses an unauthorized existing claim", () => {
  assert.equal(planPersonalMember({ enabled: true, attributes: { tenant_id: [other] } }, [tenant, other]).tenantId, other);
  assert.throws(() => planPersonalMember({ enabled: true, attributes: { tenant_id: [other] } }, [tenant]), { code: "personal_existing_tenant_claim_not_authorized" });
});
test("rejects malformed membership identifiers", () => {
  assert.throws(() => planPersonalMember({ enabled: true }, ["-".repeat(36)]), { code: "personal_membership_identifier_invalid" });
  assert.throws(() => planPersonalMember({ enabled: true }, [tenant.replace("-7000-", "-4000-")]), { code: "personal_membership_identifier_invalid" });
});
