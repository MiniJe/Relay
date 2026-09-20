import { domainError, hasRole } from '../../../packages/shared/domain.mjs';
import { parseCookies, sha256 } from './security.mjs';

export async function authenticate(req, store, config) {
  const cookies=parseCookies(req.headers.cookie);
  const token=cookies[config.sessionCookieName];
  if(!token)return undefined;
  return store.getSession(sha256(token));
}

export function requireUser(session) {
  if(!session?.user)throw domainError('AUTH_REQUIRED','Authentication is required.',401);
  return session.user;
}

export async function requireOrgRole({store,userId,organizationId,allowed}) {
  const membership=await store.getMembership(organizationId,userId);
  if(!membership)throw domainError('FORBIDDEN','You do not have access to this organization.',403);
  if(allowed && !hasRole(membership.role,allowed))throw domainError('FORBIDDEN','Your organization role does not allow this operation.',403);
  return membership;
}
