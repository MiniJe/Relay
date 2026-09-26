import { decryptSecret } from './security.mjs';
import { sendDiscordAlertNotification } from './discord.mjs';
import { sendSlackAlertNotification } from './slack.mjs';
import { classifySmtpError, sendResponderEmail } from './email.mjs';
import { NOTIFICATION_CHANNELS, classifyDeliveryFailure } from '../../../packages/shared/escalation.mjs';

// ---------------------------------------------------------------------------
// Relay 0.2 / RLY-0.2-M-002 — durable delivery execution.
//
// A "logical delivery" is the durable intent to page one responder over one
// channel. It is created at routing time (immediate channels) or at escalation
// time (step channels) and is the source of truth until it reaches a terminal
// state. Every actual provider call writes an immutable attempt row under the
// lease the worker holds, so retrying never rewrites history.
// ---------------------------------------------------------------------------

/** Safe, non-secret description of where a page is going. */
export function destinationSnapshot({ provider, integration, responder, extra = {} }) {
  const base = { kind: `${provider}_WEBHOOK`, integrationId: integration?.id ?? null, integrationName: integration?.name ?? null };
  if (provider === 'EMAIL') {
    // The destination is snapshotted at enqueue time from the responder's
    // canonical account, not from anything an alert supplies.
    return { ...base, kind: 'SMTP', to: responder?.email ?? null, fromEmail: integration?.config?.fromEmail ?? null, host: integration?.config?.host ?? null };
  }
  if (provider === 'DISCORD') return { ...base, discordUserId: extra.discordUserId ?? null, timeZone: extra.timeZone ?? null };
  return base;
}

/**
 * Attach a durable provider/destination pair to a relay page. This is what the
 * worker dereferences; it never contains a webhook URL or a password.
 */
export function describeDestination(delivery) {
  const snapshot = delivery?.destinationSnapshot ?? {};
  if (delivery.provider === 'DISCORD') return `Discord webhook${snapshot.integrationName ? ` (${snapshot.integrationName})` : ''}`;
  if (delivery.provider === 'SLACK') return 'Slack Incoming Webhook';
  if (delivery.provider === 'EMAIL') return snapshot.to ? `Email to ${snapshot.to}` : 'Email';
  return delivery.provider;
}

/**
 * Channel to integration-provider mapping. A page is addressed to a *channel*
 * (`EMAIL`), while the organization stores its transport configuration under an
 * *integration* (`SMTP`). Keeping the two names explicit stops a channel rename
 * from silently detaching an organization's credentials.
 */
export const INTEGRATION_PROVIDER_BY_CHANNEL = Object.freeze({ DISCORD: 'DISCORD', SLACK: 'SLACK', EMAIL: 'SMTP' });

export function integrationProviderFor(channel) {
  const provider = INTEGRATION_PROVIDER_BY_CHANNEL[channel];
  if (!provider) throw new Error(`Unsupported notification channel ${channel}.`);
  return provider;
}

/**
 * Resolve the integration a delivery needs. Returns `null` when the provider is
 * not configured at all and a disabled integration when it exists but is
 * switched off, so callers can report the M-001 skip semantics.
 */
export async function loadIntegrationFor({ store, organizationId, provider }) {
  const integration = await store.getIntegration(organizationId, integrationProviderFor(provider));
  if (!integration) return { integration: null, skipped: 'SKIPPED_NO_INTEGRATION' };
  if (!integration.enabled) return { integration, skipped: 'SKIPPED_DISABLED' };
  return { integration, skipped: null };
}

/** Dispatch table used by tests to inject controlled transports. */
export const PROVIDER_TRANSPORTS = Object.freeze({
  DISCORD: sendDiscordAlertNotification,
  SLACK: sendSlackAlertNotification,
  EMAIL: sendResponderEmail
});

/**
 * Perform one provider call for a claimed delivery and return a normalized
 * result. Never throws: the worker must always be able to persist an outcome.
 * No transaction may be open when this runs.
 */
