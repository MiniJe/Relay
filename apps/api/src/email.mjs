import { buildPageText, sanitizeNotificationText } from '../../../packages/shared/escalation.mjs';

// ---------------------------------------------------------------------------
// Relay 0.2 / RLY-0.2-M-002 — responder email paging over SMTP.
//
// SMTP protocol handling is delegated to nodemailer; Relay only chooses the
// recipient (the resolved responder's canonical Relay account email), builds a
// bounded plain-text message and classifies the outcome. The recipient is never
// taken from alert content, so an alert can never choose who gets an email.
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10_000;

/** Strip anything that could break a header out of its own line. */
export function headerSafeValue(value, maxLength = 200) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/** Build a quoted display name that cannot terminate the header early. */
export function formatFromAddress(fromEmail, fromName) {
  const address = headerSafeValue(fromEmail, 320);
  const name = headerSafeValue(fromName, 120).replace(/["\\]/g, '');
  return name ? `"${name}" <${address}>` : address;
}

export function emailSubject({ alert, escalation }) {
  const severity = headerSafeValue(alert?.severity ?? 'alert', 40).toUpperCase();
  const title = headerSafeValue(alert?.title ?? 'Untitled alert', 160);
  const prefix = escalation?.policyNameSnapshot ? `Escalation step ${Number(escalation.stepPosition ?? 0) + 1}: ` : '';
  return `[${severity}] ${prefix}${title}`.slice(0, 240);
}

export function emailBody({ alert, service, routing, escalation, responderDisplayName }) {
  return buildPageText({ alert, service, routing, escalation, responderDisplayName });
}

/**
 * A minimal HTML alternative. Every interpolated value is escaped and the
 * canonical message is still the plain-text part, so a rendering problem can
 * never change what the responder is being told.
 */
export function emailHtml({ alert, service, routing, escalation, responderDisplayName }) {
  const escape = (value) => sanitizeNotificationText(value ?? '', 2000).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rows = [
    ['Severity', escape(alert?.severity ?? 'unknown')],
    ['Source', escape(alert?.source ?? 'unknown')],
    ['Service', escape(service?.name ?? 'Not specified')],
    ['On call', escape(responderDisplayName ?? 'Unassigned')],
    ['Routed via', escape([routing?.ruleName, routing?.scheduleName, routing?.teamName].filter(Boolean).join(' → ') || 'Direct schedule')],
    ['Escalation', escape(escalation?.policyNameSnapshot ? `${escalation.policyNameSnapshot} — step ${Number(escalation.stepPosition ?? 0) + 1} (${escalation.afterMinutes} min)` : 'Immediate page')],
    ['Observed', escape(alert?.observedAt ?? '')]
  ];
  return `<div><h2>${escape(alert?.title ?? 'Untitled alert')}</h2><table>${rows.map(([k, v]) => `<tr><th align="left">${k}</th><td>${v}</td></tr>`).join('')}</table><pre>${escape(alert?.description ?? '')}</pre><p>Acknowledge this alert in the Relay alerts workspace.</p></div>`;
}

/**
 * SMTP transport options. The password is read from the encrypted integration
 * secret here and never leaves this function; callers never see it.
 */
export function smtpTransportOptions({ integration, encryptionKey, decryptSecret }) {
  const config = integration?.config ?? {};
  const password = readSmtpPassword({ integration, encryptionKey, decryptSecret });
  const options = {
    host: config.host,
    port: Number(config.port),
    secure: config.secure === true,
    connectionTimeout: Number(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    greetingTimeout: Number(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    socketTimeout: Number(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    tls: { minVersion: 'TLSv1.2' },
    // Pooling would keep sockets open across worker ticks; a page is rare
    // enough that a fresh connection is simpler to reason about.
    pool: false
  };
  if (config.username) options.auth = { user: config.username, pass: password ?? '' };
  return options;
}

function readSmtpPassword({ integration, encryptionKey, decryptSecret }) {
  if (!integration?.secretEncrypted) return undefined;
  let decoded;
  try { decoded = JSON.parse(decryptSecret(integration.secretEncrypted, encryptionKey)); }
  catch { throw Object.assign(new Error('Stored SMTP credential could not be decrypted.'), { permanent: true }); }
  const password = typeof decoded?.password === 'string' && decoded.password ? decoded.password : undefined;
  if (!password) throw Object.assign(new Error('Stored SMTP credential is missing its password.'), { permanent: true });
  return password;
}

/** Serialize the SMTP secret for storage. Never logged, never returned. */
export function encodeSmtpSecret(password) {
  return JSON.stringify({ password });
}

export function defaultTransporterFactory(options) {
  return import('nodemailer').then(({ default: nodemailer }) => nodemailer.createTransport(options));
}

/**
 * Send one responder page. Throws a classified error on failure:
 * `retryable`/`permanent` are set from the SMTP response code so the worker's
 * bounded retry policy behaves identically across providers.
 */
export async function sendResponderEmail({ integration, encryptionKey, alert, service, routing, escalation, responderDisplayName, recipient, transporterFactory, decryptSecret }) {
  if (!integration?.enabled) return { skipped: true };
  const to = headerSafeValue(recipient, 320);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    throw Object.assign(new Error('The resolved responder has no usable account email address.'), { permanent: true });
  }
  const config = integration.config ?? {};
  const options = smtpTransportOptions({ integration, encryptionKey, decryptSecret });
  const from = formatFromAddress(config.fromEmail, config.fromName);
  const message = {
    from,
    to,
    subject: emailSubject({ alert, escalation }),
    text: emailBody({ alert, service, routing, escalation, responderDisplayName }),
    html: emailHtml({ alert, service, routing, escalation, responderDisplayName })
  };
  const transporter = await (transporterFactory ?? defaultTransporterFactory)(options);
  try {
    const info = await transporter.sendMail(message);
    const accepted = Array.isArray(info?.accepted) ? info.accepted.length : undefined;
    if (accepted === 0) {
      throw Object.assign(new Error('The SMTP server rejected the responder address.'), { permanent: true });
    }
    return { skipped: false, status: Number(info?.responseCode ?? 250) };
  } finally {
    try { transporter.close?.(); } catch { /* transport already closed */ }
  }
}

/**
 * Map a nodemailer/SMTP failure onto the shared classification. SMTP 4xx is a
 * temporary failure the server asked us to retry; 5xx is permanent.
 */
export function classifySmtpError(error) {
  if (error?.permanent === true) return { outcome: 'PERMANENT_FAILURE', statusCode: Number(error.responseCode) || null, safeError: headerSafeValue(error.message, 300) };
  if (error?.retryable === true) return { outcome: 'RETRYABLE_FAILURE', statusCode: Number(error.responseCode) || null, safeError: headerSafeValue(error.message, 300) };
  const responseCode = Number(error?.responseCode);
  if (Number.isInteger(responseCode) && responseCode >= 500) return { outcome: 'PERMANENT_FAILURE', statusCode: responseCode, safeError: headerSafeValue(error.message, 300) };
  if (Number.isInteger(responseCode) && responseCode >= 400) return { outcome: 'RETRYABLE_FAILURE', statusCode: responseCode, safeError: headerSafeValue(error.message, 300) };
  const code = String(error?.code ?? '').toUpperCase();
  if (code === 'EAUTH' || code === 'EENVELOPE' || code === 'EMESSAGE' || code === 'EADDRESS' || code === 'EPROTOCOL') {
    return { outcome: 'PERMANENT_FAILURE', statusCode: null, safeError: headerSafeValue(error.message, 300) };
  }
  return { outcome: 'RETRYABLE_FAILURE', statusCode: null, safeError: headerSafeValue(error?.message ?? 'SMTP delivery failed.', 300) };
}
