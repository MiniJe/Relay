import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSlackWebhookUrl, sendSlackAlertNotification, slackAlertPayload } from '../apps/api/src/slack.mjs';
import { classifySmtpError, emailHtml, emailSubject, encodeSmtpSecret, formatFromAddress, sendResponderEmail } from '../apps/api/src/email.mjs';
import { classifyDeliveryFailure, planAfterAttempt, sanitizeSlackText, summarizeDeliveries } from '../packages/shared/escalation.mjs';
import { decryptSecret, encryptSecret } from '../apps/api/src/security.mjs';
import { smtpIntegrationInput, slackWebhookUrl } from '../packages/shared/validation.mjs';

// Relay 0.2 / RLY-0.2-M-002 — provider adapters.
//
// No real Discord, Slack or SMTP traffic is ever generated here: the Slack
// adapter is driven through an injected `fetchImpl` and the SMTP adapter
// through an injected nodemailer-style transport factory.

const KEY = 'provider-test-encryption-key';
const SLACK_URL = 'https://hooks.slack.com/services/T0000000/B0000000/super-secret-slack-token';
const SMTP_PASSWORD = 'smtp-secret-password';

const alert = { id: 'alert-1', title: 'Checkout p95 latency', description: 'p95 above 900ms', severity: 'critical', source: 'synthetic-monitor', observedAt: '2026-02-01T10:00:00.000Z', receivedAt: '2026-02-01T10:00:01.000Z' };
const routing = { ruleName: 'Checkout criticals', scheduleName: 'Primary on-call', teamName: 'Core Platform', oncallDisplayName: 'Ada Lovelace', timeZone: 'UTC' };
const service = { name: 'Checkout API' };
const slackIntegration = { enabled: true, name: 'Paging', secretEncrypted: encryptSecret(SLACK_URL, KEY) };
const smtpIntegration = {
  enabled: true,
  name: 'Email',
  secretEncrypted: encryptSecret(encodeSmtpSecret(SMTP_PASSWORD), KEY),
  config: { host: 'smtp.relay.test', port: 587, secure: false, username: 'relay@relay.test', fromEmail: 'relay@relay.test', fromName: 'Relay Paging' }
};

test('only Slack Incoming Webhook endpoints are stored or called', () => {
  assert.equal(slackWebhookUrl(SLACK_URL), SLACK_URL);
  for (const hostile of [
    'https://hooks.slack.com.evil.test/services/T/B/x',
    'http://hooks.slack.com/services/T/B/x',
    'https://evil.test/services/T/B/x',
    'https://slack.com/api/chat.postMessage',
    'https://hooks.slack.com/',
    'https://hooks.slack.com/services/T/B',
    'https://localhost:8080/services/T/B/x',
    'https://hooks.slack.com/services/T/B/x?redirect=https://evil.test'
  ]) {
    assert.throws(() => slackWebhookUrl(hostile), (error) => error?.code === 'VALIDATION_ERROR', `must reject ${hostile}`);
  }
  assert.equal(assertSlackWebhookUrl(SLACK_URL), SLACK_URL);
  assert.throws(() => assertSlackWebhookUrl('https://evil.test/services/T/B/x'), /allowed Slack HTTPS endpoint/);
  assert.throws(() => assertSlackWebhookUrl('https://hooks.slack.com/team/T/B/x'), /Incoming Webhook path/);
});

test('Slack payloads neutralize every alert-controlled mention primitive', () => {
  const payload = slackAlertPayload({
    alert: { ...alert, title: '<!channel> @here <@U123456> <!everyone> @channel <!subteam^S123> deploy failed', description: '<!here> ping <@U999>' },
    service, routing, responderDisplayName: 'Ada Lovelace'
  });
  for (const token of ['<!channel>', '<!here>', '<!everyone>', '<!subteam^S123>', '<@U123456>', '<@U999>']) {
    assert.equal(payload.text.includes(token), false, `${token} must not survive sanitization`);
  }
  assert.equal(payload.text.includes('@ channel'), true, 'broadcast mentions read as inert text');
  assert.equal(Object.hasOwn(payload, 'parse'), false, 'Relay never asks Slack to resolve names');
  assert.equal(Object.hasOwn(payload, 'link_names'), false);
  assert.match(payload.text, /deploy failed/);
  assert.equal(sanitizeSlackText('@channel <!here> <@U1> <https://example.com|docs> <!subteam^S123>'), '@ channel here user https://example.com subteam^S123');
});

