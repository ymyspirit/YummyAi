import { createServer, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { generateKeyPair, exportJWK, SignJWT } = await import(
  pathToFileURL(webRequire.resolve("jose")).href
);
export const factoryFixtureAccounts = {
  main: { subject: "synthetic-factory-main", name: "Synthetic factory operator" },
  reader: { subject: "synthetic-factory-reader", name: "Synthetic factory reader" },
  other: { subject: "synthetic-factory-other", name: "Synthetic unrelated member" },
};

/** Loopback-only synthetic OIDC provider. No production identity state is changed. */
export async function startFactoryIdentityFixture(
  tenantId: string,
  operatorSubject: string,
  portalOrigin: string,
  options:{application?:"factory"|"erp";clientId?:string;factoryQuantityDualClient?:boolean;accounts?:Record<string,{subject:string;name:string;tenantId?:string}>}={},
) {
  const dual=options.factoryQuantityDualClient===true;
  const clientId=options.clientId??(dual?"yummyai-web":"yummyai-factory"),callbackPath=options.application==="erp"||dual?"/api/erp-auth/callback":"/api/factory-auth/callback",accounts:Record<string,{subject:string;name:string;tenantId?:string}>={...factoryFixtureAccounts,...options.accounts};
  const clients=new Map([[clientId,{origin:portalOrigin,redirect:`${portalOrigin}${callbackPath}`}]]);
  if(dual){
    let factoryOrigin:URL;
    try{factoryOrigin=new URL(process.env.FACTORY_QUANTITY_FACTORY_ORIGIN!);}catch{throw new Error("Invalid dual factory fixture origin");}
    if(portalOrigin!=="http://localhost:3130"||clientId!=="yummyai-web"||options.application==="factory"||
      factoryOrigin.protocol!=="http:"||!["localhost","127.0.0.1"].includes(factoryOrigin.hostname)||
      factoryOrigin.origin!==process.env.FACTORY_QUANTITY_FACTORY_ORIGIN||factoryOrigin.username||factoryOrigin.password||
      factoryOrigin.search||factoryOrigin.hash||!factoryOrigin.port||
      [3000,8000,8001,4177,3130,3132,8130].includes(Number(factoryOrigin.port)))throw new Error("Invalid dual factory fixture origin");
    clients.set("yummyai-factory",{origin:factoryOrigin.origin,redirect:`${factoryOrigin.origin}/api/factory-auth/callback`});
  }
  const { privateKey, publicKey } = await generateKeyPair("RS256"),
    jwk = { ...(await exportJWK(publicKey)), kid: "factory-fixture", alg: "RS256", use: "sig" },
    controlKey = randomBytes(32).toString("base64url");
  const flows = new Map<
      string,
      { state: string; nonce: string; challenge: string; redirect: string; clientId:string }
    >(),
    codes = new Map<
      string,
      { subject: string; nonce: string; challenge: string; redirect: string; clientId:string; at: number }
    >(),
    refreshes = new Map<string, {subject:string;clientId:string}>();
  const clientProofs=new Map([...clients.keys()].map(id=>[id,{authorizationRequests:0,codeExchanges:0,refreshExchanges:0}]));
  const proof = {
    authorizationRequests: 0,
    codeExchanges: 0,
    refreshExchanges: 0,
    replayedCodes: 0,
    replayedRefreshes: 0,
    invalidPkce: 0,
  };
  let baseUrl = "",
    accessSeconds = 300,
    refreshDelay = 0;
  const opaque = () => randomBytes(32).toString("base64url");
  const proofSnapshot=()=>({...proof,...(dual?{clients:Object.fromEntries([...clientProofs].map(([id,counts])=>[id,{...counts}]))}:{})});
  async function access(subject: string, client = clientId, seconds = accessSeconds) {
    return new SignJWT({ tenant_id: Object.values(accounts).find(account=>account.subject===subject)?.tenantId??tenantId, azp: client })
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
      .setIssuer(baseUrl)
      .setAudience("yummyai-api")
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + seconds)
      .sign(privateKey);
  }
  async function tokens(subject: string, nonce?: string, issuingClient=clientId) {
    const refresh = opaque();
    refreshes.set(refresh, {subject,clientId:issuingClient});
    return {
      token_type: "Bearer",
      expires_in: accessSeconds,
      access_token: await access(subject,issuingClient),
      refresh_token: refresh,
      ...(nonce
        ? {
            id_token: await new SignJWT({ nonce })
              .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
              .setIssuer(baseUrl)
              .setAudience(issuingClient)
              .setSubject(subject)
              .setIssuedAt()
              .setExpirationTime("5m")
              .sign(privateKey),
          }
        : {}),
    };
  }
  const json = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(value));
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", baseUrl);
      if (url.pathname === "/protocol/openid-connect/certs") {
        json(response, 200, { keys: [jwk] });
        return;
      }
      if (url.pathname === "/protocol/openid-connect/auth" && request.method === "GET") {
        const p = url.searchParams,requestedClient=p.get("client_id")??"",client=clients.get(requestedClient);
        if (
          !client ||
          p.get("response_type") !== "code" ||
          p.get("code_challenge_method") !== "S256" ||
          p.get("redirect_uri") !== client.redirect ||
          !["state", "nonce", "code_challenge"].every((k) =>
            /^[A-Za-z0-9_-]{32,128}$/.test(p.get(k) ?? ""),
          )
        ) {
          json(response, 400, { error: "invalid_fixture_authorization" });
          return;
        }
        const id = opaque();
        flows.set(id, {
          state: p.get("state")!,
          nonce: p.get("nonce")!,
          challenge: p.get("code_challenge")!,
          redirect: p.get("redirect_uri")!,
          clientId:requestedClient,
        });
        proof.authorizationRequests++;
        clientProofs.get(requestedClient)!.authorizationRequests++;
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy":
            `default-src 'none'; form-action 'self' ${client.origin}; frame-ancestors 'none'`,
        });
        response.end(
          `<html lang="en"><title>Synthetic identity fixture</title><body><h1>Synthetic identity fixture</h1><form method="post" action="/fixture-login"><input type="hidden" name="flow" value="${id}"><label>Test account<select name="account">${Object.entries(
            accounts,
          )
            .map(([key, value]) => `<option value="${key}">${value.name}</option>`)
            .join(
              "",
            )}</select></label><button>Continue synthetic login</button></form></body></html>`,
        );
        return;
      }
      if (url.pathname === "/fixture-login" && request.method === "POST") {
        const p = await body(request),
          flow = flows.get(p.get("flow") ?? ""),
          account = accounts[p.get("account")??""];
        flows.delete(p.get("flow") ?? "");
        if (!flow || !account) {
          json(response, 400, { error: "invalid_fixture_login" });
          return;
        }
        const code = opaque();
        codes.set(code, {
          subject: account.subject,
          nonce: flow.nonce,
          challenge: flow.challenge,
          redirect: flow.redirect,
          clientId:flow.clientId,
          at: Date.now(),
        });
        const destination = new URL(flow.redirect);
        destination.searchParams.set("code", code);
        destination.searchParams.set("state", flow.state);
        destination.searchParams.set("iss", baseUrl);
        response.writeHead(303, { location: destination.href, "cache-control": "no-store" });
        response.end();
        return;
      }
      if (url.pathname === "/protocol/openid-connect/token" && request.method === "POST") {
        const p = await body(request),requestedClient=p.get("client_id")??"";
        if (!clients.has(requestedClient)) {
          json(response, 400, { error: "invalid_client" });
          return;
        }
        if (p.get("grant_type") === "authorization_code") {
          const record = codes.get(p.get("code") ?? "");
          codes.delete(p.get("code") ?? "");
          if (!record || Date.now() - record.at > 60000) {
            proof.replayedCodes++;
            json(response, 400, { error: "invalid_grant" });
            return;
          }
          if (
            record.clientId!==requestedClient || record.redirect !== p.get("redirect_uri") ||
            record.challenge !==
              createHash("sha256")
                .update(p.get("code_verifier") ?? "")
                .digest("base64url")
          ) {
            proof.invalidPkce++;
            json(response, 400, { error: "invalid_grant" });
            return;
          }
          proof.codeExchanges++;
          clientProofs.get(requestedClient)!.codeExchanges++;
          json(response, 200, await tokens(record.subject, record.nonce,requestedClient));
          return;
        }
        if (p.get("grant_type") === "refresh_token") {
          const saved = refreshes.get(p.get("refresh_token") ?? "");
          refreshes.delete(p.get("refresh_token") ?? "");
          if (!saved||saved.clientId!==requestedClient) {
            proof.replayedRefreshes++;
            json(response, 400, { error: "invalid_grant" });
            return;
          }
          proof.refreshExchanges++;
          clientProofs.get(requestedClient)!.refreshExchanges++;
          if (refreshDelay) await new Promise((resolve) => setTimeout(resolve, refreshDelay));
          json(response, 200, await tokens(saved.subject,undefined,requestedClient));
          return;
        }
        json(response, 400, { error: "unsupported_grant_type" });
        return;
      }
      if (
        url.pathname.startsWith("/_fixture/") &&
        request.headers["x-fixture-control"] === controlKey
      ) {
        if (url.pathname === "/_fixture/proof") {
          json(response, 200, proofSnapshot());
          return;
        }
        const p = await body(request);
        if (url.pathname === "/_fixture/configure") {
          accessSeconds = p.get("accessSeconds")
            ? Math.max(1, Math.min(300, Number(p.get("accessSeconds"))))
            : accessSeconds;
          refreshDelay = p.get("refreshDelay")
            ? Math.max(0, Math.min(10000, Number(p.get("refreshDelay"))))
            : 0;
          json(response, 200, { configured: true });
          return;
        }
        const account =
          accounts[p.get("account")??""];
        if (url.pathname === "/_fixture/token" && account) {
          const requestedClient=p.get("client_id")??clientId;
          if(!clients.has(requestedClient)){json(response,400,{error:"invalid_client"});return;}
          json(response, 200, { access_token: await access(account.subject,requestedClient) });
          return;
        }
      }
      json(response, 404, { error: "fixture_not_found" });
    } catch {
      json(response, 500, { error: "fixture_transport_failed" });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Fixture identity address missing");
  baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    controlKey,
    operatorToken: () => access(operatorSubject, "synthetic-operator", 3600),
    proof: proofSnapshot,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      flows.clear();
      codes.clear();
      refreshes.clear();
    },
  };
}
async function body(request: import("node:http").IncomingMessage) {
  let text = "";
  for await (const chunk of request) {
    text += chunk.toString("utf8");
    if (Buffer.byteLength(text) > 16384) throw Error("Fixture input too large");
  }
  return new URLSearchParams(text);
}
