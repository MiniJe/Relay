import { decryptSecret } from './security.mjs';
import { formatInTimeZone } from '../../../packages/shared/oncall.mjs';

function payload(kind, incident, extra = {}) {
  const titles = {
    created: 'Incident created',
    update: 'Incident update',
    resolved: 'Incident resolved'
  };
  const description = kind === 'update' ? extra.message : incident.summary || incident.title;
  return {
    username: 'Relay',
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `${titles[kind] ?? 'Relay'} — ${incident.title}`,
      description: String(description ?? '').slice(0, 3500),
      fields: [
        { name: 'Severity', value: incident.severity, inline: true },
        { name: 'Status', value: incident.status, inline: true }
      ],
      timestamp: new Date().toISOString(),
      footer: { text: 'Relay incident operations' }
    }]
  };
}

export async function sendDiscordNotification({ integration, encryptionKey, kind, incident, extra, fetchImpl = fetch }) {
  if (!integration?.enabled) return { skipped: true };
  const webhookUrl = assertDiscordWebhookUrl(decryptSecret(integration.secretEncrypted, encryptionKey));
  const response = await fetchImpl(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload(kind, incident, extra)),
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error(`Discord webhook returned HTTP ${response.status}.`);
  return { skipped: false, status: response.status };
}

// ---------------------------------------------------------------------------
// Relay 0.2 — routed-alert delivery
// ---------------------------------------------------------------------------

/**
 * Make operator- and monitor-supplied text inert for Discord.
 *
 * Angle brackets are removed so `<@id>`, `<#id>` and `<:emoji:>` syntax can
 * never be injected from an alert title, source or metadata field, and the
 * broadcast mentions are defanged so they read as plain text. Webhook payloads
 * additionally set `allowed_mentions.parse = []`, so even a surviving mention
 * token cannot notify anyone who was not explicitly allowed.
 */
export function sanitizeDiscordText(value, maxLength = 400) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[<>]/g, '')
    .replace(/@(everyone|here)/gi, '@ $1')
    .replace(/`/g, "'")
    .trim()
    .slice(0, maxLength);
}

function assertDiscordWebhookUrl(webhookUrl) {
  const url = new URL(webhookUrl);
  if (url.protocol !== 'https:' || !['discord.com', 'discordapp.com'].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new Error('Stored Discord webhook URL is not an allowed Discord HTTPS endpoint.');
  }
  return webhookUrl;
}

/**
 * Build the routed-alert payload. The resolved on-call responder is always
 * identified by display name so the notification stays useful when no Discord
 * mapping exists; a mapping only adds a real mention.
 */
export function alertNotificationPayload({ alert, routing, service, mentionDiscordUserId, timeZone = 'UTC' }) {
  const responderName = sanitizeDiscordText(routing?.oncallDisplayName ?? 'Unassigned', 120);
  const mention = mentionDiscordUserId ? `<@${mentionDiscordUserId}> ` : '';
  const zone = timeZone && typeof timeZone === 'string' ? timeZone : 'UTC';
  const fields = [
    { name: 'Severity', value: sanitizeDiscordText(alert?.severity ?? 'unknown', 60), inline: true },
    { name: 'Source', value: sanitizeDiscordText(alert?.source ?? 'unknown', 120), inline: true },
    { name: 'Service', value: sanitizeDiscordText(service?.name ?? alert?.serviceId ?? 'Not specified', 120), inline: true },
    { name: 'On call', value: `${mention}${responderName}`, inline: true },
    { name: 'Routed via', value: sanitizeDiscordText(
      [routing?.ruleName, routing?.scheduleName, routing?.teamName].filter(Boolean).join(' → ') || 'Direct schedule', 200), inline: true },
    { name: 'Observed', value: sanitizeDiscordText(formatInTimeZone(alert?.observedAt ?? new Date().toISOString(), zone), 60), inline: true }
  ];
  if (routing?.responderSource === 'OVERRIDE') fields.push({ name: 'Note', value: 'Resolved through a temporary on-call override.', inline: false });
  return {
    username: 'Relay',
    // `parse: []` blocks @everyone/@here/role mentions; only the mapped
    // responder id may be mentioned, and only when a mapping exists.
    allowed_mentions: { parse: [], users: mentionDiscordUserId ? [mentionDiscordUserId] : [] },
    embeds: [{
      title: sanitizeDiscordText(`Alert routed — ${alert?.title ?? 'Untitled alert'}`, 220),
      description: sanitizeDiscordText(alert?.description ?? '', 1800) || 'No alert description was provided.',
      color: alertSeverityColor(alert?.severity),
      fields,
      timestamp: new Date(alert?.receivedAt ?? Date.now()).toISOString(),
      footer: { text: 'Relay alert routing — acknowledge in the Relay alerts workspace' }
    }]
  };
}

function alertSeverityColor(severity) {
  const value = String(severity ?? '').toLowerCase();
  if (['critical', 'sev1', 'page', 'fatal', 'emergency'].includes(value)) return 0xef4444;
  if (['warning', 'sev2', 'warn', 'error'].includes(value)) return 0xf97316;
  if (['sev3', 'notice', 'info'].includes(value)) return 0xeab308;
  return 0x3b82f6;
}

/**
 * Deliver a routed-alert notification. Throws on failure exactly like the
 * incident notification path so callers can record a FAILED delivery while
 * keeping the alert itself durable.
 */
export async function sendDiscordAlertNotification({ integration, encryptionKey, alert, routing, service, mentionDiscordUserId, timeZone, fetchImpl = fetch }) {
  if (!integration?.enabled) return { skipped: true };
  const webhookUrl = assertDiscordWebhookUrl(decryptSecret(integration.secretEncrypted, encryptionKey));
  const payload = alertNotificationPayload({ alert, routing, service, mentionDiscordUserId, timeZone });
  const response = await fetchImpl(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error(`Discord webhook returned HTTP ${response.status}.`);
  return { skipped: false, status: response.status, mentioned: Boolean(mentionDiscordUserId) };
}
