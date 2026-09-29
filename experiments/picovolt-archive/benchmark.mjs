import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { cpus, platform, release, arch, tmpdir } from 'node:os';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Db } from 'picovolt';
import { fixture } from './fixture.mjs';
import { buildImage, project, sha256 } from './archive.mjs';

const repeats = 30;
function measure(fn, n = repeats) {
  for (let i = 0; i < 3; i++) fn();
  const samples = [];
  for (let i = 0; i < n; i++) { const start = performance.now(); fn(); samples.push(performance.now() - start); }
  samples.sort((a, b) => a - b);
  return { n, p50Ms: samples[Math.ceil(n * .50) - 1], p95Ms: samples[Math.ceil(n * .95) - 1] };
}
async function measureAsync(fn, n = 10) {
  await fn();
  const samples = [];
  for (let i = 0; i < n; i++) { const start = performance.now(); await fn(); samples.push(performance.now() - start); }
  samples.sort((a, b) => a - b);
  return { n, p50Ms: samples[Math.ceil(n * .50) - 1], p95Ms: samples[Math.ceil(n * .95) - 1] };
}

const root = await mkdtemp(join(tmpdir(), 'relay-pv-benchmark-'));
const report = {
  mandate: 'RLY-PV-RFC-001', measuredAt: new Date().toISOString(),
  host: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0].model, logicalCpus: cpus().length, node: process.version, sqlite: process.versions.sqlite },
  picovolt: { version: '2.3.0', integrity: 'sha512-TcqrOa5Uddyx9ilV71jHu2ciknVV6gYEfOgYomrHfp8X4Aslcy52Dp9rOHog8+Y+5Cw5Jyxwfs7h4ZpsmsTTEg==' },
  method: 'Deterministic synthetic incidents, one tenant, four severities, short repeated public updates. Sequential single-process warm runs; 3 warmups/30 query samples, 1 warmup/10 read-and-open samples. Same projected rows; no network or server. Open includes file read; PicoVolt includes SHA-256 and engine source/index validation, JSON includes parse, SQLite opens and forces COUNT. Build timings include projection but exclude file writes for JSON/PicoVolt; SQLite includes file creation and one FULL synchronous transaction. Build costs are descriptive, not equivalent durability comparisons. Process RSS includes all engines/corpora; not attributed. No cache flush, CPU isolation, power-cut, throughput, relevance or production-load claim.',
  workloads: [], compatibility: []
};

