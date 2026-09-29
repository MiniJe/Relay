import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './fixture.mjs';
import { writeBundle, openBundle } from './archive.mjs';

await mkdir('output', { recursive: true });
const directory = join('output', `demo-${Date.now()}`);
await writeBundle(directory, fixture());
const archive = await openBundle(directory);
try { console.log(JSON.stringify({ directory, manifest: archive.manifest, hits: archive.search('database pool') }, null, 2)); }
finally { archive.close(); }
