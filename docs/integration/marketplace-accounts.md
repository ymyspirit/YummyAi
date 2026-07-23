# Marketplace account and authorization API

P1-A exposes tenant-scoped marketplace account metadata. P1-B adds dedicated authorization routes. General account create/update routes still reject credential-shaped fields, and no route returns plaintext or encrypted credentials.

Base path: `/v1/marketplace-accounts`

## Permissions

| Operation | Permission |
| --- | --- |
| List/get accounts | `store:read` |
| Create/update accounts | `store:manage` |
| Authorization, rotation, and revocation | `store:authorize` |
| Future publication | `listing:publish` |

Publication preflight, queueing, platform semantics, and failure states are documented in [marketplace-publications.md](./marketplace-publications.md).

All routes require the normal YummyAI bearer token and active tenant membership. Tenant identity is resolved from membership, not accepted from the request body.

## Create account

`POST /v1/marketplace-accounts`

Amazon example:

```json
{
  "platform": "amazon",
  "displayName": "Amazon US",
  "region": "NA",
  "marketplaceIds": ["ATVPDKIKX0DER"],
  "authorizationMode": "amazon_private",
  "requestedScopes": ["product-listing"]
}
```

Etsy example:

```json
{
  "platform": "etsy",
  "displayName": "Etsy US",
  "region": "GLOBAL",
  "marketplaceIds": ["etsy"],
  "authorizationMode": "etsy_oauth",
  "requestedScopes": ["listings_r", "listings_w", "shops_r"]
}
```

Unknown fields are rejected. Token, secret, password, and API-key fields are not part of this contract.

## Read accounts

- `GET /v1/marketplace-accounts`
- `GET /v1/marketplace-accounts/{id}`

Responses include account identity, requested/granted scopes, capabilities, account status, credential status, and health metadata. They expose `hasCredential` as a boolean only.

## Update account

`PATCH /v1/marketplace-accounts/{id}`

Supported fields are `displayName`, `marketplaceIds`, `requestedScopes`, and `enabled`. Disabling an account preserves history. Re-enabling an account returns it to `pending_authorization`; callers cannot set `active` directly.

## States

Account status:

`pending_authorization | active | degraded | revoked | disabled`

Credential status:

`missing | valid | expiring | revoked`

Health status:

`not_checked | healthy | degraded | unauthorized | unavailable`

## Errors

- `400`: invalid platform/region/authorization combination or unknown field.
- `401/403`: missing authentication, membership, or permission.
- `404`: account does not exist in the current tenant.
- `409`: display identity already exists for the platform in the tenant.

## Amazon private authorization

`POST /v1/marketplace-accounts/{id}/authorization/private`

```json
{
  "sellingPartnerId": "A1SELLER",
  "clientId": "LWA client ID",
  "clientSecret": "LWA client secret",
  "refreshToken": "LWA refresh token"
}
```

The server exchanges the refresh token for a short-lived LWA access token before storing the encrypted grant. Repeating this operation rotates the encrypted envelope and increments its internal version. The response is the redacted account view.

## Etsy and Amazon public OAuth

1. `POST /v1/marketplace-accounts/{id}/authorization/oauth/start`
2. Redirect the browser to the returned `authorizationUrl`.
3. Normalize the marketplace callback into the completion payload.
4. `POST /v1/marketplace-accounts/{id}/authorization/oauth/complete`

Etsy completion:

```json
{ "state": "single-use state", "code": "authorization code" }
```

Amazon completion:

```json
{
  "state": "single-use state",
  "code": "spapi_oauth_code",
  "sellingPartnerId": "selling_partner_id"
}
```

OAuth state expires after ten minutes and is atomically consumed before code exchange. Etsy PKCE uses S256. The redirect URI used in token exchange is the exact URI frozen at authorization start. A replay, expired state, or superseded flow returns `400` without invoking the platform token endpoint.

Successful authorization sets `credentialStatus=valid` but leaves `status=pending_authorization`. P1-C must verify the seller/shop identity and synchronize capabilities before the account becomes active.

The Web Store Management workspace is `/stores`. Its OAuth start action keeps only the marketplace account ID in a ten-minute `HttpOnly`, `SameSite=Lax` cookie and redirects to the provider URL returned by the API. `/stores/oauth/callback` validates the returned code/state through the server-side API client, clears the cookie on every outcome, and never exposes tokens, PKCE verifiers, provider secrets, or authorization headers to client components or browser storage. The callback then returns to `/stores` with an explicit success or failure state.

## Revoke authorization

`DELETE /v1/marketplace-accounts/{id}/authorization`

Local revocation deletes the encrypted credential, consumes open sessions, clears granted scopes, and prevents connector access. Amazon/Etsy portal-side revocation remains an operator action when the provider has no matching application endpoint.

## Configuration

`MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY` is a base64url-encoded 32-byte production key. Local development may derive a stable local-only key from `LOCAL_OIDC_CLIENT_SECRET`; production fails closed without the dedicated key.

Etsy requires `ETSY_APP_KEYSTRING`, `ETSY_APP_SHARED_SECRET`, and an exact HTTPS `ETSY_OAUTH_REDIRECT_URI`.

Amazon public authorization requires `AMAZON_SPAPI_APPLICATION_ID`, `AMAZON_SPAPI_LWA_CLIENT_ID`, `AMAZON_SPAPI_LWA_CLIENT_SECRET`, `AMAZON_SPAPI_OAUTH_REDIRECT_URI`, and regional `AMAZON_SPAPI_AUTH_BASE_URL_*` values. Set `AMAZON_SPAPI_APP_DRAFT=1` only while testing a draft application.

Never put these variables, authorization codes, raw state, tokens, or secrets in logs, screenshots, issue reports, audit metadata, or browser storage.

## Capability synchronization

- `POST /v1/marketplace-accounts/{id}/capabilities/sync` requires `store:manage`.
- `GET /v1/marketplace-accounts/{id}/capabilities` requires `store:read` and returns the latest immutable snapshot.

Amazon example:

```json
{
  "amazonProductTypes": ["HOME", "PILLOW"],
  "ttlHours": 24
}
```

Etsy example:

```json
{
  "etsyTaxonomyNodeIds": [42, 123],
  "ttlHours": 24
}
```

Amazon product types and Etsy taxonomy property nodes are optional target lists capped at ten. Amazon product type and configured marketplace combinations are capped at twenty per synchronous request. Larger refreshes belong in delayed P1-G jobs.

Amazon synchronization refreshes LWA access, verifies every configured marketplace through Sellers v1, and downloads targeted Product Type Definition schema documents. Snapshot data retains schema checksums and documents but removes temporary signed resource links.

Etsy synchronization refreshes OAuth access, binds the authorized user to the owned shop, and reads shop sections, return policies, seller taxonomy, and, with `shops_r`, shipping/readiness profiles. A rotated Etsy refresh token replaces the encrypted credential in the same database transaction.

A healthy result sets the account to `active`. Suspended or missing Amazon marketplace participation creates a `degraded` snapshot without listing-write capability. `401/403` marks the credential and account revoked. Expired snapshots return `stale=true` and cannot satisfy future publishing validation.