test('Slack delivery attaches an HTTP status so the retry policy can classify it', async () => {
  const calls = [];
  const ok = await sendSlackAlertNotification({
    integration: slackIntegration, encryptionKey: KEY, alert, service, routing,
    fetchImpl: async (url, request) => { calls.push({ url: String(url), body: JSON.parse(request.body) }); return new Response('ok', { status: 200 }); }
  });
  assert.equal(ok.status, 200);
  assert.equal(calls[0].url, SLACK_URL);
  assert.equal(typeof calls[0].body.text, 'string');

  for (const [status, expected] of [[429, 'RETRYABLE_FAILURE'], [408, 'RETRYABLE_FAILURE'], [503, 'RETRYABLE_FAILURE'], [400, 'PERMANENT_FAILURE'], [404, 'PERMANENT_FAILURE']]) {
    const error = await sendSlackAlertNotification({
      integration: slackIntegration, encryptionKey: KEY, alert, service, routing,
      fetchImpl: async () => new Response('nope', { status })
    }).then(() => undefined, (thrown) => thrown);
    assert.ok(error, `HTTP ${status} must reject`);
    assert.equal(classifyDeliveryFailure(error), expected, `HTTP ${status} must classify as ${expected}`);
    assert.equal(String(error.message).includes('super-secret-slack-token'), false, 'the failure detail never carries the webhook token');
  }

  // A disabled integration is never called at all.
  const disabled = await sendSlackAlertNotification({ integration: { ...slackIntegration, enabled: false }, encryptionKey: KEY, alert, service, routing, fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.equal(disabled.skipped, true);
});

test('SMTP messages carry a safe recipient, subject and body and never expose the password', async () => {
  const sent = [];
  const transporterFactory = async (options) => {
    sent.push({ options });
    return { sendMail: async (message) => { sent.push({ message }); return { accepted: ['ada@relay.test'], responseCode: 250 }; }, close: () => {} };
  };
  const result = await sendResponderEmail({
    integration: smtpIntegration, encryptionKey: KEY, alert, service, routing, responderDisplayName: 'Ada Lovelace',
    recipient: 'ada@relay.test', transporterFactory, decryptSecret
  });
  assert.equal(result.status, 250);
  assert.equal(sent[0].options.auth.pass, SMTP_PASSWORD, 'the password reaches nodemailer and nothing else');
  assert.equal(sent[0].options.auth.user, 'relay@relay.test');
  assert.equal(sent[0].options.secure, false);
  assert.equal(sent[0].options.tls.minVersion, 'TLSv1.2');
  assert.ok(sent[0].options.connectionTimeout > 0 && sent[0].options.socketTimeout > 0);
  assert.equal(sent[0].options.pool, false);
  const message = sent[1].message;
  assert.equal(message.to, 'ada@relay.test');
  assert.equal(message.from, '"Relay Paging" <relay@relay.test>');
  assert.equal(message.subject, '[CRITICAL] Checkout p95 latency');
  assert.match(message.text, /Checkout p95 latency/);
  assert.match(message.text, /Ada Lovelace/);
  assert.equal(JSON.stringify(message).includes(SMTP_PASSWORD), false, 'the password is never part of the message');

  // Header injection: nothing that ends up in a header may carry a line break.
  const hostileSubject = emailSubject({ alert: { ...alert, severity: 'critical\r\nBcc: attacker@evil.test' } });
  assert.equal(/[\r\n]/.test(hostileSubject), false);
  assert.match(hostileSubject, /BCC: ATTACKER@EVIL\.TEST/, 'the injected text is rendered inertly inside the subject');
  assert.equal(formatFromAddress('relay@relay.test', 'Relay "Ops"\r\nBcc: x'), '"Relay Ops Bcc: x" <relay@relay.test>');
  assert.equal(/[\r\n]/.test(formatFromAddress('relay@relay.test', 'Relay\r\nBcc: x')), false);
  assert.equal(emailHtml({ alert, service, routing }).includes('<script'), false);
});

test('an alert can never choose its own email recipient', async () => {
  const transporterFactory = async () => ({ sendMail: async () => ({ accepted: [], responseCode: 250 }), close: () => {} });
  const error = await sendResponderEmail({
    integration: smtpIntegration, encryptionKey: KEY,
    alert: { ...alert, title: 'page attacker@evil.test', description: 'Bcc: attacker@evil.test' },
    service, routing, responderDisplayName: 'Ada',
    recipient: 'attacker@evil.test\nBcc: victim@relay.test', transporterFactory, decryptSecret
  }).then(() => undefined, (thrown) => thrown);
  assert.ok(error, 'a header-injecting recipient must be refused before send');
  assert.equal(classifySmtpError(error).outcome, 'PERMANENT_FAILURE');
  assert.equal(String(error.message).includes(SMTP_PASSWORD), false);
});

test('SMTP failures classify temporary, permanent and authentication responses correctly', async () => {
  const permanent = Object.assign(new Error('550 5.1.1 mailbox unavailable'), { responseCode: 550 });
  const temporary = Object.assign(new Error('451 4.3.0 try again later'), { responseCode: 451 });
  const auth = Object.assign(new Error('535 authentication failed'), { code: 'EAUTH' });
  const network = Object.assign(new Error('connection timed out'), { code: 'ETIMEDOUT' });
  const undecryptable = Object.assign(new Error('Stored SMTP credential could not be decrypted.'), { permanent: true });
  assert.equal(classifySmtpError(permanent).outcome, 'PERMANENT_FAILURE');
  assert.equal(classifySmtpError(temporary).outcome, 'RETRYABLE_FAILURE');
  assert.equal(classifySmtpError(auth).outcome, 'PERMANENT_FAILURE');
  assert.equal(classifySmtpError(network).outcome, 'RETRYABLE_FAILURE');
  assert.equal(classifySmtpError(undecryptable).outcome, 'PERMANENT_FAILURE');

  const failing = async () => ({ sendMail: async () => { throw temporary; }, close: () => {} });
  const error = await sendResponderEmail({ integration: smtpIntegration, encryptionKey: KEY, alert, service, routing, recipient: 'ada@relay.test', transporterFactory: failing, decryptSecret }).then(() => undefined, (thrown) => thrown);
  assert.equal(classifySmtpError(error).outcome, 'RETRYABLE_FAILURE');
  assert.equal(String(error.message).includes(SMTP_PASSWORD), false);

  // A rejected envelope is permanent, and a wrong key is a configuration fault.
  const rejected = async () => ({ sendMail: async () => ({ accepted: [], responseCode: 250 }), close: () => {} });
  const rejectedError = await sendResponderEmail({ integration: smtpIntegration, encryptionKey: KEY, alert, service, routing, recipient: 'ada@relay.test', transporterFactory: rejected, decryptSecret }).then(() => undefined, (thrown) => thrown);
  assert.equal(classifySmtpError(rejectedError).outcome, 'PERMANENT_FAILURE');
  const wrongKey = await sendResponderEmail({ integration: smtpIntegration, encryptionKey: 'a-different-key', alert, service, routing, recipient: 'ada@relay.test', transporterFactory: failing, decryptSecret }).then(() => undefined, (thrown) => thrown);
  assert.equal(classifySmtpError(wrongKey).outcome, 'PERMANENT_FAILURE', 'an unreadable credential cannot be fixed by retrying');
});

test('SMTP configuration is validated without ever echoing secrets back', () => {
  const input = smtpIntegrationInput({ host: 'SMTP.Relay.Test', port: 587, secure: false, username: 'relay@relay.test', password: SMTP_PASSWORD, fromEmail: 'relay@relay.test', fromName: 'Relay' });
  assert.equal(input.host, 'smtp.relay.test');
  assert.equal(input.port, 587);
  assert.equal(input.secure, false);
  assert.equal(input.fromEmail, 'relay@relay.test');
  assert.equal(input.timeoutMs, 10_000);
  for (const bad of [
    { host: 'smtp.relay.test', port: 0, fromEmail: 'relay@relay.test' },
    { host: 'not a host', port: 587, fromEmail: 'relay@relay.test' },
    { host: 'smtp.relay.test', port: 587, secure: true, fromEmail: 'relay@relay.test' },
    { host: 'smtp.relay.test', port: 587, fromEmail: 'not-an-email' },
    { host: 'smtp.relay.test', port: 587, username: 'relay@relay.test' },
    { host: 'smtp.relay.test\r\nX-Evil: 1', port: 587, fromEmail: 'relay@relay.test' },
    { host: 'smtp.relay.test', port: 587, fromEmail: 'relay@relay.test', fromName: 'Relay\r\nBcc: attacker@evil.test' },
    { host: 'smtp.relay.test', port: 587, fromEmail: 'relay@relay.test', password: 'bad\npassword' }
  ]) {
    assert.throws(() => smtpIntegrationInput(bad), (error) => error?.code === 'VALIDATION_ERROR', `must reject ${JSON.stringify(bad)}`);
  }
  // Keeping an existing password is allowed for edits; it is never returned.
  const edited = smtpIntegrationInput({ host: 'smtp.relay.test', port: 587, username: 'relay@relay.test', keepExistingPassword: true });
  assert.equal(edited.password, undefined);
  assert.equal(JSON.stringify(edited).includes(SMTP_PASSWORD), false);
});

test('the bounded retry plan is deterministic and terminal at the limit', () => {
  assert.deepEqual(planAfterAttempt({ now: '2026-01-01T00:00:00Z', attemptNumber: 1, outcome: 'RETRYABLE_FAILURE' }), { status: 'RETRYING', nextAttemptAt: '2026-01-01T00:01:00.000Z', terminal: false });
  assert.deepEqual(planAfterAttempt({ now: '2026-01-01T00:01:00Z', attemptNumber: 2, outcome: 'RETRYABLE_FAILURE' }), { status: 'RETRYING', nextAttemptAt: '2026-01-01T00:06:00.000Z', terminal: false });
  assert.deepEqual(planAfterAttempt({ now: '2026-01-01T00:06:00Z', attemptNumber: 3, outcome: 'RETRYABLE_FAILURE' }), { status: 'FAILED', nextAttemptAt: null, terminal: true });
  assert.deepEqual(planAfterAttempt({ now: '2026-01-01T00:00:00Z', attemptNumber: 1, outcome: 'PERMANENT_FAILURE' }), { status: 'FAILED', nextAttemptAt: null, terminal: true });
  assert.equal(planAfterAttempt({ now: '2026-01-01T00:00:00Z', attemptNumber: 1, outcome: 'SENT' }).status, 'SENT');
  assert.throws(() => planAfterAttempt({ now: '2026-01-01T00:00:00Z', attemptNumber: 1, outcome: 'MAYBE' }));
  assert.equal(summarizeDeliveries([{ status: 'SENT', attemptCount: 1, provider: 'DISCORD' }]).label, 'Sent');
  assert.equal(summarizeDeliveries([{ status: 'RETRYING', attemptCount: 1, provider: 'SLACK' }]).label, 'Retry scheduled');
  assert.equal(summarizeDeliveries([]).label, 'No delivery');
});
