import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SmsAdapter } from '../index.js';
import type { RelayPublisher } from '../../../types.js';

// --- node:http mock ---
const mockServerListen = vi.fn();
const mockServerClose = vi.fn();
let lastServerErrorHandler: ((err: Error) => void) | null = null;

class MockServer {
  on(_event: string, _handler: unknown) { return this; }

  once(event: string, handler: unknown) {
    if (event === 'error') lastServerErrorHandler = handler as (err: Error) => void;
    return this;
  }

  listen(_port: number, cb?: () => void) {
    mockServerListen(_port, cb);
    cb?.();
    return this;
  }

  close(cb?: (err?: Error) => void) {
    mockServerClose(cb);
    cb?.();
    return this;
  }

  closeAllConnections() {}
}

vi.mock('node:http', () => ({
  createServer: vi.fn(() => new MockServer()),
}));

// --- twilio mock ---
const mockAccountsFetch = vi.fn().mockResolvedValue({ sid: 'AC_test' });
const mockMessagesCreate = vi.fn().mockResolvedValue({ sid: 'SM_test' });

const MockTwilio = vi.fn(() => ({
  api: { accounts: vi.fn(() => ({ fetch: mockAccountsFetch })) },
  messages: { create: mockMessagesCreate },
}));

vi.mock('twilio', () => ({ default: MockTwilio }));

// --- Helpers ---

function buildRelay(): RelayPublisher {
  return {
    publish: vi.fn().mockResolvedValue({ messageId: 'm1', deliveredTo: 1 }),
    onSignal: vi.fn().mockReturnValue(() => {}),
  } as unknown as RelayPublisher;
}

const BASE_CONFIG = {
  accountSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  authToken: 'test_auth_token',
  fromNumber: '+15017122661',
  webhookPort: 8445,
};

describe('SmsAdapter lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastServerErrorHandler = null;
  });

  it('starts and transitions to connected', async () => {
    const adapter = new SmsAdapter('sms-1', BASE_CONFIG);
    const relay = buildRelay();

    await adapter.start(relay);

    expect(adapter.getStatus().state).toBe('connected');
    expect(mockServerListen).toHaveBeenCalledWith(8445, expect.any(Function));
  });

  it('is idempotent — second start() is a no-op', async () => {
    const adapter = new SmsAdapter('sms-1', BASE_CONFIG);
    const relay = buildRelay();

    await adapter.start(relay);
    await adapter.start(relay);

    expect(mockServerListen).toHaveBeenCalledTimes(1);
  });

  it('stops and transitions to disconnected', async () => {
    const adapter = new SmsAdapter('sms-1', BASE_CONFIG);
    const relay = buildRelay();

    await adapter.start(relay);
    await adapter.stop();

    expect(adapter.getStatus().state).toBe('disconnected');
    expect(mockServerClose).toHaveBeenCalledTimes(1);
  });

  it('exposes the sms subject prefix', () => {
    const adapter = new SmsAdapter('sms-1', BASE_CONFIG);
    expect(adapter.subjectPrefix).toBe('relay.human.sms');
  });

  it('testConnection returns ok on valid credentials', async () => {
    const adapter = new SmsAdapter('sms-1', BASE_CONFIG);
    const result = await adapter.testConnection();

    expect(result.ok).toBe(true);
    expect(mockAccountsFetch).toHaveBeenCalledTimes(1);
  });

  it('testConnection returns error on invalid credentials', async () => {
    mockAccountsFetch.mockRejectedValueOnce(new Error('Authentication error'));

    const adapter = new SmsAdapter('sms-1', BASE_CONFIG);
    const result = await adapter.testConnection();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Authentication error');
  });
});

describe('SmsAdapter.deliver', () => {
  it('delegates to Twilio messages.create', async () => {
    const adapter = new SmsAdapter('sms-1', BASE_CONFIG);
    const relay = buildRelay();
    await adapter.start(relay);

    const result = await adapter.deliver(
      'relay.human.sms.14155552671',
      {
        messageId: 'msg-1',
        from: 'relay.agent.my-agent',
        subject: 'relay.human.sms.14155552671',
        payload: { content: 'Hello from agent' },
        timestamp: new Date().toISOString(),
      } as Parameters<typeof adapter.deliver>[1],
    );

    expect(result.success).toBe(true);
    expect(mockMessagesCreate).toHaveBeenCalledWith({
      to: '+14155552671',
      from: BASE_CONFIG.fromNumber,
      body: 'Hello from agent',
    });
  });
});
