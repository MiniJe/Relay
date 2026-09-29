# RLY-PV-RFC-001 — Relay × PicoVolt integration

**Author:** Agent A5 · **Date:** 2026-09-29 · **Status:** evaluation complete; no production integration proposed

## Decision

**PicoVolt should not replace PostgreSQL in Relay.** This includes the ordinary
single-node/self-hosted deployment. Relay's current correctness contract depends
on relational constraints, PostgreSQL transactions and concurrent worker claims
that PicoVolt does not implement with compatible semantics or SQL.

PicoVolt has a credible, narrower role: a **bounded offline incident-summary
archive that can be queried without a database server**, particularly when the
same artifact needs a WASM reader and repeated ranked text retrieval. An isolated
proof of concept demonstrates that role. It is optional experimental tooling,
not a product commitment or a production export endpoint. Plain JSON is the
better default for simple snapshots; SQLite deserves preference for a native-only
queryable archive unless a measured PicoVolt-specific requirement wins.

Do not add a second live database, dual writes, a PicoVolt HTTP service, a
PostgreSQL replacement adapter, or a custom replication system to make these
projects appear integrated. Shared ownership does not reduce those costs.

## Evidence scope and versions

Relay was inspected at `b829cfb2dc6a16ce93111010604bb308907a719a`, including
the on-call, escalation and durable-delivery implementation. Existing local
documentation/version edits and qualification artifacts were present when this
task began and were left untouched. The analysis follows runtime code and the
three shipped migrations, rather than assuming every local release label agrees.
The shared checkout subsequently advanced to
`ea0d6b7d779eaec68292901d5dba2afde399d7af` during the evaluation; the database
and API implementations inspected here were unchanged by that advance.

The local PicoVolt checkout was at `b13ab962aad21f003e1ae37a70b963876c9b72f4`
(2.2). Its GitHub HEAD was fetched and inspected at
`d72133ac0c61d852efb964beb988111f7757ac97` without changing its checkout.
**Published PicoVolt 2.3.0**, not the stale local installation of 1.7 in a starter,
was installed in the experiment. The release tag is
`089090bab62e47d5fde046d608094ebc7e8532dd`; npm's registry integrity matched
the upstream release ledger and is pinned in the experiment lockfile.

