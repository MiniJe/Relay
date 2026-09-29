# Offline incident archive experiment — RLY-PV-RFC-001

This optional proof of concept tests an appropriate PicoVolt boundary: a bounded,
disposable, locally queryable incident-summary artifact. It is not a Relay store,
a backup, an authorization service, or a production export feature. Nothing in
Relay imports it. Installation is local to this directory; the root manifest,
lockfile, migrations and startup are unchanged. `.dockerignore` excludes this
directory so Docker's repository copy cannot ship its local dependency or output.

```powershell
cd E:\Relay\experiments\picovolt-archive
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run demo
npm run benchmark -- ../../docs/qualification/RLY-PV-RFC-001-benchmark.json
```

Node 22.12+ is the upstream starter minimum; this experiment was executed on
Node **24.21.0**. The benchmark additionally needs `node:sqlite`. PicoVolt is pinned
to **2.3.0**, including registry integrity in the experiment's own lockfile. Node
currently prints an experimental WASM module warning. Installation needs registry
access; tests, demo and benchmarks use synthetic data and run entirely offline.

`demo.mjs` creates a new directory under ignored `output/`, writes
`incidents.pvdb` and `manifest.json`, reopens it and searches `database pool`.
`archive.mjs` exposes `writeBundle(directory, input)` and `openBundle(directory)`.
Its input contract is illustrated by `fixture.mjs`: schema version, organization,
export time, and incidents with IDs, titles, severity, lifecycle, start time and
updates. Only explicitly public update messages enter the projection. Every
incident must have the same organization and a unique incident ID. An artifact
local integer ID maps back to the original Relay ID for retrieval.

The caller must already be authorized to read/export all supplied incidents.
Tenant labels do not grant permission. **The artifact is private operator data:**
incident titles and other fields can be private even when updates are filtered.
This is not Relay's public status-page projection. No incident timeline,
responders, integration secrets, sessions or internal update bodies are copied.
A fresh database avoids accidentally carrying deleted/private MVCC history.

Limits are 10,000 incidents, 8 MiB indexed text, 64 KiB combined title/body per
incident and 32 MiB image. The interface exposes fixed read queries, not arbitrary
SQL. The underlying WASM byte-import API is writable in memory; this wrapper's
read-only interface is not a security sandbox for hostile files or processes.

Files use exclusive creation and are individually synced, with the manifest
written last. Existing destinations are refused; partial bundles fail to open.
The checksum detects accidental corruption, **not malicious replacement** of
both files. There is no signing, encryption, key custody, stale-image prevention,
directory durability guarantee, or power-loss qualification. The file manifest
does not prove a PostgreSQL snapshot boundary. Keep authoritative backups and
portable source exports; rebuild this derived artifact when it is lost.

Tests cover separate-process reopening, private-field exclusion, tenant/duplicate
rejection, size limits, corruption, unsupported versions, partial publication,
no-clobber and atomic batch rollback. Synthetic fixtures do not establish real
incident-search relevance. Test/benchmark scratch files live in newly created OS
temporary directories; the demo remains under `output/` for inspection.

The benchmark checks identical summary query results across JSON, PicoVolt and
SQLite and identical ranked results between PicoVolt's named and ephemeral
full-text paths. It records distributions, artifact size, opening/build costs,
SQL compatibility probes and environment in JSON. It is not a PostgreSQL or
durable-write throughput benchmark. All engines are in one process; RSS cannot
be attributed to PicoVolt alone. See the [RFC](../../docs/RFC-PICOVOLT-INTEGRATION.md)
for decisions, evidence and the work required before any product integration.

PicoVolt 2.3 contains source-available proprietary components under Public-Source
License 1.1 alongside historically Apache-licensed components. Relay's independent
experiment code retains Relay's license; that does not relicense its dependency.
The installed package carries its own LICENSE/NOTICE. No PicoVolt binaries or
source are vendored in Relay.