for (const count of [1000, 10000]) {
  const input = fixture(count);
  const projected = project(input);
  let start = performance.now();
  const json = JSON.stringify(project(input));
  const jsonBuildMs = performance.now() - start;
  start = performance.now(); const image = buildImage(input); const pvBuildMs = performance.now() - start;
  start = performance.now(); const plainImage = buildImage(input, { indexed: false }); const pvPlainBuildMs = performance.now() - start;
  const jsonPath = join(root, `${count}.json`), pvPath = join(root, `${count}.pvdb`), sqlitePath = join(root, `${count}.sqlite`);
  await writeFile(jsonPath, json); await writeFile(pvPath, image.bytes);
  start = performance.now();
  const sqlite = new DatabaseSync(sqlitePath);
  sqlite.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE incidents (id INTEGER PRIMARY KEY, incident_id TEXT UNIQUE, title TEXT, severity TEXT, status TEXT, started_at TEXT, body TEXT); BEGIN');
  const insert = sqlite.prepare('INSERT INTO incidents VALUES (?,?,?,?,?,?,?)');
  for (const row of projected.incidents) insert.run(...Object.values(row));
  sqlite.exec('COMMIT');
  const sqliteBuildMs = performance.now() - start;
  const db = Db.fromBytes(image.bytes);
  const querySql = 'SELECT incident_id,title,status FROM incidents WHERE severity=? ORDER BY id LIMIT 20';
  const pvQuery = () => JSON.parse(db.query(querySql, ['SEV1'])).rows;
  const sqliteQuery = sqlite.prepare(querySql);
  const sqQuery = () => sqliteQuery.all('SEV1').map((r) => Object.values(r));
  const jsonQuery = () => projected.incidents.filter((r) => r.severity === 'SEV1').slice(0, 20).map((r) => [r.incident_id, r.title, r.status]);
  assert.deepEqual(pvQuery(), jsonQuery()); assert.deepEqual(sqQuery(), jsonQuery());
  const searchRequest = { kind: 'full_text', sql: 'SELECT id,title,body FROM incidents', id_column: 'id', text_columns: ['title', 'body'], query: 'database pool', limit: 10 };
  const legacy = JSON.stringify(searchRequest), named = JSON.stringify({ ...searchRequest, index: 'incident_text' });
  assert.equal(db.retrieve(named), db.retrieve(legacy));
  const pointId = Math.floor(count / 2);
  const sqlitePoint = sqlite.prepare('SELECT title FROM incidents WHERE id=?');
  const record = {
    count, projectedSha256: sha256(json),
    bytes: { json: Buffer.byteLength(json), picoVoltPlain: plainImage.bytes.length, picoVoltIndexed: image.bytes.length, sqlite: (await stat(sqlitePath)).size },
    buildMs: { json: jsonBuildMs, picoVoltPlain: pvPlainBuildMs, picoVoltIndexed: pvBuildMs, sqlite: sqliteBuildMs },
    list: { json: measure(jsonQuery), picoVolt: measure(pvQuery), sqlite: measure(sqQuery) },
    point: {
      json: measure(() => projected.incidents.find((r) => r.id === pointId).title),
      picoVolt: measure(() => JSON.parse(db.query('SELECT title FROM incidents WHERE id=?', [pointId]))),
      sqlite: measure(() => sqlitePoint.get(pointId))
    },
    search: { named: measure(() => db.retrieve(named)), ephemeral: measure(() => db.retrieve(legacy)) },
    open: {
      json: await measureAsync(async () => { const p = JSON.parse(await readFile(jsonPath, 'utf8')); assert.equal(p.incidents.length, count); }),
      picoVolt: await measureAsync(async () => { const bytes = await readFile(pvPath); assert.equal(sha256(bytes), image.manifest.sha256); const d = Db.fromBytes(bytes); assert.equal(JSON.parse(d.query('SELECT COUNT(*) FROM incidents')).rows[0][0], count); d.free(); }),
      sqlite: await measureAsync(async () => { const s = new DatabaseSync(sqlitePath, { readOnly: true }); assert.equal(s.prepare('SELECT COUNT(*) AS n FROM incidents').get().n, count); s.close(); })
    }
  };
  db.free(); sqlite.close(); report.workloads.push(record);
  console.error(`Measured ${count} incidents`);
}

const probes = [
  ['timestamp default', 'CREATE TABLE users (id TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now())', []],
  ['composite primary key', 'CREATE TABLE memberships (organization_id TEXT, user_id TEXT, PRIMARY KEY (organization_id,user_id))', []],
  ['foreign key', 'CREATE TABLE children (id TEXT, parent_id TEXT REFERENCES t(id))', []],
  ['PostgreSQL placeholder', 'SELECT * FROM t WHERE id=$1', ['x']],
  ['RETURNING', "INSERT INTO t VALUES ('x','a','b') RETURNING *", []],
  ['multi-column update', "UPDATE t SET a='a',b='b' WHERE id='x'", []],
  ['SKIP LOCKED', 'SELECT id FROM t ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 10', []],
  ['JSONB cast', 'INSERT INTO t VALUES (?,?::text::jsonb,?)', ['x', '{}', 'b']],
  ['conflict clause', "INSERT INTO t VALUES ('x','a','b') ON CONFLICT DO NOTHING", []],
  ['composite join predicate', 'SELECT t.id FROM t JOIN u ON t.id=u.id AND t.a=u.a', []],
  ['question-mark SELECT control', 'SELECT id FROM t WHERE id=?', ['x']]
];
for (const [name, sql, params] of probes) {
  const db = new Db();
  try {
    db.query('CREATE TABLE t (id PRIMARY KEY,a,b)'); db.query('CREATE TABLE u (id,a)');
    try { db.query(sql, params); report.compatibility.push({ name, sql, accepted: true }); }
    catch (error) { report.compatibility.push({ name, sql, accepted: false, error: String(error) }); }
  } finally { db.free(); }
}
report.processMemoryEnd = process.memoryUsage();
const output = process.argv[2];
if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n');
else console.log(JSON.stringify(report, null, 2));
