import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Db } from 'picovolt';
import { buildImage, project, writeBundle, openBundle } from './archive.mjs';
import { fixture } from './fixture.mjs';

test('new archive excludes private fields and history; durable bytes reopen in another process', async () => {
  const directory = join(await mkdtemp(join(tmpdir(), 'relay-pv-test-')), 'bundle');
  await writeBundle(directory, fixture(12));
  const archive = await openBundle(directory);
  assert.equal(archive.manifest.count, 12);
  assert.equal(archive.search('database pool').length, 3);
  assert.equal(archive.list().rows.length, 3);
  assert.equal(archive.search('PRIVATE_UPDATE_SENTINEL').length, 0);
  archive.close();
  assert.throws(() => archive.search('database'), /closed/);
  const bytes = await readFile(join(directory, 'incidents.pvdb'));
  for (const value of ['PRIVATE_UPDATE_SENTINEL', 'PRIVATE_SECRET_SENTINEL', 'PRIVATE_TIMELINE_SENTINEL']) assert.equal(bytes.includes(Buffer.from(value)), false);
  const script = `import {openBundle} from './archive.mjs'; const a=await openBundle(process.argv[1]); if(a.search('database pool').length!==3)process.exitCode=1; a.close();`;
  const child = spawnSync(process.execPath, ['--experimental-wasm-modules', '--input-type=module', '-e', script, directory], { cwd: new URL('.', import.meta.url), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  await assert.rejects(writeBundle(directory, fixture()), /EEXIST/);
});

test('reject mixed tenants, duplicate IDs, unsupported versions and excessive input', () => {
  const mixed = fixture(2); mixed.incidents[1].organizationId = 'other';
  assert.throws(() => project(mixed), /Mixed organization/);
  const duplicate = fixture(2); duplicate.incidents[1].id = duplicate.incidents[0].id;
  assert.throws(() => project(duplicate), /Duplicate/);
  assert.throws(() => project({ ...fixture(1), schemaVersion: 2 }), /Unsupported/);
  assert.throws(() => project(fixture(10001)), /10000/);
  const oversized = fixture(1); oversized.incidents[0].updates[0].message = 'a'.repeat(65537);
  assert.throws(() => project(oversized), /Invalid public message/);
});

test('partial, tampered and incompatible bundles fail; engine rejects truncated image', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-pv-invalid-'));
  const partial = join(root, 'partial'); await mkdir(partial);
  await assert.rejects(openBundle(partial), /ENOENT/);
  const directory = join(root, 'bundle'); await writeBundle(directory, fixture(4));
  const path = join(directory, 'incidents.pvdb');
  const bytes = await readFile(path); bytes[bytes.length - 1] ^= 1; await writeFile(path, bytes);
  await assert.rejects(openBundle(directory), /digest mismatch/);
  const manifestPath = join(directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); manifest.schemaVersion = 2;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(openBundle(directory), /Unsupported/);
  const image = buildImage(fixture(4));
  assert.throws(() => Db.fromBytes(image.bytes.slice(0, 64)));
});

test('PicoVolt batch transaction rejects a duplicate without retaining a partial insert', () => {
  const db = new Db();
  try {
    db.query('CREATE TABLE t (id PRIMARY KEY, body)');
    assert.throws(() => db.executeMany('INSERT INTO t VALUES (?,?)', [[1, 'a'], [1, 'b']]));
    assert.equal(JSON.parse(db.query('SELECT COUNT(*) FROM t')).rows[0][0], 0);
  } finally { db.free(); }
});
