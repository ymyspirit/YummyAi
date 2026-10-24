import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connectDatabase } from "../../packages/database/src/client.ts";
import { resolveWorkspacePath } from "./backup-restore.mjs";
import { PersonalIdentitySetupError, localPersonalCallback, planPersonalClient, planPersonalProfile, planPersonalMember } from "./personal-identity-plan.mjs";

const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code: string): never => { throw new PersonalIdentitySetupError(code); };
const local = (value: string) => { const u = new URL(value); if (!["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) || u.username || u.password || u.search || u.hash) fail("personal_setup_requires_local_services"); return u; };
type RecordValue = Record<string, unknown>;

export async function setupLocalPersonalIdentity({ apply = false, reportPath }: { apply?: boolean; reportPath: string }) {
  const reportFile = await resolveWorkspacePath(root, reportPath, { fresh: true });
  const issuer = local(process.env.OIDC_ISSUER!), realm = issuer.pathname.match(/^\/realms\/([A-Za-z0-9_-]+)\/?$/)?.[1];
  const databaseUrl = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname) || !realm || !process.env.OIDC_WEB_CLIENT_ID || !process.env.OIDC_AUDIENCE || !process.env.KEYCLOAK_ADMIN || !process.env.KEYCLOAK_ADMIN_PASSWORD) fail("personal_setup_configuration_missing");
  if (process.env.FACTORY_PORTAL_ONLY === "1" || (process.env.WEB_AUTH_MODE ?? "personal") !== "personal") fail("personal_setup_requires_personal_erp_mode");
  const callback = localPersonalCallback(process.env.WEB_ORIGIN ?? "http://localhost:3000");
  const report: RecordValue = { recordedAt: new Date().toISOString(), operation: apply ? "apply_existing_identity_alignment" : "inspect", status: "checking", callback, databaseWritten: false, usersCreated: false, rolesChanged: false, permissionsChanged: false, accountPasswordsChanged: false, normalWorkerStarted: false, actualPaidCalls: 0, adminSessionClosed: false };
  await fs.mkdir(path.dirname(reportFile), { recursive: true });
  await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  const save = () => fs.writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
  const database = connectDatabase();
  let tokens: { access_token: string; refresh_token: string } | undefined;
  let receiptFile: string | undefined;
  const completed: string[] = [];
  const request = async (relative: string, options: RequestInit = {}) => {
    const response = await fetch(issuer.origin + relative, { ...options, redirect: "error", signal: AbortSignal.timeout(8000), headers: { ...(tokens ? { authorization: `Bearer ${tokens.access_token}` } : {}), ...options.headers } });
    if (!response.ok) fail("personal_identity_request_rejected");
    return response;
  };
  const get = async (relative: string) => (await request(relative)).json();
  const put = async (relative: string, body: unknown) => { await request(relative, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); };
  const tenantIds = async (subject: string) => (await database.client.unsafe("select m.tenant_id::text as tenant_id from app_users u join memberships m on m.user_id=u.id where u.oidc_subject=$1 and m.status='active' order by m.tenant_id", [subject])).map(row => row.tenant_id as string);
  try {
    const token = await request("/realms/master/protocol/openid-connect/token", { method: "POST", body: new URLSearchParams({ client_id: "admin-cli", grant_type: "password", username: process.env.KEYCLOAK_ADMIN!, password: process.env.KEYCLOAK_ADMIN_PASSWORD! }) });
    tokens = await token.json();
    if (!tokens?.access_token || !tokens.refresh_token) fail("personal_admin_session_invalid");
    const base = `/admin/realms/${realm}`, clients = await get(base + "/clients?" + new URLSearchParams({ clientId: process.env.OIDC_WEB_CLIENT_ID! }));
    if (!Array.isArray(clients) || clients.length !== 1 || typeof clients[0].id !== "string") fail("personal_existing_client_required");
    const client = clients[0], clientPlan = planPersonalClient(client, callback, process.env.OIDC_AUDIENCE);
    const profile = await get(base + "/users/profile"), profilePlan = planPersonalProfile(profile);
    const accounts = [];
    let ended = false;
    for (let first = 0; first < 10_000; first += 100) {
      const page = await get(base + `/users?first=${first}&max=100`);
      if (!Array.isArray(page)) fail("personal_user_inventory_invalid");
      for (const user of page) {
        if (typeof user.id !== "string") fail("personal_user_inventory_invalid");
        const plan = planPersonalMember(user, await tenantIds(user.id));
        accounts.push({ id: user.id as string, plan, reference: hash(user.id).slice(0, 12) });
      }
      if (page.length < 100) { ended = true; break; }
    }
    if (!ended) fail("personal_user_inventory_limit");
    Object.assign(report, { plannedClientCallback: clientPlan.changed, plannedAdminTenantAttribute: profilePlan.changed, accounts: accounts.map(a => ({ reference: a.reference, reason: a.plan.reason, claimChangeRequired: a.plan.changed })), plannedMemberClaims: accounts.filter(a => a.plan.changed).length, confirmedExistingMembers: accounts.filter(a => a.plan.tenantId).length });
    await save();
    if (apply) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(process.env.ERP_SESSION_ENCRYPTION_KEY ?? "") || process.env.ERP_SESSION_ENCRYPTION_KEY === process.env.FACTORY_SESSION_ENCRYPTION_KEY) fail("personal_session_configuration_missing");
      const privateDirectory = await resolveWorkspacePath(root, ".artifacts/identity-adoption/" + randomUUID(), { fresh: true });
      await fs.mkdir(privateDirectory, { recursive: true, mode: 0o700 });
      receiptFile = path.join(privateDirectory, "operation.json");
      const intent = { recordedAt: new Date().toISOString(), status: "intent_recorded", issuer: issuer.origin + issuer.pathname, clientId: client.id, addedCallback: clientPlan.changed ? callback : null, profileAttributeAdded: profilePlan.changed, originalClientContractSha256: hash(client), originalProfileSha256: hash(profile), memberClaims: accounts.filter(a => a.plan.changed).map(a => ({ subject: a.id, tenantId: a.plan.tenantId, originalAttribute: null })), completed };
      await fs.writeFile(receiptFile, JSON.stringify(intent, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      report.privateOperationReceipt = path.relative(root, receiptFile).replaceAll("\\", "/"); await save();
      if (profilePlan.changed) {
        if (hash(await get(base + "/users/profile")) !== hash(profile)) fail("personal_profile_changed_during_setup");
        await put(base + "/users/profile", profilePlan.profile); completed.push("admin_tenant_attribute_registered");
      }
      if (clientPlan.changed) {
        const current = await get(base + "/clients/" + encodeURIComponent(client.id));
        const currentPlan = planPersonalClient(current, callback, process.env.OIDC_AUDIENCE);
        if (currentPlan.changed) {
          if (hash([...current.redirectUris].sort()) !== hash([...client.redirectUris].sort())) fail("personal_client_changed_during_setup");
          await put(base + "/clients/" + encodeURIComponent(client.id), { redirectUris: currentPlan.redirects });
        }
        completed.push("exact_callback_added");
      }
      for (const account of accounts.filter(a => a.plan.changed)) {
        const route = base + "/users/" + encodeURIComponent(account.id), current = await get(route);
        const next = planPersonalMember(current, await tenantIds(account.id));
        if (next.tenantId !== account.plan.tenantId) fail("personal_membership_changed_during_setup");
        const basicKeys = ["username", "email", "firstName", "lastName", "enabled", "emailVerified", "requiredActions"];
        const basicProjection = (u: RecordValue) => Object.fromEntries(basicKeys.map(key => [key, u[key] ?? null]));
        if (next.changed) await put(route, { ...Object.fromEntries(basicKeys.filter(key => current[key] !== undefined).map(key => [key, current[key]])), attributes: next.attributes });
        const verified = await get(route);
        if (hash(basicProjection(current)) !== hash(basicProjection(verified))) fail("personal_existing_user_fields_changed");
        if (verified.attributes?.tenant_id?.length !== 1 || verified.attributes.tenant_id[0] !== account.plan.tenantId || !(await tenantIds(account.id)).includes(account.plan.tenantId!)) fail("personal_claim_verification_failed");
        completed.push("existing_member_claim_aligned:" + account.reference);
      }
      const checkedClient = await get(base + "/clients/" + encodeURIComponent(client.id));
      if (planPersonalClient(checkedClient, callback, process.env.OIDC_AUDIENCE).changed || client.redirectUris.some((v: string) => !checkedClient.redirectUris.includes(v))) fail("personal_callback_verification_failed");
      if (planPersonalProfile(await get(base + "/users/profile")).changed) fail("personal_profile_verification_failed");
      await fs.writeFile(receiptFile, JSON.stringify({ ...intent, status: "verified", completed }, null, 2) + "\n", { mode: 0o600 });
    }
    Object.assign(report, { status: apply ? "pass" : "inspected", completed, loginStillRequiresHumanAuthentication: true });
  } catch (error) {
    Object.assign(report, { status: "failed", error: error instanceof PersonalIdentitySetupError ? error.code : "personal_identity_setup_failed", completed, externalStateRequiresReadback: apply });
    if (receiptFile) {
      const intent = JSON.parse(await fs.readFile(receiptFile, "utf8"));
      await fs.writeFile(receiptFile, JSON.stringify({ ...intent, status: "requires_readback", completed }, null, 2) + "\n", { mode: 0o600 });
    }
  } finally {
    try { await database.client.end(); }
    catch { report.status = "failed"; report.error = "personal_database_connection_cleanup_failed"; }
    if (tokens?.refresh_token) {
      try {
        const response = await request("/realms/master/protocol/openid-connect/logout", { method: "POST", body: new URLSearchParams({ client_id: "admin-cli", refresh_token: tokens.refresh_token }) });
        report.adminSessionClosed = response.status === 204;
      } catch { report.adminSessionClosed = false; }
      if (!report.adminSessionClosed) { report.status = "failed"; report.error = "personal_admin_session_cleanup_failed"; }
    }
    await save();
  }
  if (report.status === "failed") fail(String(report.error));
  return report;
}
async function main() {
  const args = process.argv.slice(2), apply = args.includes("--apply"), index = args.indexOf("--report");
  if (index < 0 || !args[index + 1] || args.some((v, i) => i !== index + 1 && !["--apply", "--report"].includes(v))) fail("personal_setup_arguments_invalid");
  return setupLocalPersonalIdentity({ apply, reportPath: args[index + 1]! });
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().then(result => process.stdout.write(JSON.stringify(result) + "\n")).catch(error => { process.stderr.write((error instanceof PersonalIdentitySetupError ? error.code : "personal_identity_setup_failed") + "\n"); process.exitCode = 1; });
}
