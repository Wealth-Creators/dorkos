/**
 * SMS (Twilio) inbound message handling.
 *
 * Runs a lightweight HTTP server that receives Twilio webhook POSTs,
 * validates the optional Twilio request signature, and publishes
 * normalised {@link StandardPayload} messages to the Relay bus.
 *
 * @module relay/adapters/sms-inbound
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { StandardPayload } from '@dorkos/shared/relay-schemas';
import type { RelayPublisher, AdapterInboundCallbacks } from '../../types.js';

// === Constants ===

/** Subject prefix for all SMS adapter subjects. */
export const SUBJECT_PREFIX = 'relay.human.sms';

/** Twilio's max SMS body length (multi-part concatenated). */
export const MAX_MESSAGE_LENGTH = 1_600;

/** Maximum inbound body size (32 KB). */
export const MAX_BODY_BYTES = 32_768;

// === Subject helpers ===

/**
 * Normalise an E.164 phone number into a relay-safe token.
 *
 * Strips the leading `+` so the number fits in a dot-separated subject
 * without special characters (e.g. `+14155552671` → `14155552671`).
 *
 * @param phone - E.164 phone number (with or without leading `+`)
 */
export function normalizePhone(phone: string): string {
  return phone.replace(/^\+/, '');
}

/**
 * Build the Relay subject for a given sender phone number.
 *
 * @param from - The sender's phone number in E.164 format
 */
export function buildSubject(from: string): string {
  return `${SUBJECT_PREFIX}.${normalizePhone(from)}`;
}

/**
 * Extract the E.164 phone number from a Relay subject.
 *
 * Returns null if the subject does not match the expected pattern.
 * The `+` prefix is re-added so the returned value is a valid E.164 number.
 *
 * @param subject - A Relay subject under the SMS prefix
 */
export function extractPhoneNumber(subject: string): string | null {
  if (!subject.startsWith(`${SUBJECT_PREFIX}.`)) return null;
  const normalized = subject.slice(`${SUBJECT_PREFIX}.`.length);
  if (!normalized) return null;
  return `+${normalized}`;
}

// === URL-encoded form body parser ===

/**
 * Parse a `application/x-www-form-urlencoded` string into a plain record.
 *
 * @param body - The raw request body string
 */
function parseFormBody(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of body.split('&')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = decodeURIComponent(pair.slice(0, idx).replace(/\+/g, ' '));
    const val = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
    result[key] = val;
  }
  return result;
}

// === Webhook server ===

/**
 * Start the Twilio inbound webhook HTTP server.
 *
 * Listens on `port`, validates the optional Twilio request signature
 * (when `webhookUrl` is provided), and publishes each inbound SMS to
 * the Relay as a {@link StandardPayload}.
 *
 * Always responds with an empty TwiML `<Response/>` so Twilio does not
 * auto-reply with an error to the sender.
 *
 * @param port - Local port to listen on
 * @param webhookUrl - Public URL registered in Twilio (used for signature validation)
 * @param authToken - Twilio Auth Token (used for signature validation)
 * @param relay - The relay publisher
 * @param callbacks - Callbacks to mutate adapter state
 */
export function startWebhookServer(
  port: number,
  webhookUrl: string | undefined,
  authToken: string,
  relay: RelayPublisher,
  callbacks: AdapterInboundCallbacks,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      void handleRequest(req, res, webhookUrl, authToken, relay, callbacks);
    });

    server.once('error', reject);
    server.listen(port, () => resolve(server));
  });
}

/**
 * Stop the webhook server, closing all idle connections.
 *
 * @param server - The HTTP server to stop, or null (no-op)
 */
export function stopWebhookServer(server: Server | null): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    if ('closeAllConnections' in server) {
      (server as { closeAllConnections(): void }).closeAllConnections();
    }
    server.close(() => resolve());
  });
}

// === Request handler ===

import type { IncomingMessage, ServerResponse } from 'node:http';

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  webhookUrl: string | undefined,
  authToken: string,
  relay: RelayPublisher,
  callbacks: AdapterInboundCallbacks,
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/xml' });
    res.end('<Response/>');
    return;
  }

  // Read body with size cap
  let rawBody = '';
  try {
    for await (const chunk of req) {
      rawBody += chunk as string;
      if (rawBody.length > MAX_BODY_BYTES) {
        res.writeHead(413, { 'Content-Type': 'text/xml' });
        res.end('<Response/>');
        return;
      }
    }
  } catch (err) {
    callbacks.recordError(err);
    res.writeHead(500, { 'Content-Type': 'text/xml' });
    res.end('<Response/>');
    return;
  }

  const params = parseFormBody(rawBody);

  // Optional Twilio signature validation
  if (webhookUrl) {
    const twilioSignature = req.headers['x-twilio-signature'];
    if (typeof twilioSignature === 'string') {
      const valid = await verifyTwilioSignature(authToken, twilioSignature, webhookUrl, params);
      if (!valid) {
        res.writeHead(403, { 'Content-Type': 'text/xml' });
        res.end('<Response/>');
        return;
      }
    }
  }

  const from = params['From'];
  const body = params['Body'];
  const messageSid = params['MessageSid'];

  if (!from || !body) {
    res.writeHead(400, { 'Content-Type': 'text/xml' });
    res.end('<Response/>');
    return;
  }

  const subject = buildSubject(from);
  const text = body.slice(0, MAX_BODY_BYTES);

  const payload: StandardPayload = {
    content: text,
    senderName: from,
    channelType: 'dm',
    responseContext: {
      platform: 'sms',
      maxLength: MAX_MESSAGE_LENGTH,
      supportedFormats: ['text'],
      instructions: `Reply to subject ${subject} to respond to this SMS.`,
    },
    platformData: {
      from,
      messageSid,
      to: params['To'],
    },
  };

  try {
    await relay.publish(subject, payload, {
      from: `${SUBJECT_PREFIX}.inbound`,
      replyTo: subject,
    });
    callbacks.trackInbound();
  } catch (err) {
    callbacks.recordError(err);
  }

  // Always send empty TwiML — agents reply via the Relay, not auto-reply
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end('<Response/>');
}

// === Twilio signature verification ===

/**
 * Verify a Twilio request signature using the Twilio SDK helper.
 *
 * Returns true if validation passes or if the Twilio library is unavailable
 * (graceful degradation). Returns false only on an explicit signature mismatch.
 *
 * @param authToken - Twilio Auth Token
 * @param signature - Value of the X-Twilio-Signature header
 * @param url - The full public URL the request was sent to
 * @param params - URL-decoded POST body parameters
 */
async function verifyTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>,
): Promise<boolean> {
  try {
    const twilio = await import('twilio');
    const validateRequest =
      (twilio as unknown as { validateRequest?: typeof import('twilio').validateRequest }).validateRequest
      ?? (twilio.default as unknown as { validateRequest?: typeof import('twilio').validateRequest }).validateRequest;

    if (typeof validateRequest !== 'function') return true; // graceful degradation

    return validateRequest(authToken, signature, url, params);
  } catch {
    return true; // graceful degradation if twilio is missing
  }
}
