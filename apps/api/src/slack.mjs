import { decryptSecret } from './security.mjs';
import { buildPageText, sanitizeSlackText } from '../../../packages/shared/escalation.mjs';

// ---------------------------------------------------------------------------
// Relay 0.2 / RLY-0.2-M-002 — Slack paging through Incoming Webhooks only.
//
// Deliberately not implemented: Slack bots, slash commands, interactive
// incident management and OAuth installation. Relay posts one message per
// page to one webhook URL and nothing else.
// ---------------------------------------------------------------------------

/** The only Slack endpoint Relay will ever call. Anything else is a config error. */
export function assertSlackWebhookUrl(webhookUrl) {
  const url = new URL(webhookUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'hooks.slack.com') {
    throw new Error('Stored Slack webhook URL is not an allowed Slack HTTPS endpoint.');
  }
  if (!/^\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
    throw new Error('Stored Slack webhook URL is not a Slack Incoming Webhook path.');
  }
  return webhookUrl;
}

/**
 * Build the Slack message. Operator-supplied text is sanitized so a hostile
 * alert title can never broadcast-mention a channel or ping an arbitrary user;
 * `link_names` is left off and no `<!subteam>`/`@channel` token survives
 * sanitization.
 */
export function slackAlertPayload({ alert, service, routing, escalation, responderDisplayName }) {
  const title = sanitizeSlackText(`Alert routed — ${alert?.title ?? 'Untitled alert'}`, 220);
  const body = buildPageText({ alert, service, routing, escalation, responderDisplayName });
  return {
    // `parseText` (aka link_names) is intentionally omitted: Relay never asks
    // Slack to resolve @channel, @here or @user tokens coming from alert text.
    text: `${title}\n\n${sanitizeSlackText(body, 2600)}`,
    unfurl_links: false,
    unfurl_media: false
  };
}

/**
 * Post one page to Slack. Throws on failure with an HTTP status attached so the
 * worker can classify it (429/5xx retryable, 4xx permanent).
 */
export async function sendSlackAlertNotification({ integration, encryptionKey, alert, service, routing, escalation, responderDisplayName, fetchImpl = fetch, timeoutMs = 5000 }) {
  if (!integration?.enabled) return { skipped: true };
  const webhookUrl = assertSlackWebhookUrl(decryptSecret(integration.secretEncrypted, encryptionKey));
  const response = await fetchImpl(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(slackAlertPayload({ alert, service, routing, escalation, responderDisplayName })),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    const error = new Error(`Slack webhook returned HTTP ${response.status}.`);
    error.status = response.status;
    error.retryable = response.status === 429 || response.status >= 500;
    error.permanent = response.status >= 400 && response.status < 500 && response.status !== 429 && response.status !== 408;
    throw error;
  }
  return { skipped: false, status: response.status };
}
