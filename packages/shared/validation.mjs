import { COMPONENT_STATES, INCIDENT_STATUSES, ROLES, SEVERITIES, domainError, slugify } from './domain.mjs';

export function object(value, name = 'body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw domainError('VALIDATION_ERROR', `${name} must be an object.`, 400);
  return value;
}

export function string(value, name, { min = 1, max = 5000, optional = false } = {}) {
  if ((value === undefined || value === null || value === '') && optional) return undefined;
  if (typeof value !== 'string') throw domainError('VALIDATION_ERROR', `${name} must be a string.`, 400);
  const v = value.trim();
  if (v.length < min || v.length > max) throw domainError('VALIDATION_ERROR', `${name} must be between ${min} and ${max} characters.`, 400);
  return v;
}

export function email(value) {
  const v = string(value, 'email', { min: 3, max: 320 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw domainError('VALIDATION_ERROR', 'Email address is invalid.', 400);
  return v;
}

export function password(value) {
  const v = string(value, 'password', { min: 10, max: 256 });
  if (!/[a-zA-Z]/.test(v) || !/[0-9]/.test(v)) throw domainError('VALIDATION_ERROR', 'Password must contain at least one letter and one number.', 400);
  return v;
}

export function id(value, name = 'id') {
  const v = string(value, name, { min: 10, max: 80 });
  if (!/^[a-zA-Z0-9_-]+$/.test(v)) throw domainError('VALIDATION_ERROR', `${name} is invalid.`, 400);
  return v;
}

export function enumValue(value, name, allowed, { optional = false } = {}) {
  if ((value === undefined || value === null || value === '') && optional) return undefined;
  if (!allowed.includes(value)) throw domainError('VALIDATION_ERROR', `${name} must be one of: ${allowed.join(', ')}.`, 400);
  return value;
}

export function ids(value, name, { optional = false, max = 100 } = {}) {
  if ((value === undefined || value === null) && optional) return undefined;
  if (!Array.isArray(value) || value.length > max) throw domainError('VALIDATION_ERROR', `${name} must be an array with at most ${max} entries.`, 400);
  return [...new Set(value.map((item) => id(item, name)))];
}

export function metadata(value) {
  if (value === undefined || value === null) return {};
  object(value, 'metadata');
  const serialized = JSON.stringify(value);
  if (serialized.length > 32_000) throw domainError('VALIDATION_ERROR', 'metadata is too large.', 400);
  return value;
}

export function organizationInput(body) {
  body = object(body);
  const name = string(body.name, 'name', { min: 2, max: 120 });
  const slug = body.slug ? slugify(string(body.slug, 'slug', { max: 80 })) : slugify(name);
  if (!slug) throw domainError('VALIDATION_ERROR', 'Organization slug is invalid.', 400);
  return { name, slug };
}

export function serviceInput(body) {
  body = object(body);
  const name = string(body.name, 'name', { min: 2, max: 120 });
  return {
    name,
    slug: body.slug ? slugify(string(body.slug, 'slug', { max: 80 })) : slugify(name),
    description: string(body.description ?? '', 'description', { min: 0, max: 2000, optional: true }) ?? '',
    operationalState: enumValue(body.operationalState ?? 'OPERATIONAL', 'operationalState', COMPONENT_STATES)
  };
}

export function componentInput(body) {
  body = object(body);
  const name = string(body.name, 'name', { min: 2, max: 120 });
  return {
    name,
    slug: body.slug ? slugify(string(body.slug, 'slug', { max: 80 })) : slugify(name),
    description: string(body.description ?? '', 'description', { min: 0, max: 2000, optional: true }) ?? '',
    operationalState: enumValue(body.operationalState ?? 'OPERATIONAL', 'operationalState', COMPONENT_STATES),
    serviceIds: ids(body.serviceIds ?? [], 'serviceIds')
  };
}

export function incidentInput(body) {
  body = object(body);
  return {
    title: string(body.title, 'title', { min: 3, max: 200 }),
    summary: string(body.summary ?? '', 'summary', { min: 0, max: 5000, optional: true }) ?? '',
    severity: enumValue(body.severity, 'severity', SEVERITIES),
    affectedServiceIds: ids(body.affectedServiceIds ?? [], 'affectedServiceIds'),
    affectedComponentIds: ids(body.affectedComponentIds ?? [], 'affectedComponentIds'),
    commanderUserId: body.commanderUserId ? id(body.commanderUserId, 'commanderUserId') : undefined
  };
}

export function incidentPatch(body) {
  body = object(body);
  const out = {};
  if ('summary' in body) out.summary = string(body.summary ?? '', 'summary', { min: 0, max: 5000, optional: true }) ?? '';
  if ('severity' in body) out.severity = enumValue(body.severity, 'severity', SEVERITIES);
  if ('status' in body) out.status = enumValue(body.status, 'status', INCIDENT_STATUSES);
  if ('affectedServiceIds' in body) out.affectedServiceIds = ids(body.affectedServiceIds, 'affectedServiceIds');
  if ('affectedComponentIds' in body) out.affectedComponentIds = ids(body.affectedComponentIds, 'affectedComponentIds');
  if ('commanderUserId' in body) out.commanderUserId = body.commanderUserId ? id(body.commanderUserId, 'commanderUserId') : null;
  return out;
}

export function statusPageInput(body) {
  body = object(body);
  const name = string(body.name, 'name', { min: 2, max: 120 });
  const slug = body.slug ? slugify(string(body.slug, 'slug', { max: 80 })) : slugify(name);
  return {
    name,
    slug,
    isPublic: body.isPublic !== false,
    componentIds: ids(body.componentIds ?? [], 'componentIds'),
    branding: {
      headline: string(body.branding?.headline ?? name, 'branding.headline', { min: 1, max: 120 }),
      description: string(body.branding?.description ?? '', 'branding.description', { min: 0, max: 500, optional: true }) ?? '',
      accent: /^#[0-9A-Fa-f]{6}$/.test(body.branding?.accent ?? '') ? body.branding.accent : '#7c3aed'
    }
  };
}

export function role(value) { return enumValue(value, 'role', ROLES); }
