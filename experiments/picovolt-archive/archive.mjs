// RLY-PV-RFC-001: optional, offline experiment; never imported by Relay runtime.
import { Db } from 'picovolt';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const query = (db, sql, params = []) => JSON.parse(db.query(sql, params));

function text(value, name, limit = 65536) {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > limit) throw new Error(`Invalid ${name}`);
  return value;
}

// The caller must already be authorized to export the supplied organization.
// A tenant check is a consistency check, not an authorization mechanism.
export function project(input) {
  if (input?.schemaVersion !== 1) throw new Error('Unsupported input schema');
  const organizationId = text(input.organizationId, 'organizationId', 256);
  if (!Number.isFinite(Date.parse(input.exportedAt))) throw new Error('Invalid exportedAt');
  if (!Array.isArray(input.incidents) || input.incidents.length > 10000) throw new Error('Expected at most 10000 incidents');
  const seen = new Set();
  let sourceBytes = 0;
  const incidents = input.incidents.map((incident, index) => {
    if (incident.organizationId !== organizationId) throw new Error('Mixed organization export');
    const incidentId = text(incident.id, 'incident id', 256);
    if (seen.has(incidentId)) throw new Error('Duplicate incident id');
    seen.add(incidentId);
    const title = text(incident.title, 'title', 4096);
    if (!['SEV1', 'SEV2', 'SEV3', 'SEV4'].includes(incident.severity)) throw new Error('Invalid severity');
    if (!['INVESTIGATING', 'IDENTIFIED', 'MONITORING', 'RESOLVED'].includes(incident.status)) throw new Error('Invalid status');
    const startedAt = text(incident.startedAt, 'startedAt', 64);
    if (!Number.isFinite(Date.parse(startedAt))) throw new Error('Invalid startedAt');
    if (!Array.isArray(incident.updates)) throw new Error('Expected updates');
    const body = incident.updates.filter((u) => u.isPublic === true).map((u) => text(u.message, 'public message')).join('\n');
    const bytes = Buffer.byteLength(`${title} ${body}`);
    sourceBytes += bytes;
    if (bytes > 64 * 1024 || sourceBytes > 8 * 1024 * 1024) throw new Error('Search text budget exceeded');
    return { id: index + 1, incident_id: incidentId, title, severity: incident.severity, status: incident.status, started_at: startedAt, body };
  });
  return { schemaVersion: 1, organizationId, exportedAt: input.exportedAt, incidents };
}

export function buildImage(input, { indexed = true } = {}) {
  const projected = project(input);
  const db = new Db();
  try {
    query(db, 'CREATE TABLE incidents (id INTEGER PRIMARY KEY, incident_id TEXT UNIQUE, title TEXT, severity TEXT, status TEXT, started_at TEXT, body TEXT)');
    db.executeMany('INSERT INTO incidents VALUES (?, ?, ?, ?, ?, ?, ?)', projected.incidents.map((r) => Object.values(r)));
    if (indexed) query(db, "CREATE INDEX incident_text ON incidents USING FULLTEXT (title, body) WITH (id_column='id')");
    const bytes = db.export();
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Image budget exceeded');
    return { bytes, manifest: { schemaVersion: 1, engine: 'picovolt', engineVersion: '2.3.0', indexed, organizationId: projected.organizationId, exportedAt: projected.exportedAt, count: projected.incidents.length, bytes: bytes.length, sha256: sha256(bytes), projection: 'incident-summary-public-updates-v1' } };
  } finally { db.free(); }
}

async function writeSynced(path, bytes) {
  const file = await open(path, 'wx');
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}

export async function writeBundle(directory, input) {
  const image = buildImage(input);
  await mkdir(directory); // Deliberately refuses an existing destination.
  await writeSynced(join(directory, 'incidents.pvdb'), image.bytes);
  // Last file marks completion. Partial bundles fail verification on open.
  await writeSynced(join(directory, 'manifest.json'), JSON.stringify(image.manifest, null, 2) + '\n');
  return image.manifest;
}

export async function openBundle(directory) {
  const manifestPath = join(directory, 'manifest.json');
  if ((await stat(manifestPath)).size > 8192) throw new Error('Manifest budget exceeded');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.engine !== 'picovolt' || manifest.engineVersion !== '2.3.0' || manifest.indexed !== true || manifest.projection !== 'incident-summary-public-updates-v1') throw new Error('Unsupported bundle');
  const path = join(directory, 'incidents.pvdb');
  const size = (await stat(path)).size;
  if (size > MAX_IMAGE_BYTES || size !== manifest.bytes) throw new Error('Invalid image size');
  const bytes = await readFile(path);
  if (sha256(bytes) !== manifest.sha256) throw new Error('Image digest mismatch');
  const db = Db.fromBytes(bytes);
  try {
    if (query(db, 'SELECT COUNT(*) AS count FROM incidents').rows[0][0] !== manifest.count) throw new Error('Row count mismatch');
  } catch (error) { db.free(); throw error; }
  let closed = false;
  const check = () => { if (closed) throw new Error('Archive closed'); };
  return {
    manifest,
    // Fixed read operations only. WASM fromBytes itself is writable in memory.
    list(severity = 'SEV1') {
      check();
      return query(db, 'SELECT incident_id, title, status FROM incidents WHERE severity=? ORDER BY id LIMIT 20', [severity]);
    },
    search(terms) {
      check(); text(terms, 'query', 1024);
      const hits = JSON.parse(db.retrieve(JSON.stringify({ kind: 'full_text', index: 'incident_text', sql: 'SELECT id,title,body FROM incidents', id_column: 'id', text_columns: ['title', 'body'], query: terms, limit: 10 })));
      return hits.map((hit) => ({ ...hit, incident: query(db, 'SELECT incident_id,title FROM incidents WHERE id=?', [Number(hit.id)]).rows[0] }));
    },
    close() { if (!closed) { db.free(); closed = true; } }
  };
}
