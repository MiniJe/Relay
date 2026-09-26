import { COMPONENT_STATES, INCIDENT_STATUSES, ROLES, SEVERITIES, domainError, slugify } from './domain.mjs';
import { MAX_ROTATION_INTERVAL_MINUTES, MIN_ROTATION_INTERVAL_MINUTES, assertTimeZone } from './oncall.mjs';

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

// ---------------------------------------------------------------------------
// Relay 0.2 — alert routing and on-call input validation.
//
// Every value that reaches persistence or the routing engine is validated here
// so that malformed timezones, non-integer intervals, hostile rule conditions
// and malformed Discord identifiers are rejected before they can influence a
// routing decision.
// ---------------------------------------------------------------------------

export function timestamp(value, name, { optional = false, required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return undefined;
    throw domainError('VALIDATION_ERROR', `${name} is required.`, 400);
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw domainError('VALIDATION_ERROR', `${name} must be a valid ISO-8601 timestamp.`, 400);
  return parsed.toISOString();
}

export function integer(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER, optional = false, fallback } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return fallback;
    throw domainError('VALIDATION_ERROR', `${name} is required.`, 400);
  }
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(parsed)) throw domainError('VALIDATION_ERROR', `${name} must be a whole number.`, 400);
  if (parsed < min || parsed > max) throw domainError('VALIDATION_ERROR', `${name} must be between ${min} and ${max}.`, 400);
  return parsed;
}

export function booleanValue(value, name, { fallback = true } = {}) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw domainError('VALIDATION_ERROR', `${name} must be a boolean.`, 400);
  return value;
}

/** IANA timezone identifier, validated without consulting the host timezone. */
export function timeZone(value) {
  const raw = string(value, 'timeZone', { min: 2, max: 64 });
  return assertTimeZone(raw);
}

/**
 * Discord user identifiers are numeric snowflakes. Accepting only digits keeps
 * the value inert: it can never carry Markdown, a mention-everyone payload, or
 * anything else into a Discord message body.
 */
export function discordUserId(value) {
  const raw = string(value, 'discordUserId', { min: 15, max: 25 });
  if (!/^[0-9]{15,25}$/.test(raw)) throw domainError('VALIDATION_ERROR', 'discordUserId must be a numeric Discord snowflake identifier.', 400);
  return raw;
}

/** Free-form severity tokens. Matching is case-insensitive; nothing is executed. */
export function severityTokens(value, name = 'matchSeverities', { max = 20 } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw domainError('VALIDATION_ERROR', `${name} must be an array of severity values.`, 400);
  if (value.length > max) throw domainError('VALIDATION_ERROR', `${name} supports at most ${max} entries.`, 400);
  const out = [];
  for (const item of value) {
    const token = string(item, name, { min: 1, max: 40 });
    if (!out.some((existing) => existing.toLowerCase() === token.toLowerCase())) out.push(token);
  }
  return out;
}

export function teamInput(body) {
  body = object(body);
  const name = string(body.name, 'name', { min: 2, max: 120 });
  return {
    name,
    slug: body.slug ? slugify(string(body.slug, 'slug', { max: 80 })) : slugify(name),
    description: string(body.description ?? '', 'description', { min: 0, max: 2000, optional: true }) ?? ''
  };
}

export function teamPatch(body) {
  body = object(body);
  const out = {};
  if ('name' in body) out.name = string(body.name, 'name', { min: 2, max: 120 });
  if ('slug' in body) out.slug = slugify(string(body.slug, 'slug', { min: 1, max: 80 }));
  if ('description' in body) out.description = string(body.description ?? '', 'description', { min: 0, max: 2000, optional: true }) ?? '';
  if (out.slug !== undefined && !out.slug) throw domainError('VALIDATION_ERROR', 'Team slug is invalid.', 400);
  return out;
}

export function servicePatch(body) {
  body = object(body);
  const out = {};
  if ('name' in body) out.name = string(body.name, 'name', { min: 2, max: 120 });
  if ('slug' in body) out.slug = slugify(string(body.slug, 'slug', { min: 1, max: 80 }));
  if ('description' in body) out.description = string(body.description ?? '', 'description', { min: 0, max: 2000, optional: true }) ?? '';
  if ('operationalState' in body) out.operationalState = enumValue(body.operationalState, 'operationalState', COMPONENT_STATES);
  // `ownerTeamId: null` explicitly clears ownership; omission leaves it alone.
  if ('ownerTeamId' in body) out.ownerTeamId = body.ownerTeamId === null || body.ownerTeamId === '' ? null : id(body.ownerTeamId, 'ownerTeamId');
  return out;
}

