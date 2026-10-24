# Store API node identity

This node only enrolls a local identity and sends mTLS heartbeats. Marketplace
operations are `not_integrated`.

Use Node 24 and the workspace's installed `tsx`:

```
node --import tsx apps/store-api-node/src/main.ts init --dir=D:\private-node
node --import tsx apps/store-api-node/src/main.ts enroll --dir=D:\private-node --bundle=D:\private-ticket.json
node --import tsx apps/store-api-node/src/main.ts run --dir=D:\private-node --interval-ms=10000
```

Supply `STORE_NODE_KEY_PASSPHRASE` in the child process environment, never in
arguments. The passphrase must contain at least 16 UTF-8 bytes. The one-use
bundle is obtained by the authorized operator through the ERP. Keep it private.
An unknown enrollment response requires operator recovery or explicit reissue;
the CLI never silently registers another identity.

The Windows-only private directory rejects junctions and uses a protected DACL
for the current user and SYSTEM. `private-key.pem` is AES-encrypted PKCS8;
`public-key.pem` is the public enrollment key. `state.pe` is authenticated
AES-GCM ciphertext containing the enrolled certificate, fixed runtime origin,
and pending/acknowledged original heartbeat. The OS lock holder performs atomic
ciphertext replacements. `node.lock` is a reusable OS lock file; its presence
does not indicate a running process.

After a lost heartbeat response or process restart, the exact pending session
and sequence are replayed. A verified reply alone advances the persisted
sequence. A 409 requires explicit operator recovery/reissue. SIGINT/SIGTERM
abort the current read and release the local OS lock. Offline nodes execute no
platform operations. Re-enrollment requires a newer certificate generation for
the same node and account. No API URL, CA, token, or operation is accepted from
a heartbeat response.