export async function attemptDelivery({ delivery, context, config, transports = {}, fetchImpl = fetch, logger = console }) {
  const { organizationId, alert, service, routing, escalation, responderUser, integration } = context;
  const startedAt = new Date().toISOString();
  const safeContext = { alert, service, routing, escalation, responderDisplayName: delivery.responderDisplayNameSnapshot ?? responderUser?.displayName ?? null };
  try {
    if (delivery.provider === 'EMAIL') {
      if (!responderUser?.email) return { outcome: 'PERMANENT_FAILURE', providerStatusCode: null, safeError: 'The resolved responder has no account email address.', startedAt };
      const send = transports.EMAIL ?? sendResponderEmail;
      const result = await send({
        integration, encryptionKey: config.integrationEncryptionKey, ...safeContext,
        // The recipient is the resolved responder's canonical account address.
        // Alert content never selects who is emailed.
        recipient: responderUser.email,
        transporterFactory: transports.transporterFactory ?? undefined,
        decryptSecret
      });
      if (result?.skipped) return { outcome: 'PERMANENT_FAILURE', providerStatusCode: null, safeError: 'The SMTP integration is disabled.', startedAt };
      return { outcome: 'SENT', providerStatusCode: result?.status ?? 250, safeError: null, startedAt };
    }
    const send = transports[delivery.provider] ?? PROVIDER_TRANSPORTS[delivery.provider];
    if (!send) return { outcome: 'PERMANENT_FAILURE', providerStatusCode: null, safeError: `Unsupported notification provider ${delivery.provider}.`, startedAt };
    const result = await send({
      integration,
      encryptionKey: config.integrationEncryptionKey,
      ...safeContext,
      mentionDiscordUserId: delivery.provider === 'DISCORD' ? (delivery.destinationSnapshot?.discordUserId ?? null) : undefined,
      timeZone: delivery.destinationSnapshot?.timeZone ?? routing?.timeZone ?? 'UTC',
      fetchImpl
    });
    if (result?.skipped) return { outcome: 'PERMANENT_FAILURE', providerStatusCode: null, safeError: `${delivery.provider} integration is disabled.`, startedAt };
    return { outcome: 'SENT', providerStatusCode: result?.status ?? 200, safeError: null, startedAt };
  } catch (error) {
    // Log the message only: webhook URLs and SMTP passwords are secrets.
    logger.warn?.('Alert notification delivery failed:', error?.message ?? error);
    if (delivery.provider === 'EMAIL') {
      const classified = classifySmtpError(error);
      return { ...classified, startedAt };
    }
    // A missing or unreadable credential is a configuration fault: retrying it
    // three times cannot help, so it is recorded as a permanent failure.
    if (error?.code === 'CONFIGURATION_ERROR' || error?.code === 'INTEGRATION_SECRET_ERROR') {
      return { outcome: 'PERMANENT_FAILURE', providerStatusCode: null, safeError: String(error.message ?? 'Provider configuration is invalid.').slice(0, 300), startedAt };
    }
    const outcome = error?.permanent === true ? 'PERMANENT_FAILURE' : error?.retryable === true ? 'RETRYABLE_FAILURE' : classifyDeliveryFailure(error);
    return { outcome, providerStatusCode: Number(error?.status ?? error?.statusCode) || null, safeError: String(error?.message ?? 'Provider call failed.').slice(0, 300), startedAt };
  }
}

/** Provider channel list for a rule/step, validated and de-duplicated. */
export function normalizeChannels(channels) {
  if (!Array.isArray(channels) || !channels.length) return ['DISCORD'];
  const unique = [...new Set(channels)];
  for (const channel of unique) if (!NOTIFICATION_CHANNELS.includes(channel)) throw new Error(`Unsupported notification channel ${channel}.`);
  return unique;
}

/**
 * The M-001 compact summary written next to the routing record. Detailed truth
 * lives in the delivery and attempt rows; this keeps existing clients working.
 */
export function routingSummaryFor({ outcome, provider, error }) {
  if (outcome === 'SENT') return { status: 'SENT', provider, error: null, notifiedAt: new Date().toISOString() };
  return { status: 'FAILED', provider, error: error ?? 'Delivery failed.', notifiedAt: null };
}
