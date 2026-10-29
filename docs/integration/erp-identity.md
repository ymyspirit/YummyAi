# Personal ERP identity and current authority

The ordinary ERP Web uses each operator's personal OIDC identity. `API_ACCESS_TOKEN`
and the local client-credentials grant are not production user authentication.
Factory collaboration remains a separate default-deny deployment; its grants do
not become ordinary ERP permissions. This slice adds no database migration and
does not provision accounts. Alignment of an existing local identity realm is an
explicit administrative operation described in [local personal runtime](local-personal-runtime.md).

## Login and session

`/login` starts authorization code with S256 PKCE through `/api/erp-auth/login`.
The configured callback is `/api/erp-auth/callback`. The shared identity core
validates one-time state, nonce, RS256 issuer/JWKS, audience, authorized client,
subject and tenant. A strict bounded API response verifies current membership.
The browser receives only an opaque HttpOnly SameSite=Lax session cookie; HTTPS
uses Secure and the __Host prefix. Access/refresh tokens remain AES-GCM encrypted
in Redis. The ERP and factory use different cookie names, Redis namespaces,
authenticated-encryption context and dedicated keys.

The session has an absolute eight-hour lifetime. Refresh persists its encrypted
pending marker before contacting the provider and uses a lock plus CAS/KEEPTTL;
neither a late refresh nor a retry recreates a deleted session or extends that
lifetime. An ambiguous rotation requires login rather than replaying the grant.
Logout is same-origin POST and deletes the server session before reporting success.
It ends this application's session; provider-wide SSO logout is not asserted.

The login return path is encrypted in the one-time flow, restricted to relative
ERP paths and a bounded allowlist of navigation parameters. Authentication/API
paths, external origins and arbitrary query values are excluded. Provider error
descriptions, credentials and tokens never appear in the public error message.

## Current API and Web authority

`GET /v1/identity/session` accepts only authenticated OIDC members, not scoped
integration API clients or caller identity headers. It rereads active membership,
ordinary permissions and self/team/tenant scope through `withTenant()` using the
non-owner role. Factory-only permissions do not grant ERP access. The response
contains only the current user/tenant labels, ordinary permissions and scope;
it does not accept a query-selected tenant or user.

Each ordinary permission retains its own role scope in permissionScopes. The aggregate dataScope is compatibility/display metadata. This map is part of the Web authority fingerprint, so narrowing only product write while tenant read remains must invalidate prior responses and controls. See [product authority](product-authority.md) for implementation and remaining team/module coverage.

The Web proxy protects pages and BFF routes and rejects the legacy `/v1` ingress
in personal mode. RSC and BFF `apiFetch` obtain the current request's session,
replace caller Authorization with that person's token and restrict the destination
to the configured business API origin/prefix. Personal credentials are never
cached process-wide. Private responses are not cached, and write requests require
the configured same-origin Origin header. Business APIs retain their own current
object/role/RLS checks; a Web session is not an operation grant.

The content-project read BFF (`/api/content-projects`, including the shaped-pillow
list and exact order detail) uses this same personal `apiFetch` path in compiled
production builds. It does not require development mode or a loopback browser
hostname. Explicit cross-site requests, unknown paths, caller-selected tenancy,
duplicate query keys and invalid filters are rejected before forwarding. The API
still requires `design:read`, plus `asset:read` for project detail; it retains
tenant and object scope checks. A production-mode gate must not be reported as a
missing account permission.

An ordinary ERP administrator can hold all ordinary ERP business permissions
within the current organization. Factory-portal permissions remain separate, and
role labels do not bypass authentication, tenant scope, immutable-version checks
or business-state requirements.

After the business request returns, Web checks server-session liveness and current
authority again before exposing the response. A changed role/scope discards the
body and returns 409; the UI must check the original operation before retrying.
This cannot roll back a write that was already authorized and committed. Personal
business writes are not automatically replayed.

The ERP frame checks on focus, visibility/pageshow and every 30 seconds. Authority
loss unmounts private content and reloads under current authorization; older
responses cannot restore it. Pagehide cloaks the cached frame before history
restoration, and active visual-transition snapshots are cancelled. A temporary
network failure hides the frame and preserves mounted drafts for an explicit
recheck. Logout hides content immediately, but only confirmed server deletion
shows the login state. The factory UI follows the same confirmed-logout behavior
and blocks background reads while logout is pending or unconfirmed.

## Configuration and deployment

The default `WEB_AUTH_MODE` is `personal`. Ordinary Web requires `API_BASE_URL`,
`OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_WEB_CLIENT_ID`, `WEB_ORIGIN`, `REDIS_URL` and
an independent 32-byte base64url `ERP_SESSION_ENCRYPTION_KEY`. The ERP key must
differ from `FACTORY_SESSION_ENCRYPTION_KEY`. Origins and issuer/JWKS use HTTPS
except explicit loopback development; URLs must not contain credentials, queries
or fragments. API transport may use the configured private deployment network.

The checked-in Keycloak public client `yummyai-web` uses
`http://localhost:3000/api/erp-auth/callback` for local development. A running realm
is not updated by editing the export. Administrators must register the exact
deployed callback, map a valid tenant claim and provision actual active membership
and roles before a real-user trial. Do not use a service account as every employee.

`pnpm --filter @yummyai/web start` runs production preflight before Next startup;
the explicit production flag works before Next sets NODE_ENV. Production rejects
`local-service` even if a service token is configured. The launcher rejects a
developer service mode on production startup and rejects non-loopback development
bindings before starting the canvas helper or Next.

`pnpm start:local` explicitly selects `local-service` for its loopback developer
Web. This preserves the existing local operator fixture and is labelled as local
development identity in the UI. Shared or Internet-facing deployments use personal
mode. The acceptance-only outside-request fixture path additionally requires an
exact disposable database/bucket pair and is disabled in production. Unexpected
Next request-context errors never trigger a service fallback.

## Verification and remaining scope

Source tests cover personal-token isolation, no credential fallback, no write
replay, post-response authority change, session encryption domains, current API
membership and credential kind. The disposable `--suite=erp-identity` runs real
Web/BFF/RSC/API/RLS paths with separate operator, read-only and other-tenant
members, current-role revocation, late responses, history, logout and mobile UI.
Its OIDC service uses local signed synthetic users; it proves protocol and local
application behavior, not real provider provisioning or a production deployment.

Run personal and factory browser suites sequentially because they own the same
fixture ports:

~~~powershell
pnpm test:e2e:order-daily --suite=erp-identity
pnpm test:e2e:order-daily --suite=factory-portal
pnpm test:e2e:order-daily --suite=factory-collaboration
pnpm test:e2e:order-daily --suite=all-integration
~~~

Broader B06 remains active: audit every module's role-dependent controls, team/self
object scopes and private-file paths; verify normal deployment, real personal IdP
accounts, proxy topology and recovery. Local technical success does not complete
R01, a stage, or the full platform. Retention/cleanup facts and frozen results
belong in the dated delivery and project status records, not assumed from this
runbook.
