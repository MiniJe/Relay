import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { domainError } from '../../../packages/shared/domain.mjs';

const mime = {
  '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8'
};

const appDocumentRoutes = new Set([
  '/app','/app/','/app/services','/app/components','/app/incidents','/app/status-pages','/app/settings',
  '/app/alerts','/app/teams','/app/oncall','/app/routing'
]);
const appIncidentRoute = /^\/app\/incidents\/[a-zA-Z0-9_-]+\/?$/;
const statusPageRoute = /^\/status\/[a-z0-9-]+\/?$/;
const statusIncidentRoute = /^\/status\/[a-z0-9-]+\/incidents\/[a-zA-Z0-9_-]+\/?$/;

export async function readJson(req, maxBytes = 1_000_000) {
  let size=0; const chunks=[];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw domainError('PAYLOAD_TOO_LARGE','Request payload is too large.',413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw domainError('INVALID_JSON','Request body must be valid JSON.',400); }
}

export function sendJson(res, status, data, headers={}) {
  const body=JSON.stringify(data);
  res.writeHead(status, {'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(body),'x-content-type-options':'nosniff','cache-control':'no-store',...headers});
  res.end(body);
}

export function sendNoContent(res, status=204, headers={}) { res.writeHead(status, {'cache-control':'no-store',...headers});res.end(); }

export function clientIp(req, trustProxy=false) {
  if (trustProxy) return String(req.headers['x-forwarded-for']??'').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  return req.socket.remoteAddress || 'unknown';
}

export function assertMutationOrigin(req, appOrigin) {
  if (!['POST','PUT','PATCH','DELETE'].includes(req.method)) return;
  const origin=req.headers.origin;
  if (!origin) return;
  if (origin !== appOrigin) throw domainError('ORIGIN_REJECTED','Cross-origin state change rejected.',403);
}

function isDocumentRoute(pathname) {
  return pathname === '/' || pathname === '/signin' || pathname === '/register' ||
    appDocumentRoutes.has(pathname) || appIncidentRoute.test(pathname) ||
    statusPageRoute.test(pathname) || statusIncidentRoute.test(pathname);
}

function safeStaticPath(staticDir, pathname) {
  const staticRoot = path.resolve(staticDir);
  const normalized = path.posix.normalize(pathname).replace(/^\/+/, '');
  const target = path.resolve(staticRoot, normalized);
  const relative = path.relative(staticRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return target;
}

export async function serveStatic(req,res,staticDir) {
  const url=new URL(req.url,'http://relay.local');
  let pathname;
  try { pathname=decodeURIComponent(url.pathname); }
  catch { return false; }
  if (pathname.startsWith('/api/')) return false;

  const isDocument = isDocumentRoute(pathname);
  const target = isDocument ? path.join(path.resolve(staticDir),'index.html') : safeStaticPath(staticDir,pathname);
  if (!target) return false;

  try {
    const info=await stat(target); if(!info.isFile())return false;
    const type=mime[path.extname(target)]??'application/octet-stream';
    res.writeHead(200,{
      'content-type':type,
      'content-length':info.size,
      'cache-control':isDocument?'no-store':'no-cache',
      'x-content-type-options':'nosniff',
      'referrer-policy':'same-origin',
      'x-frame-options':'DENY',
      'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    });
    createReadStream(target).pipe(res); return true;
  } catch { return false; }
}

export function errorResponse(error, requestId) {
  const status=Number(error?.status)||500;
  const expose=status<500 || error?.code==='CONFIGURATION_ERROR';
  return {status,body:{error:{code:expose?(error?.code??'ERROR'):'INTERNAL_ERROR',message:expose?(error?.message??'Request failed.'):'An unexpected server error occurred.',...(expose&&error?.details?{details:error.details}:{}),requestId}}};
}
