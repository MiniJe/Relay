import { decryptSecret } from './security.mjs';

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
  const webhookUrl = decryptSecret(integration.secretEncrypted, encryptionKey);
  const url = new URL(webhookUrl);
  if (url.protocol !== 'https:' || !['discord.com', 'discordapp.com'].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new Error('Stored Discord webhook URL is not an allowed Discord HTTPS endpoint.');
  }
  const response = await fetchImpl(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload(kind, incident, extra)),
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error(`Discord webhook returned HTTP ${response.status}.`);
  return { skipped: false, status: response.status };
}