export function scheduleInput(body) {
  body = object(body);
  const participantUserIds = ids(body.participantUserIds ?? [], 'participantUserIds', { max: 50 });
  if (!participantUserIds.length) throw domainError('VALIDATION_ERROR', 'An on-call schedule needs at least one rotation participant.', 400);
  return {
    name: string(body.name, 'name', { min: 2, max: 120 }),
    teamId: id(body.teamId, 'teamId'),
    timeZone: timeZone(body.timeZone ?? 'UTC'),
    enabled: booleanValue(body.enabled, 'enabled', { fallback: true }),
    rotationStartsAt: timestamp(body.rotationStartsAt, 'rotationStartsAt', { optional: true }) ?? new Date().toISOString(),
    rotationIntervalMinutes: integer(body.rotationIntervalMinutes, 'rotationIntervalMinutes', { min: MIN_ROTATION_INTERVAL_MINUTES, max: MAX_ROTATION_INTERVAL_MINUTES }),
    participantUserIds
  };
}

export function schedulePatch(body) {
  body = object(body);
  const out = {};
  if ('name' in body) out.name = string(body.name, 'name', { min: 2, max: 120 });
  if ('timeZone' in body) out.timeZone = timeZone(body.timeZone);
  if ('enabled' in body) out.enabled = booleanValue(body.enabled, 'enabled');
  if ('rotationStartsAt' in body) out.rotationStartsAt = timestamp(body.rotationStartsAt, 'rotationStartsAt');
  if ('rotationIntervalMinutes' in body) out.rotationIntervalMinutes = integer(body.rotationIntervalMinutes, 'rotationIntervalMinutes', { min: MIN_ROTATION_INTERVAL_MINUTES, max: MAX_ROTATION_INTERVAL_MINUTES });
  if ('participantUserIds' in body) {
    const participantUserIds = ids(body.participantUserIds, 'participantUserIds', { max: 50 });
    if (!participantUserIds.length) throw domainError('VALIDATION_ERROR', 'An on-call schedule needs at least one rotation participant.', 400);
    out.participantUserIds = participantUserIds;
  }
  return out;
}

export function overrideInput(body) {
  body = object(body);
  const startsAt = timestamp(body.startsAt, 'startsAt');
  const endsAt = timestamp(body.endsAt, 'endsAt');
  if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    throw domainError('VALIDATION_ERROR', 'startsAt must be strictly before endsAt.', 400);
  }
  return {
    replacementUserId: id(body.replacementUserId, 'replacementUserId'),
    startsAt,
    endsAt,
    reason: string(body.reason ?? '', 'reason', { min: 0, max: 500, optional: true }) ?? ''
  };
}

export function routingRuleInput(body) {
  body = object(body);
  const channels = body.notificationChannels ?? ['DISCORD'];
  if (!Array.isArray(channels) || !channels.length || channels.some((channel) => !['DISCORD', 'SLACK', 'EMAIL'].includes(channel)) || new Set(channels).size !== channels.length) throw domainError('VALIDATION_ERROR', 'notificationChannels must contain unique supported channels.', 400);
  return {
    name: string(body.name, 'name', { min: 2, max: 160 }),
    enabled: booleanValue(body.enabled, 'enabled', { fallback: true }),
    priority: integer(body.priority ?? 100, 'priority', { min: 0, max: 100_000 }),
    matchServiceId: body.matchServiceId ? id(body.matchServiceId, 'matchServiceId') : null,
    matchSource: body.matchSource ? string(body.matchSource, 'matchSource', { min: 1, max: 120 }) : null,
    matchSeverities: severityTokens(body.matchSeverities),
    targetKind: enumValue(body.targetKind ?? 'ONCALL_SCHEDULE', 'targetKind', ['ONCALL_SCHEDULE']),
    targetScheduleId: id(body.targetScheduleId, 'targetScheduleId'),
    notificationChannels: [...channels],
    escalationPolicyId: body.escalationPolicyId ? id(body.escalationPolicyId, 'escalationPolicyId') : null
  };
}

// ---------------------------------------------------------------------------
// Relay 0.2 / RLY-0.2-M-002 — outbound integration configuration.
//
// Slack and SMTP both accept operator-supplied text that ends up in a header
// or a provider payload, so the validators below reject CR, LF and NUL (all
// three are header-injection primitives) and cap every field length.
// ---------------------------------------------------------------------------

/** Reject control characters, CR/LF and UTF-8 line separators in header-bound text. */
export function headerSafe(value, name, { min = 1, max = 200, optional = false } = {}) {
  const raw = string(value, name, { min, max, optional });
  if (raw === undefined) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(raw)) throw domainError('VALIDATION_ERROR', `${name} must not contain control characters or line breaks.`, 400);
  return raw;
}

/** Same rules as an email address, but for mailbox display purposes. */
export function headerSafeEmail(value, name = 'email') {
  const raw = headerSafe(email(value), name, { min: 3, max: 320 });
  return raw;
}

