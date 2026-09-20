import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptSecret, encryptSecret, hashPassword, safeEqualText, verifyPassword } from '../apps/api/src/security.mjs';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('passwords use salted scrypt and verify safely',async()=>{
  const a=await hashPassword('relay-password-123');
  const b=await hashPassword('relay-password-123');
  assert.notEqual(a,b);
  assert.equal(await verifyPassword('relay-password-123',a),true);
  assert.equal(await verifyPassword('wrong-password',a),false);
});

test('integration secrets round-trip with AES-GCM and reject tampering',()=>{
  const key='test-encryption-key';
  const encrypted=encryptSecret('https://discord.com/api/webhooks/123/token',key);
  assert.equal(decryptSecret(encrypted,key),'https://discord.com/api/webhooks/123/token');
  const tampered=encrypted.slice(0,-1)+(encrypted.endsWith('A')?'B':'A');
  assert.throws(()=>decryptSecret(tampered,key));
  assert.equal(safeEqualText('abc','abc'),true);
  assert.equal(safeEqualText('abc','abd'),false);
});


test('public renderer escapes representative user-controlled status content before HTML insertion',async()=>{
  const source=await readFile(new URL('../apps/web/public/app.js',import.meta.url),'utf8');
  const escLine=source.split('\n').find((line)=>line.startsWith('const esc='));
  assert.ok(escLine,'escape helper must exist');
  const context={};vm.runInNewContext(`${escLine} globalThis.__escape=esc;`,context);
  const hostile='<img src=x onerror="globalThis.pwned=1"><script>pwned()</script>';
  const escaped=context.__escape(hostile);
  assert.equal(escaped.includes('<img'),false);assert.equal(escaped.includes('<script>'),false);assert.ok(escaped.includes('&lt;img'));assert.ok(escaped.includes('&lt;script&gt;'));

  const publicSection=source.slice(source.indexOf('async function renderPublic'),source.indexOf('async function renderRoute'));
  for(const required of ['esc(incident.title)','esc(u.message)','esc(data.page.name)','esc(data.page.branding?.description','esc(c.name)','esc(i.title)','esc(i.updates.at(-1).message)'])assert.ok(publicSection.includes(required),`public renderer must escape ${required}`);
});