This distinction materially changes the search assessment: **2.3 has named,
persisted retrieval indexes**. Older 2.1/2.2 statements that every request must
rebuild the index describe the legacy unnamed path, not all current retrieval.
Likewise, the 2.0 concurrency guide's old statement that encryption is absent
does not supersede the 2.2 native vault implementation. Native HEAD also has a
post-release vault-lock cleanup fix; this experiment did not exercise native
encryption. See [P1–P7](#picovolt-evidence).

Evidence levels used below:

- **Observed here:** published npm execution, compatibility probes, synthetic
  measurements, archive reopening and negative tests.
- **Source/documented:** inspected implementations, contracts and upstream test
  code/release evidence. Native crash, encryption and concurrency suites were
  not rerun here; their results are not represented as our measurements.
- **Proposed:** future export/publication/authorization work. None is assumed to
  exist in Relay merely because an engine can store bytes.

## What Relay actually needs

The primary workload is transactional incident operations, not an analytical
dataset: authentication and sessions; tenant-scoped service/component and on-call
configuration; incident lifecycle, updates and timeline; idempotent alert intake;
immutable routing decisions; notification attempts; escalation and acknowledgement.

`PostgresStore` uses a pool of up to **10** connections. Intake atomically creates
an alert and its initial routing record, while unique keys resolve duplicate
external IDs. Acknowledgement locks the routing row. Escalation locks that row
before the job so it can observe acknowledgement before scheduling further
delivery. Workers claim rows using `FOR UPDATE SKIP LOCKED`, stamp leases and
reject stale ownership; provider network calls occur outside transactions.
The default worker polls every **15 seconds**, claims **20** at a time and uses
**120-second** leases, with request-path post-commit kicks. These are configured
defaults, not measured throughput or capacity limits. [R1–R4]

Human incident edits may be infrequent, but alert bursts, worker retries, intake
requests, session writes and operator acknowledgement overlap even on one host.
Correctness under that overlap matters more than a fast single-threaded insert.
There is no supplied production traffic trace, database-size distribution,
retention policy, RPO/RTO or search relevance corpus. This RFC makes no claim
that Relay currently requires a particular QPS or that it has outgrown PostgreSQL.

Public status is a different workload: a small read projection, currently served
with `Cache-Control: public, max-age=15`, including active incidents and up to 20
recent resolved incidents. Private updates are explicitly filtered. Relay's SSE
hub is an in-process `EventEmitter`, not a durable change log. [R5]

## Scenario decisions

| Scenario | Decision | Evidence and practical consequence |
| --- | --- | --- |
| **1. Primary transactional server datastore** | **Reject** | Composite tenant foreign keys, uniqueness, relational checks, multi-column updates, JSONB, `RETURNING`, row locks and worker claim SQL would require redesign. Ten representative PostgreSQL constructs failed executable compatibility probes. Single-writer scheduling is not a replacement for the current database contract. Keep PostgreSQL. |
| **2. Single-node/self-hosted installations** | **Reject as the normal store** | One machine still runs concurrent HTTP requests and the delivery worker. Removing the PostgreSQL container would introduce a store rewrite, Node persistence ownership, migration and recovery support. Current Compose already supplies PostgreSQL with a persistent volume. If installation burden becomes a demonstrated blocker, assess a separate embedded edition, including SQLite and all existing store/concurrency contracts; PicoVolt has not earned that choice. |
| **3. Read-only public status snapshots** | **Reject PicoVolt by default; support the snapshot idea independently** | JSON/static HTML plus object storage/CDN caching is enough for today's projection and avoids downloading a query engine. Our simple JSON projection was smaller and faster to open. An independent static publisher could improve outage availability, but that benefit comes from publication and hosting, not PicoVolt. Only reconsider for a substantial client-queryable public history dataset. |
| **4. Edge/local replicas** | **Reject live/writable replication; conditional immutable copies** | PicoVolt change records are physical PicoVolt pages/manifests/blobs, not PostgreSQL WAL or Relay domain events. There is no automatic PostgreSQL-to-PicoVolt replication, consensus, conflict resolution or failover. A verified, versioned, read-only projection can be downloaded at the edge, but call it a stale-able snapshot. Prefer JSON for status data. |
| **5. Incident export/archive bundles** | **Appropriate bounded experiment** | One portable image can retain ordinary SQL and named text indexes for repeated offline queries. The implemented POC exports summaries and public update text into a fresh image, not a complete incident/evidence archive. Keep a portable JSON source export alongside any eventual archival product. Do not make `.pvdb` the sole long-term copy. |
| **6. Offline operator tooling** | **Appropriate read-only consumer of scenario 5** | Search and inspect already-authorized exports with no server. The POC reads a real file in a separate Node process. No offline acknowledgement, incident mutation, queued paging or write-back: those require identity, conflict and idempotency protocols absent here. Native-only tooling should compare SQLite first. |
| **7. Durable local cache or disaster-recovery artifacts** | **Conditional rebuildable cache; reject as authoritative DR** | A published image can preserve a last-known incident view. It cannot restore users, memberships, alerts, leases, attempts and the rest of PostgreSQL from our projection. Keep PostgreSQL backups/PITR and restore drills. Never replay historical delivery rows as new work. A cache on the same lost host provides no disaster independence. |
| **8. Embedded/demo installations** | **Conditional static/offline demo; reject a new default runtime** | PicoVolt/WASM can carry a fixture and interactive query examples without a server. Relay already has explicit `RELAY_STORE=memory` for deterministic verification and seed data for PostgreSQL. A static artifact demo is useful only when browsing/searching persisted data is the demo goal; it does not demonstrate Relay's worker/auth/durability contract. No second demo integration was built. |
| **9. Search/retrieval over incident history** | **Conditional bounded offline search; defer live server adoption** | Persistent BM25 is substantially faster than PicoVolt's legacy rebuild path here, but 10,000 documents/index and 8 MiB indexed text are real limits. No relevance evaluation establishes a server-search win. Evaluate PostgreSQL full-text search for live history before creating a second authorization/index-freshness system. Exact vector/hybrid retrieval remains optional research, not a reason to migrate the source database. |

Scenarios 5 and 6 are one artifact lifecycle, so there is **one** proof of concept.
The conditional outcomes do not authorize adding integrations to the runtime.

## Capability comparison

| Dimension | PostgreSQL / current Relay | PicoVolt 2.3 | Assessment for Relay |
| --- | --- | --- | --- |
| Transactions and isolation | Multi-statement transactions, MVCC, row locks, constraints. Relay uses explicit transactions/locks; it does not request serializable isolation everywhere. | Native explicit write transaction owns the single writer. Errors/cancellation/drop abort it. Independent read transactions retain immutable images. WASM batches/transactions operate in memory; export is separate. | Atomic batches exist, but SQL compatibility and cross-row invariants still need an application rewrite. Do not conflate atomicity with identical isolation/constraints. |
| Single writer | Concurrent backend sessions; conflicts lock the relevant data. | One native coordinator, bounded FIFO admission; default 64 waiting operations. Independent live handles are not cache coherent. A filesystem lock prevents overlapping writes but does not make multiple coordinators safe. | A central writer is viable for an offline artifact builder. It serializes unrelated tenants/jobs in a server and adds admission/backpressure ownership. |
| Reader concurrency | Readers use MVCC without copying the entire database for every ordinary read. | Native read admission copies a full committed image, O(image size); existing admitted readers proceed alongside later writes. Admission/top-level queries wait behind an active writer. Defaults: 16 readers, 256 MiB per snapshot, separate worker/cache per reader. | Retain readers for repeated archive queries. Do not open a fresh shared snapshot per web request and assume cheap MVCC. Limits do not cap total RSS. |
| Failover | Streaming standbys and promotion are available; external orchestration/fencing still required. Relay's current Compose has a single PostgreSQL node, not automatic HA. | No distributed consensus, primary election or managed failover. Replication/publication are host-owned. | PicoVolt cannot improve primary failover without building a new distributed system. Static off-host artifacts can improve read availability only. |
| Crash recovery | WAL recovery; actual guarantees depend on storage, fsync and commit settings. | Logged native workspace journals original pages before overwrite; commit syncs data/manifest/change record and publishes by rename. Active journal recovery rolls back incomplete work. Unknown outcomes require reopen/reconciliation. | There is a substantive native recovery implementation, not just a file write. It is not the npm byte-export persistence contract. Upstream process-crash tests are not power-cut certification. |
| Durability | Standard durable commits under appropriate configuration; durability can be weakened by settings or dishonest hardware. | Legacy unlogged default `Fast` relies on OS cache. `Sync` and the native logged protocol have different guarantees. Windows lacks the same directory-fsync path as Unix. WASM state alone is not durable. | Specify interface, mode and filesystem in any claim. Benchmarking in-memory WASM does not qualify primary-store durability. |
| Schema/data migration | Three shipped transactional migrations and `schema_migrations`; populated upgrade contracts. | Out-of-place baked-format migration/backup/verification exists. It is not PostgreSQL schema translation. Named retrieval needs format 8 / 2.3-capable readers; ordinary opens need not upgrade old images. | Never run Relay migration SQL unchanged. Version the export schema separately; regenerate derived artifacts and retain old readers/portable exports when needed. |
| Backups | Logical dump, physical backup and WAL/PITR tooling. Current Compose volume alone is not a backup. | Baked immutable images; native verified checkpoint export returns its following change cursor. Live workspace backups must include the complete consistent workspace/log, or use a supported checkpoint/quiescence protocol. Native encrypted backup/restore also exists. | Checkpoint/bake is useful for PicoVolt-owned data. It cannot replace a backup of authoritative PostgreSQL state or capture a multi-query Relay export consistently by itself. |
| Operational complexity | Database service, disk monitoring, backups/upgrades; already in deployment and tests. | No daemon needed for embedded use, but writer lifecycle, queue limits, log retention, snapshot cost, native binaries/FFI, backup validation and keys become host responsibilities. | Simpler for an immutable artifact; not automatically simpler for the server. An HTTP sidecar brings back a service while losing compatibility. |
| Node interoperability | Async `postgres` 3.4.7 pool, `$n` parameters and transaction callbacks already integrated. | Published npm is synchronous WASM, `?` parameters, prepare/query/batch/retrieve and image bytes. Native `SharedDatabase` is Rust; C/Python/Go are separate surfaces. Native vault encryption is absent in WASM. | Do heavy offline queries in a dedicated process/worker in a product UI. `await` around a synchronous WASM call does not prevent event-loop blocking. A native addon/FFI or service is additional maintained infrastructure. |
| Query compatibility | Tenant joins, foreign keys, partial indexes, JSONB, timestamp/interval expressions, `RETURNING`, upserts and locks used today. | Useful focused SQL: `INNER`/`LEFT` equality joins, aggregate/filter/order queries, selected constraints/functions. Types are compatibility syntax, not equivalent static typing; no foreign keys or composite PK/unique constraints; one assignment per UPDATE. | Existing migrations and store cannot be reused with an import rename. Executable probes below confirm critical gaps. |
| Encrypted storage | Relay encrypts integration secrets at the application layer. PostgreSQL storage encryption requires an appropriate filesystem/device/service strategy; TLS is a separate transport protection. | Native snapshots/vaults use XChaCha20-Poly1305; password mode uses Argon2id. Vault transactions rebuild/encrypt the full image, capped at 256 MiB; single writer. Old backups retain old keys. No independent security audit claimed. | Potentially useful for bounded private archives via native tooling, but not tested by our Node POC. Pin keys/recovery custody and externally tracked versions; valid old ciphertext can otherwise be replayed. No plaintext/secret export becomes safe merely by choosing PicoVolt. |
| Change streams | Logical decoding/replication tools available; Relay has not implemented an export CDC pipeline. SSE is ephemeral. | Native physical ordered commit stream, exclusive cursors, explicit pruning, bounded history and at-least-once sink delivery. Pruned/missing history needs a verified base. Default limits include 64 MiB transaction journal, 256 MiB retained logs and 4,096 commits. | Not a PostgreSQL input connector. Consumer acknowledgements, deduplication, atomic data/cursor publication, retry and retention are application work. Never prune using the fastest consumer's cursor. |
| Licensing/distribution | Relay is MIT; PostgreSQL has its own permissive license. | Current distribution is mixed-license/source-available, including Public-Source License 1.1 components; historical Apache grants remain. | Keep PicoVolt optional and accurately described. Shared ownership does not make the complete dependency MIT or open source. See the distribution discussion below. |

Native transaction/concurrency/recovery claims above are grounded in
`src/concurrent.rs`, `src/journal.rs`, `src/storage/vle.rs`, `src/encryption.rs`,
their tests and contracts [P1–P4]. PostgreSQL comparison references are [G1–G7].

## SQL compatibility: measured rather than assumed

The benchmark runs each probe in a fresh PicoVolt 2.3 WASM database. All **10**
PostgreSQL-dependent probes were rejected, while the `?` SELECT control succeeded:

| Probe | Concrete Relay dependency |
| --- | --- |
| `DEFAULT now()` | Initial migration timestamps and numerous insert defaults |
| Table-level composite primary key | Organization membership identity |
| `REFERENCES` | Tenant-safe relationships and deletion behavior |
| `$1` parameter | Every PostgreSQL store query uses numbered parameters |
| `INSERT ... RETURNING *` | Store insert/result contract |
| `UPDATE ... SET a=..., b=...` | Lifecycle/configuration/lease updates |
| `FOR UPDATE SKIP LOCKED` | Concurrent delivery/escalation claims |
| `?::text::jsonb` | JSON values, metadata and channel/config payloads |
| `ON CONFLICT DO NOTHING` | Idempotent inserts and enqueue behavior |
| Join with two equality predicates | Tenant-qualified joins |

Exact queries and errors are retained in the
[measurement JSON](qualification/RLY-PV-RFC-001-benchmark.json). This is a targeted
compatibility check, not an exhaustive parser audit or an attempted migration.
Rewriting `$1` to `?` would address only the smallest gap. Recreating relational
and concurrency guarantees in JavaScript would need a new store implementation
and meaningful adversarial qualification, not just making the parser accept SQL.

## Measurements

Run on Windows `10.0.26200` x64, Intel Xeon Gold 6138, 40 exposed logical CPUs,
Node **24.21.0**, bundled SQLite **3.53.4**, published PicoVolt **2.3.0** WASM.
The benchmark generates 1,000 and 10,000 incidents for one synthetic tenant, four
severities, short public updates and deterministic IDs. No real private data is
read. This resembles a bounded summary archive, not full incident timelines,
alert history or realistic long postmortems.

Query timings use three warmups and 30 samples per operation. Read/open timings
use one warmup and ten samples. The process/OS caches are warm; no cache flushing
or CPU isolation was performed. Runs are sequential, not a throughput test.
All three representations contain the same projected rows and summary results
are asserted equal. PicoVolt named/ephemeral ranked results are also asserted
exactly equal before timing. JSON and SQLite do not contain the PicoVolt full-text
index; their sizes/timings compare basic archive use, not equal search feature sets.

### Representation and read costs

| Incidents | JSON bytes | PicoVolt without retrieval index | PicoVolt with text index | SQLite bytes |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 245,780 | 496,220 | 704,381 | 208,896 |
| 10,000 | 2,486,781 | 5,038,852 | 7,125,769 | 2,048,000 |

| Incidents / operation | JSON p50 ms | PicoVolt indexed p50 ms | SQLite p50 ms |
| --- | ---: | ---: | ---: |
| 1,000 / read and open | 2.919 | 40.177 | 1.521 |
| 10,000 / read and open | 15.381 | 449.507 | 2.721 |
| 1,000 / first 20 SEV1 summaries | 0.026 | 0.774 | 0.175 |
| 10,000 / first 20 SEV1 summaries | 0.255 | 7.356 | 0.181 |

PicoVolt opening includes reading the file, SHA-256 verification, byte import,
engine index/source validation and a count query. JSON includes file read/parse;
SQLite opens the file and forces a count. These are consumer costs for the
specified readers, not identical internal work. SQLite can lazily read data;
PicoVolt verifies/reconstructs named index state on open. The Node/WASM reader
does not establish native memory-mapped opening performance.

### PicoVolt repeated ranked search

Query: `database pool`, over all selected incident titles/public update text;
top ten results, no vectors, same open image.

| Incidents | Named index p50 / p95 ms | Ephemeral rebuild p50 / p95 ms |
| ---: | ---: | ---: |
| 1,000 | 1.530 / 1.756 | 9.642 / 10.514 |
| 10,000 | 16.342 / 18.418 | 120.637 / 134.646 |

Named search was approximately **7.4× faster at p50** for the 10,000-row fixture.
That establishes value over PicoVolt's own legacy path, **not superiority over
PostgreSQL full-text search, SQLite FTS5 or another search engine**. Those ranking
systems were not benchmarked. Their relevance/tokenization would need controlled
comparison rather than pretending an ordinary SQLite SELECT is an FTS benchmark.

PicoVolt indexed image build took 154 ms / 558 ms at 1,000 / 10,000 rows;
unindexed image build took 32 ms / 289 ms. These include projection and memory
construction/export but exclude output-file sync. Raw JSON build and SQLite
file/transaction timings are also recorded, with their different durability
boundaries explicitly described. They must not be used as a write-throughput
competition. Whole-process memory is recorded but not attributed to one engine.

**Interpretation:** there is useful offline query/search functionality, but no
size or ordinary-read advantage that justifies wrapping today's public status
JSON in PicoVolt. The 10,000-row artifact's roughly 450 ms opening also argues
for retaining one reader across a search session. No PostgreSQL server benchmark
was run: missing required semantics already decide the primary-store question,
and a synthetic throughput contest would not resolve it.

Reproduce with the [experiment commands](../experiments/picovolt-archive/README.md).
The raw JSON includes p95 values, point lookups, build costs, fixture hashes,
registry integrity, environment and probe errors. Measurements are observations
on this host, not service-level guarantees.

## Search and workload limits

PicoVolt 2.3 named indexes persist in CAS and are maintained transactionally with
source mutations. Opening verifies index/source agreement by rebuilding a
reference once. Current compatible SELECTs reuse decoded indexes; historical
`BEFORE` or transformed selections can fall back to the ephemeral path. Filtered
BM25 recomputes statistics over the selected authorized corpus, not globally
ranked results filtered afterward. [P5]

Key ceilings are **10,000 documents/index**, **100,000 retained source row
versions**, **8 MiB indexed text**, **64 KiB/document**, **16 MiB SELECT
materialization**, and **16 named indexes/database**. The 10,000 short-summary
fixture fits; 10,000 incidents each with several long updates may not. Splitting
into shards would introduce cross-shard ranking and lifecycle work, so is not
offered here as a loophole around the envelope. Relay's text incident IDs need a
stable signed-integer mapping for retrieval; POC IDs are stable within an image,
not an incremental cross-export identity scheme.

Full text uses lowercase Unicode alphanumeric terms, AND matching and BM25; no
stemming, phrase, fuzzy or prefix search is promised. Vector search is exhaustive
exact cosine or squared Euclidean, not ANN. Embeddings are supplied by the host,
with 4,096 dimensions / 4,194,304 scalar elements / 10,000 documents as relevant
bounds. Hybrid combines bounded ranked candidates. None of this provides an
embedding model, representative relevance judgments or automatic tenant policy.

Changed persistent index generations can encode an entire affected index and
leave older CAS generations unreachable without automatic reclamation. That
tradeoff is better suited to batch-built archives than a frequently rewritten
live alert corpus. For live search, start with an authorized PostgreSQL text
projection and measure relevance, update/delete latency and operational burden.
Promote a PicoVolt option only if real requirements exceed that simpler path.

## The isolated proof of concept

Location: [`experiments/picovolt-archive`](../experiments/picovolt-archive/README.md).
The directory and this RFC's evidence were added; `.dockerignore` excludes the
experiment so its local dependency and demo outputs cannot enter the production
image through `COPY . .`. The root dependencies, PostgreSQL store, migrations,
server selection, workers, Dockerfile and Compose persistence configuration were
not changed. No background service, live data export or dual write exists.

The experiment builds a fresh in-memory database from an explicitly supplied
single-organization fixture/export. It allows only incident identity/title,
severity/lifecycle/start time and explicitly public update messages. It omits
internal timeline, responders, sessions, integration credentials and private
updates. **This is still private operator data**, since a title or incident need
not belong to any public status page. It does not reuse or replace Relay's public
status authorization/projection logic.

Fresh construction matters: deleting private rows from an existing PicoVolt
database and baking it could retain historical versions. A filtered current-row
export into a new database is the required boundary for any shareable artifact.

The image carries a persisted full-text index and an external manifest with
schema/engine version, organization, export time, count, bytes and SHA-256.
Files are created exclusively and synced individually; the manifest is written
last. Existing destinations cannot be overwritten, and incomplete or mismatched
bundles fail to open. The public reader wrapper exposes fixed list/search
operations, even though the underlying WASM byte-import handle is writable in
memory. SHA-256 detects accidental damage, not replacement by an attacker who
can also replace the manifest. There is no encryption/signature in this POC.

Verification completed locally:

- **4 focused tests passed:** independent-process reopening and field exclusion;
  tenant, ID, schema and size rejection; partial/tampered/incompatible bundles
  and truncated engine images; duplicate-key batch rollback without partial rows.
- **Demo passed:** 1,000 incidents exported, reopened and searched from disk.
- **Benchmark completed:** both corpus sizes, result equivalence assertions and
  all compatibility probes; raw evidence retained.

This is not a native journal crash/power-cut test, browser qualification, native
encryption test, or PostgreSQL restore test. No claim is made that the POC is a
complete incident export or production-grade parser sandbox. Existing Relay
PostgreSQL contract/worker tests were inspected, not rerun against production;
the experiment neither connects to nor changes a running Relay database.

## What a future artifact feature would still require

1. **Consistent, authorized extraction.** Authenticate the operator, verify
   organization/role scope, and read all selected entities in one appropriate
   PostgreSQL read-only snapshot. Avoid pagination across independently changing
   snapshots. Record export schema, scope, source revision and a proven snapshot
   boundary. A wall-clock `exportedAt` alone is not one. A private full incident
   export would need an explicit field policy and its own tests.
2. **Independent publication and freshness.** Build and validate a new image,
   upload under an immutable version, then publish its manifest/pointer only
   after the complete artifact is available. Record source time and show age.
   For public status, a candidate policy is a 15-second publication target and
   a visible stale state after 60 seconds; these are proposed values needing an
   operational SLA, not existing guarantees. An old healthy view must not be
   silently presented as live. Retain the last verified image when a new one
   fails, while displaying staleness.
3. **Revocation and redaction.** Never distribute tenant-private artifacts through
   a public CDN. Sign/verify provenance where untrusted transfer matters; encrypt
   private archives through qualified tooling with separate recoverable keys.
   Rebuild on redaction/deletion, expire cached copies and revoke access. Copies
   already downloaded cannot be recalled. A database change stream alone does
   not solve that policy.
4. **Incremental work only if justified.** Full rebuilds are preferable while
   small. If they become expensive, use an explicit PostgreSQL export outbox or
   evaluated CDC path with ordering, tombstones, idempotency, checkpoint recovery
   and lag monitoring. Do not subscribe to SSE and assume no events were lost.
   Physical PicoVolt changes apply only after a matching PicoVolt base exists;
   they do not ingest PostgreSQL mutations.
5. **Recovery and compatibility.** Keep portable source exports and tested
   PostgreSQL backups independently. Pin artifact/reader versions, verify an
   upgrade on retained fixtures, test restoration on a new host, and regenerate
   derived indexes rather than turning failed artifacts into a new source of
   truth. Define RPO/RTO before calling anything DR. Never promote an offline
   artifact into an active notification queue.
6. **Product selection gate.** Test real de-identified histories, long text,
   projected growth, offline browser/Node support, relevance and launch latency;
   compare JSON/SQLite and PostgreSQL search fairly. Budget cold verification,
   image/index growth and memory. Only then decide whether supporting this format
   provides enough value to carry another engine and its distribution terms.

## Licensing and distribution

PicoVolt 2.3 is source-available, not wholly open source. Its release ledger and
component scope apply Public-Source License 1.1 to newer covered components while
preserving historical Apache-2.0 and dependency notices. The stated permissions
include application embedding/operation and unchanged official redistribution;
restrictions cover competing standalone database products and certain modified
source distribution. This is the project's stated grant, not independent legal
clearance. [P6]

An optional Relay archive reader appears aligned with application embedding,
but distribution must retain the relevant licenses/notices and accurately label
the dependency. Relay's independent MIT code does not relicense PicoVolt. A
mandatory dependency would change the practical all-open-source distribution
story even if application embedding is permitted. No fee, account, activation or
telemetry is required by the stated release terms. Do not substitute a common
owner for a reproducible dependency/version/license policy. This POC pins a
registry dependency and vendors no engine source or binaries.

## Evidence index

### Relay evidence

- **R1:** [`postgres-store.mjs`](../packages/database/postgres-store.mjs):
  `createPostgresStore`, `migratePostgres`, `ingestAlert`, `acknowledgeAlertRouting`,
  delivery/escalation claims, `completeEscalationJob`; atomic writes, numbered SQL
  parameters, locks, conflict handling and tenant joins.
- **R2:** [initial schema](../packages/database/migrations/001_initial.sql),
  [routing/on-call migration](../packages/database/migrations/002_alert_routing_oncall.sql),
  [escalation/delivery migration](../packages/database/migrations/003_escalation_delivery.sql):
  relational and tenant constraints, JSONB, indexes and lease/attempt schema.
- **R3:** [`worker.mjs`](../apps/api/src/worker.mjs),
  [`config.mjs`](../apps/api/src/config.mjs),
  [`delivery.mjs`](../apps/api/src/delivery.mjs): scheduling and provider boundaries.
- **R4:** [PostgreSQL contracts](../tests/postgres.contract.test.mjs),
  [worker qualification](../tests/worker.qualification.test.mjs),
  [migration-upgrade contracts](../tests/migration-upgrade.test.mjs).
- **R5:** [`app.mjs`](../apps/api/src/app.mjs): `publicIncident` and public status
  routes; [`sse.mjs`](../apps/api/src/sse.mjs),
  [`server.mjs`](../apps/api/src/server.mjs),
  [`docker-compose.yml`](../docker-compose.yml).
- **R6:** [raw local measurements](qualification/RLY-PV-RFC-001-benchmark.json),
  [benchmark source](../experiments/picovolt-archive/benchmark.mjs),
  [archive tests](../experiments/picovolt-archive/archive.test.mjs).

### PicoVolt evidence

Links are pinned to the inspected GitHub HEAD; published-package measurements
are pinned independently to npm 2.3.0 in the experiment lockfile.

- **P1:** [concurrency contract](https://github.com/MiniJe/picovolt/blob/d72133ac0c61d852efb964beb988111f7757ac97/docs/CONCURRENCY.md),
  [coordinator implementation](https://github.com/MiniJe/picovolt/blob/d72133ac0c61d852efb964beb988111f7757ac97/src/concurrent.rs).
- **P2:** [journal implementation](https://github.com/MiniJe/picovolt/blob/d72133ac0c61d852efb964beb988111f7757ac97/src/journal.rs),
  [format/recovery contract](https://github.com/MiniJe/picovolt/blob/d72133ac0c61d852efb964beb988111f7757ac97/docs/FORMAT.md),
  [crash tests](https://github.com/MiniJe/picovolt/blob/d72133ac0c61d852efb964beb988111f7757ac97/tests/crash_recovery.rs),
  [migration guide](https://github.com/MiniJe/picovolt/blob/d72133ac0c61d852efb964beb988111f7757ac97/docs/MIGRATION.md).
- **P3:** [SQL compatibility](https://github.com/MiniJe/picovolt/blob/d72133ac0c61d852efb964beb988111f7757ac97/docs/SQL.md),
  [JavaScript adapter](https://github.com/MiniJe/picovolt/blob/d72133ac0c61d852efb964beb988111f7757ac97/bindings/js/sqlite.js),
  [WASM API](https://github.com/MiniJe/picovolt/blob/d72133ac0c61d852efb964beb988111f7757ac97/src/wasm_api.rs),
  [interface guide](https://github.com/MiniJe/picovolt/blob/d72133ac0c61d852efb964beb988111f7757ac97/docs/QUICKSTART_2_0.md).
- **P4:** [encrypted storage contract](https://github.com/MiniJe/picovolt/blob/d72133ac0c61d852efb964beb988111f7757ac97/docs/ENCRYPTION_2_2.md),
  [encryption implementation](https://github.com/MiniJe/picovolt/blob/d72133ac0c61d852efb964beb988111f7757ac97/src/encryption.rs).
- **P5:** [persistent retrieval 2.3](https://github.com/MiniJe/picovolt/blob/d72133ac0c61d852efb964beb988111f7757ac97/docs/PERSISTENT_RETRIEVAL_2_3.md),
  [catalog implementation](https://github.com/MiniJe/picovolt/blob/d72133ac0c61d852efb964beb988111f7757ac97/src/db/persistent.rs),
  [retrieval implementation](https://github.com/MiniJe/picovolt/blob/d72133ac0c61d852efb964beb988111f7757ac97/src/retrieval.rs),
  [hybrid contract](https://github.com/MiniJe/picovolt/blob/d72133ac0c61d852efb964beb988111f7757ac97/docs/HYBRID_2_2.md).
- **P6:** [license](https://github.com/MiniJe/picovolt/blob/d72133ac0c61d852efb964beb988111f7757ac97/LICENSE),
  [public release record](https://github.com/MiniJe/picovolt/blob/d72133ac0c61d852efb964beb988111f7757ac97/legal/PUBLIC-RELEASE.json),
  [2.3 component scope](https://github.com/MiniJe/picovolt/blob/d72133ac0c61d852efb964beb988111f7757ac97/legal/COMPONENT-SCOPE-2.3.md).
- **P7:** [2.3 release/qualification ledger](https://github.com/MiniJe/picovolt/blob/d72133ac0c61d852efb964beb988111f7757ac97/docs/RELEASE_2_3.md),
  [published release](https://github.com/MiniJe/picovolt/releases/tag/v2.3.0).

### PostgreSQL primary references

- **G1:** [MVCC and concurrency](https://www.postgresql.org/docs/16/mvcc-intro.html).
- **G2:** [Backup/restore approaches](https://www.postgresql.org/docs/16/backup.html).
- **G3:** [Standbys, replication and promotion](https://www.postgresql.org/docs/16/warm-standby.html).
- **G4:** [WAL/storage reliability](https://www.postgresql.org/docs/16/wal-reliability.html).
- **G5:** [Encryption options](https://www.postgresql.org/docs/16/encryption-options.html).
- **G6:** [Full-text search](https://www.postgresql.org/docs/16/textsearch.html).
- **G7:** [Logical decoding](https://www.postgresql.org/docs/16/logicaldecoding-explanation.html).
