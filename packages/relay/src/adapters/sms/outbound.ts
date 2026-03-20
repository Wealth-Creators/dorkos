/**
 * SMS (Twilio) outbound message delivery.
 *
 * Handles deliver() implementation including StreamEvent-aware buffering
 * (accumulate text_delta chunks, flush on done/error) and truncation to
 * Twilio's 1 600-character concatenated SMS limit.
 *
 * @module relay/adapters/sms-outbound
 */
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { AdapterOutboundCallbacks, DeliveryResult } from '../../types.js';
import {
  extractPayloadContent,
  detectStreamEventType,
  extractTextDelta,
  extractErrorMessage,
  truncateText,
  SILENT_EVENT_TYPES,
  formatForPlatform,
} from '../../lib/payload-utils.js';
import { extractPhoneNumber, SUBJECT_PREFIX, MAX_MESSAGE_LENGTH } from './inbound.js';

// === Types ===

/** Minimal Twilio messages.create interface (avoids importing the full type). */
interface TwilioMessagesClient {
  create(opts: { to: string; from: string; body: string }): Promise<{ sid: string }>;
}

/** Minimal Twilio client interface used by the outbound module. */
export interface TwilioClientLike {
  messages: TwilioMessagesClient;
}

/** Options for delivering a Relay message via SMS. */
export interface SmsDeliverOptions {
  adapterId: string;
  subject: string;
  envelope: RelayEnvelope;
  client: TwilioClientLike | null;
  fromNumber: string;
  responseBuffers: Map<string, string>;
  callbacks: AdapterOutboundCallbacks;
}

// === Delivery ===

/**
 * Deliver a Relay message as an SMS to the phone number derived from the subject.
 *
 * Extracts the recipient number from the subject, reads the payload, and
 * sends via the Twilio REST API. Content is converted to plain text (markdown
 * stripped) and truncated to Twilio's 1 600-character limit.
 *
 * StreamEvent payloads are buffered per-subject and flushed as a single SMS
 * on the 'done' event, keeping concatenated message costs predictable.
 *
 * @param opts - Delivery options
 */
export async function deliverMessage(opts: SmsDeliverOptions): Promise<DeliveryResult> {
  const { adapterId, subject, envelope, client, fromNumber, responseBuffers, callbacks } = opts;
  const startTime = Date.now();

  // Guard: skip messages that originated from this adapter (echo prevention).
  if (envelope.from.startsWith(SUBJECT_PREFIX)) {
    return { success: true, durationMs: Date.now() - startTime };
  }

  if (!client) {
    return {
      success: false,
      error: `SmsAdapter(${adapterId}): not started`,
      durationMs: Date.now() - startTime,
    };
  }

  const to = extractPhoneNumber(subject);
  if (!to) {
    return {
      success: false,
      error: `SmsAdapter(${adapterId}): cannot extract phone number from subject '${subject}'`,
      durationMs: Date.now() - startTime,
    };
  }

  // --- StreamEvent-aware delivery ---
  const eventType = detectStreamEventType(envelope.payload);

  if (eventType) {
    // text_delta: accumulate in buffer
    const textChunk = extractTextDelta(envelope.payload);
    if (textChunk) {
      const existing = responseBuffers.get(subject) ?? '';
      responseBuffers.set(subject, existing + textChunk);
      return { success: true, durationMs: Date.now() - startTime };
    }

    // error: flush buffer + append error notice
    const errorMsg = extractErrorMessage(envelope.payload);
    if (errorMsg) {
      const buffered = responseBuffers.get(subject) ?? '';
      responseBuffers.delete(subject);
      const text = buffered
        ? truncateText(`${buffered}\n\n[Error: ${errorMsg}]`, MAX_MESSAGE_LENGTH)
        : truncateText(`[Error: ${errorMsg}]`, MAX_MESSAGE_LENGTH);
      return sendAndTrack(client, to, fromNumber, text, startTime, callbacks);
    }

    // done: flush accumulated buffer as a single SMS
    if (eventType === 'done') {
      const buffered = responseBuffers.get(subject);
      responseBuffers.delete(subject);
      if (buffered) {
        const text = truncateText(formatForPlatform(buffered, 'plain'), MAX_MESSAGE_LENGTH);
        return sendAndTrack(client, to, fromNumber, text, startTime, callbacks);
      }
      return { success: true, durationMs: Date.now() - startTime };
    }

    // All other StreamEvent types: silently skip
    if (SILENT_EVENT_TYPES.has(eventType)) {
      return { success: true, durationMs: Date.now() - startTime };
    }
  }

  // --- Standard payload (non-StreamEvent) ---
  const raw = extractPayloadContent(envelope.payload);
  const text = truncateText(formatForPlatform(raw, 'plain'), MAX_MESSAGE_LENGTH);
  return sendAndTrack(client, to, fromNumber, text, startTime, callbacks);
}

// === Helpers ===

/**
 * Send an SMS via Twilio and record the delivery outcome.
 *
 * @param client - Twilio client instance
 * @param to - Recipient E.164 phone number
 * @param from - Sender (Twilio) E.164 phone number
 * @param body - Message body (already truncated)
 * @param startTime - Timestamp (ms) for duration calculation
 * @param callbacks - Callbacks to mutate adapter state
 */
async function sendAndTrack(
  client: TwilioClientLike,
  to: string,
  from: string,
  body: string,
  startTime: number,
  callbacks: AdapterOutboundCallbacks,
): Promise<DeliveryResult> {
  try {
    await client.messages.create({ to, from, body });
    callbacks.trackOutbound();
    return { success: true, durationMs: Date.now() - startTime };
  } catch (err) {
    callbacks.recordError(err);
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
    };
  }
}