/**
 * Only Slack Incoming Webhook endpoints are accepted. An arbitrary URL is
 * rejected before it can ever be stored, so Relay can never be pointed at an
 * internal service or an attacker-controlled host through the integration API.
 */
export function slackWebhookUrl(value) {
  const raw = string(value, 'webhookUrl', { min: 20, max: 1000 });
  let parsed;
  try { parsed = new URL(raw); } catch { throw domainError('VALIDATION_ERROR', 'webhookUrl must be a valid URL.', 400); }
  if (parsed.protocol !== 'https:') throw domainError('VALIDATION_ERROR', 'Only HTTPS Slack webhook URLs are supported.', 400);
  if (parsed.hostname !== 'hooks.slack.com') throw domainError('VALIDATION_ERROR', 'Only Slack Incoming Webhook URLs on hooks.slack.com are supported.', 400);
  if (!/^\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(parsed.pathname)) throw domainError('VALIDATION_ERROR', 'The URL is not a Slack Incoming Webhook path.', 400);
  if (parsed.search || parsed.hash) throw domainError('VALIDATION_ERROR', 'A Slack Incoming Webhook URL must not carry a query string or fragment.', 400);
  return raw;
}

/** Organization-scoped SMTP transport configuration. Secrets are never part of this shape. */
export function smtpIntegrationInput(body) {
  body = object(body);
  const host = headerSafe(body.host, 'host', { min: 1, max: 253 }).toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host) && !/^\[[0-9a-fA-F:]+\]$/.test(host)) {
    throw domainError('VALIDATION_ERROR', 'host must be a hostname or an IP literal.', 400);
  }
  const port = integer(body.port, 'port', { min: 1, max: 65535 });
  const secure = booleanValue(body.secure, 'secure', { fallback: port === 465 });
  if (secure && [25, 587].includes(port)) {
    throw domainError('VALIDATION_ERROR', `secure:true selects implicit TLS, but port ${port} is a STARTTLS port. Use secure:false for port ${port}.`, 400);
  }
  const username = body.username ? headerSafe(body.username, 'username', { max: 320 }) : null;
  const password = body.password === undefined || body.password === null || body.password === '' ? undefined : string(body.password, 'password', { min: 1, max: 500 });
  if (password !== undefined && /[\r\n]/.test(password)) throw domainError('VALIDATION_ERROR', 'password must not contain line breaks.', 400);
  if (username && password === undefined && body.keepExistingPassword !== true) {
    throw domainError('VALIDATION_ERROR', 'A password is required when a username is configured.', 400);
  }
  const fromEmail = body.fromEmail ? headerSafeEmail(body.fromEmail, 'fromEmail')
    : username && username.includes('@') ? headerSafeEmail(username, 'fromEmail')
      : undefined;
  if (!fromEmail) throw domainError('VALIDATION_ERROR', 'fromEmail is required.', 400);
  return {
    host, port, secure,
    username,
    password,
    fromEmail,
    fromName: headerSafe(body.fromName ?? 'Relay', 'fromName', { min: 0, max: 120, optional: true }) ?? null,
    enabled: booleanValue(body.enabled, 'enabled', { fallback: true }),
    timeoutMs: integer(body.timeoutMs ?? 10_000, 'timeoutMs', { min: 1_000, max: 120_000 })
  };
}

export function routingRulePatch(body) {
  body = object(body);
  const out = {};
  if ('name' in body) out.name = string(body.name, 'name', { min: 2, max: 160 });
  if ('enabled' in body) out.enabled = booleanValue(body.enabled, 'enabled');
  if ('priority' in body) out.priority = integer(body.priority, 'priority', { min: 0, max: 100_000 });
  if ('matchServiceId' in body) out.matchServiceId = body.matchServiceId ? id(body.matchServiceId, 'matchServiceId') : null;
  if ('matchSource' in body) out.matchSource = body.matchSource ? string(body.matchSource, 'matchSource', { min: 1, max: 120 }) : null;
  if ('matchSeverities' in body) out.matchSeverities = severityTokens(body.matchSeverities);
  if ('targetScheduleId' in body) out.targetScheduleId = id(body.targetScheduleId, 'targetScheduleId');
  if ('notificationChannels' in body) {
    const channels = body.notificationChannels;
    if (!Array.isArray(channels) || !channels.length || channels.some((channel) => !['DISCORD', 'SLACK', 'EMAIL'].includes(channel)) || new Set(channels).size !== channels.length) throw domainError('VALIDATION_ERROR', 'notificationChannels must contain unique supported channels.', 400);
    out.notificationChannels = [...channels];
  }
  if ('escalationPolicyId' in body) out.escalationPolicyId = body.escalationPolicyId ? id(body.escalationPolicyId, 'escalationPolicyId') : null;
  return out;
}
