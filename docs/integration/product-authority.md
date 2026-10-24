# Permission scopes and core product authority

2026-10-18 · PRD 1.1.4 · R01/B06, related B07. This is an ongoing platform
authorization audit, not completion of all module or team access.

Current trusted-team relationships, product/artwork ownership, scoped catalog
reads and package downloads extend this baseline through [catalog scope](catalog-scope.md).
Other business domains and complete B06/B07 acceptance remain ongoing.

## Roles and authenticated context

The subject lookup reads the global user identity only. Current active membership,
role grants and factory assignments use the ordinary application role inside
withTenant(). Role union retains a separate scope for each permission. A tenant
product read role and a self product write role never combine into tenant writes.
Broader grants for the same permission still union normally.

TenantContext.permissionScopes is pinned for authenticated membership loads and
transactional current-role loads. dataScope remains aggregate compatibility and
display metadata; new object policies use permissionScope/permissionContext or
authorize(context, permission, resource). A supplied map missing the requested
permission fails closed. Older internal contexts without a map retain their
explicit single-scope behavior; that compatibility is not proof of current member
authority or retrospective migration of queued jobs.

The personal session returns ordinary permission scopes and includes them in its
authority fingerprint. A scope change with unchanged permission names and an
unchanged aggregate must still invalidate protected responses, draft controls and
late identity responses. Factory-only permissions do not create ERP access.

## Product owner and commands

The legacy product service checks permissions internally for creation, reads,
customization, transitions, SPU creation and SKU creation. It uses each operation's
scope for repository filtering and checks the parent plan before accepting an SPU
ID. Self-scoped lists include only the actor's plans; broad read grants do not
authorize writes to those other visible plans. Missing/foreign private objects
return not found at this boundary. Lifecycle and evidence rules remain in place.

The custom product facts/package owner independently checks product read and
write ownership and research read scope. Its reviewed sources, immutable package
receipts, asset domains and existing production/release gates remain authoritative.
Legacy product controls use the same pure authorization function and the current
plan owner, including an explicit editing-scope message. Self writers may still
create and edit their own plans.

Actual team membership and product team ownership are not yet persisted. Team
object access requires matching trusted metadata or the actor's own ownership;
it is not inferred from a role name or silently expanded to tenant access.
Modern development workspaces, shared library policy, other module filters,
workers and historical scope policies still require their own full audit.

## Reuse decision

Reviewed the existing [Nest authorization guidance](https://docs.nestjs.com/security/authorization)
and [node-casbin](https://github.com/apache/casbin-node-casbin). This slice keeps
the project's native policy module and transaction owners; no additional policy
engine or external dependency upgrade was introduced. The only dependency link
adds the existing authz workspace to the database membership loader.

## Verification

~~~powershell
pnpm test:e2e:order-daily --suite=product-authority-integration
pnpm test:e2e:order-daily --suite=product-access --output tmp/product-authority-e2e
~~~

These use disposable resources. Exact observed results, final source identity,
cleanup outcomes and remaining requirements belong in the current delivery
checkpoint. Synthetic personal identities prove the application path; real IdP,
deployment, complete team policy and business acceptance remain separate.
