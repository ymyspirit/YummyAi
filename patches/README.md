# PostgreSQL connection-close correction

`postgres@3.4.9.patch` is a local, reviewed backport for the installed 3.4.9 release.
It covers ESM and CJS. No package version, API, retry policy or business approval
is changed. The initial isolated crash/restart run reproduced an uncaught null
socket write in both the API and acceptance process.

The correction follows upstream proposals [1209](https://github.com/porsager/postgres/pull/1209)
and [1215](https://github.com/porsager/postgres/pull/1215): reject pending writes
after socket closure, clear the old connection state, reject queued transaction
queries and reject later work from a transaction after its connection is reused.
These proposals were open when checked on 2026-10-20; this is not a claim of an
upstream release or maintainer acceptance.

Install with the pinned pnpm 11.10.x workflow. `pnpm-workspace.yaml` registers the
exact version and `pnpm-lock.yaml` pins the patch hash. Preserve these files and
the patch together. Never edit installed node_modules or swallow process-wide
uncaught exceptions to simulate recovery. Transactions interrupted by database
loss reject; an operator resumes the original production intent explicitly.

Run the isolated acceptance through `tools/testing/run-production-command-restart.mts`.
It verifies both module formats against a real disposable PostgreSQL connection,
including rejection of stale transaction work after pool reuse, then exercises
the real authenticated API across process kills and container crashes. Ordinary
business databases and Worker queues are outside this test. Upgrade source
fingerprints and fresh Web candidates include patch bytes; existing candidates
are preserved and do not become a new validated build automatically.
