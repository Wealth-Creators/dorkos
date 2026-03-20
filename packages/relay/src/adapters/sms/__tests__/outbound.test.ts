import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deliverMessage } from '../outbound.js';
import type { TwilioClientLike } from '../outbound.js';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';

// Mock inbound.js constants/helpers
vi.mock('../inbound.js', () => ({
  SUBJECT_PREFIX: 'relay.human.sms',
  MAX_MESSAGE_LENGTH: 1_600,
  extractPhoneNumber: (subject: string) => {
    const prefix = 'relay.human.sms.';
    if (!subject.startsWith(prefix)) return null;
    const digits = subject.slice(prefix.length);
    return digits ? `+${digits}` : null;
  },
}));

// Mock payload-utils
vi.mock('../../../lib/payload-utils.js', () => ({
  extractPayloadContent: (payload: unknown) => {
    if (typeof payload === 'string') return payload;
    if (payload !== null && typeof payload === 'object') {
      const obj = payload as Record<string, unknown>;
      if (typeof obj.content === 'string') return obj.content;
    }
    return '';
  },
  detectStreamEventType: (payload: unknown) => {
    if (payload === null || typeof payload !== 'object') return null;
    const obj = payload as Record<string, unknown>;
    if (typeof obj.type !== 'string' || !('data' in obj)) return null;
    return obj.type;
  },
  extractTextDelta: (payload: unknown) => {
    if (payload === null || typeof payload !== 'object') return null;
    const obj = payload as Record<string, unknown>;
    if (obj.type !== 'text_delta') return null;
    const data = obj.data as Record<string, unknown> | undefined;
    return typeof data?.text === 'string' ? data.text : null;
  },
  extractErrorMessage: (payload: unknown) => {
    if (payload === null || typeof payload !== 'object') return null;
    const obj = payload as Record<string, unknown>;
    if (obj.type !== 'error') return null;
    const data = obj.data as Record<string, unknown> | undefined;
    return typeof data?.message === 'string' ? data.message : null;
  },
  truncateText: (text: string, maxLen: number) =>
    text.length <= maxLen ? text : `${text.slice(0, maxLen - 3)}...`,
  SILENT_EVENT_TYPES: new Set(['session_status', 'tool_call_start']),
  formatForPlatform: (content: string, _platform: string) => content,
}));

// === Helpers ===

function buildEnvelope(payload: unknown, from = 'relay.agent.test'): RelayEnvelope {
  return {
    messageId: 'msg-1',
    from,
    subject: 'relay.human.sms.14155552671',
    payload,
    timestamp: new Date().toISOString(),
  } as unknown as RelayEnvelope;
}

function buildClient(overrides?: Partial<TwilioClientLike>): TwilioClientLike {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({ sid: 'SM123' }),
      ...overrides?.messages,
    },
  };
}

const FROM = '+15017122661';
const SUBJECT = 'relay.human.sms.14155552671';

describe('deliverMessage', () => {
  let callbacks: { trackOutbound: ReturnType<typeof vi.fn>; recordError: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    callbacks = {
      trackOutbound: vi.fn(),
      recordError: vi.fn(),
    };
  });

  it('sends a standard text payload as SMS', async () => {
    const client = buildClient();
    const result = await deliverMessage({
      adapterId: 'sms-1',
      subject: SUBJECT,
      envelope: buildEnvelope({ content: 'Hello from agent' }),
      client,
      fromNumber: FROM,
      responseBuffers: new Map(),
      callbacks,
    });

    expect(result.success).toBe(true);
    expect(client.messages.create).toHaveBeenCalledWith({
      to: '+14155552671',
      from: FROM,
      body: 'Hello from agent',
    });
    expect(callbacks.trackOutbound).toHaveBeenCalledTimes(1);
  });

  it('returns error when client is null', async () => {
    const result = await deliverMessage({
      adapterId: 'sms-1',
      subject: SUBJECT,
      envelope: buildEnvelope('hello'),
      client: null,
      fromNumber: FROM,
      responseBuffers: new Map(),
      callbacks,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not started');
  });

  it('returns error for unrecognised subject', async () => {
    const result = await deliverMessage({
      adapterId: 'sms-1',
      subject: 'relay.human.telegram.123',
      envelope: buildEnvelope('hi'),
      client: buildClient(),
      fromNumber: FROM,
      responseBuffers: new Map(),
      callbacks,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot extract phone number');
  });

  it('skips echo (envelope from SMS subject prefix)', async () => {
    const client = buildClient();
    const result = await deliverMessage({
      adapterId: 'sms-1',
      subject: SUBJECT,
      envelope: buildEnvelope('ping', 'relay.human.sms.inbound'),
      client,
      fromNumber: FROM,
      responseBuffers: new Map(),
      callbacks,
    });

    expect(result.success).toBe(true);
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  it('accumulates text_delta chunks and flushes on done', async () => {
    const client = buildClient();
    const buffers = new Map<string, string>();
    const baseOpts = {
      adapterId: 'sms-1',
      subject: SUBJECT,
      client,
      fromNumber: FROM,
      responseBuffers: buffers,
      callbacks,
    };

    // First chunk
    await deliverMessage({
      ...baseOpts,
      envelope: buildEnvelope({ type: 'text_delta', data: { text: 'Hello ' } }),
    });
    expect(client.messages.create).not.toHaveBeenCalled();

    // Second chunk
    await deliverMessage({
      ...baseOpts,
      envelope: buildEnvelope({ type: 'text_delta', data: { text: 'world' } }),
    });
    expect(client.messages.create).not.toHaveBeenCalled();

    // Done event flushes
    await deliverMessage({
      ...baseOpts,
      envelope: buildEnvelope({ type: 'done', data: {} }),
    });
    expect(client.messages.create).toHaveBeenCalledWith({
      to: '+14155552671',
      from: FROM,
      body: 'Hello world',
    });
    expect(buffers.size).toBe(0);
  });

  it('flushes buffer with error notice on error event', async () => {
    const client = buildClient();
    const buffers = new Map<string, string>();
    buffers.set(SUBJECT, 'Partial response');

    await deliverMessage({
      adapterId: 'sms-1',
      subject: SUBJECT,
      envelope: buildEnvelope({ type: 'error', data: { message: 'timeout' } }),
      client,
      fromNumber: FROM,
      responseBuffers: buffers,
      callbacks,
    });

    expect(client.messages.create).toHaveBeenCalledOnce();
    const body = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0].body as string;
    expect(body).toContain('Partial response');
    expect(body).toContain('[Error: timeout]');
  });

  it('records error and returns failure when Twilio throws', async () => {
    const client: TwilioClientLike = {
      messages: {
        create: vi.fn().mockRejectedValue(new Error('invalid number')),
      },
    };

    const result = await deliverMessage({
      adapterId: 'sms-1',
      subject: SUBJECT,
      envelope: buildEnvelope('hi'),
      client,
      fromNumber: FROM,
      responseBuffers: new Map(),
      callbacks,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid number');
    expect(callbacks.recordError).toHaveBeenCalledOnce();
    expect(callbacks.trackOutbound).not.toHaveBeenCalled();
  });

  it('silently skips SILENT_EVENT_TYPES', async () => {
    const client = buildClient();

    const result = await deliverMessage({
      adapterId: 'sms-1',
      subject: SUBJECT,
      envelope: buildEnvelope({ type: 'session_status', data: {} }),
      client,
      fromNumber: FROM,
      responseBuffers: new Map(),
      callbacks,
    });

    expect(result.success).toBe(true);
    expect(client.messages.create).not.toHaveBeenCalled();
  });
});
