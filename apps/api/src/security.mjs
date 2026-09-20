import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { domainError } from '../../../packages/shared/domain.mjs';

const scryptAsync = promisify(crypto.scrypt);

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${Buffer.from(derived).toString('base64url')}`;
}

export async function verifyPassword(password, encoded) {
  try {
    const [algorithm, n, r, p, salt64, hash64] = String(encoded).split('$');
    if (algorithm !== 'scrypt') return false;
    const expected = Buffer.from(hash64, 'base64url');
    const derived = Buffer.from(await scryptAsync(password, Buffer.from(salt64, 'base64url'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p)
    }));
    return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

export function createOpaqueToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function safeEqualText(a, b) {
  const aa = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function encryptionKey(raw) {
  if (!raw) throw domainError('CONFIGURATION_ERROR', 'INTEGRATION_ENCRYPTION_KEY is required to store integration secrets.', 500);
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw).digest();
}

export function encryptSecret(plaintext, rawKey) {
  const key = encryptionKey(rawKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptSecret(envelope, rawKey) {
  const [version, iv64, tag64, ciphertext64] = String(envelope).split('.');
  if (version !== 'v1') throw domainError('INTEGRATION_SECRET_ERROR', 'Unsupported encrypted secret format.', 500);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(rawKey), Buffer.from(iv64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext64, 'base64url')), decipher.final()]).toString('utf8');
}

export function parseCookies(header = '') {
  const out = {};
  for (const segment of String(header).split(';')) {
    const index = segment.indexOf('=');
    if (index < 0) continue;
    const key = segment.slice(0, index).trim();
    const value = segment.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

export function sessionCookie(name, token, { maxAgeSeconds = 60 * 60 * 24 * 7, secure = false } = {}) {
  return `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(name, { secure = false } = {}) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

export class SlidingWindowRateLimiter {
  constructor({ windowMs, limit }) {
    this.windowMs = windowMs;
    this.limit = limit;
    this.buckets = new Map();
  }
  take(key, now = Date.now()) {
    const existing = this.buckets.get(key) ?? [];
    const current = existing.filter((at) => now - at < this.windowMs);
    if (current.length >= this.limit) return false;
    current.push(now);
    this.buckets.set(key, current);
    if (this.buckets.size > 20_000) {
      for (const [bucketKey, values] of this.buckets) {
        if (!values.some((at) => now - at < this.windowMs)) this.buckets.delete(bucketKey);
      }
    }
    return true;
  }
}
