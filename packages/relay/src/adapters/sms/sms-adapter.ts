/**
 * SMS (Twilio) adapter for the Relay message bus.
 *
 * Thin facade composing inbound webhook handling and outbound Twilio delivery
 * into a single cohesive adapter class. Receives messages via an HTTP webhook
 * server (Twilio POSTs inbound SMS here) and sends replies via the Twilio
 * Messages REST API.
 *
 * @module relay/adapters/sms-adapter
 */
import type { Server } from 'node:http';
import type { AdapterManifest, RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { SmsAdapterConfig } from '@dorkos/shared/relay-schemas';
import { BaseRelayAdapter } from '../../base-adapter.js';
import type {
  RelayPublisher,
  AdapterContext,
  DeliveryResult,
  AdapterInboundCallbacks,
  AdapterOutboundCallbacks,
} from '../../types.js';
import {
  SUBJECT_PREFIX,
  startWebhookServer,
  stopWebhookServer,
} from './inbound.js';
import { deliverMessage } from './outbound.js';
import type { TwilioClientLike } from './outbound.js';

/** Twilio SDK factory function signature (called without `new`). */
type TwilioFactory = (accountSid: string, authToken: string) => TwilioClientLike;

/** Extended Twilio client used only for testConnection (includes .api). */
type TwilioFullClient = TwilioClientLike & {
  api: { accounts(sid: string): { fetch(): Promise<unknown> } };
};

/** Static adapter manifest for the SMS built-in adapter. */
export const SMS_MANIFEST: AdapterManifest = {
  type: 'sms',
  displayName: 'SMS',
  description: 'Send and receive SMS messages via a Twilio phone number.',
  iconEmoji: '\uD83D\uDCF1',
  category: 'messaging',
  docsUrl: 'https://www.twilio.com/docs/sms',
  builtin: true,
  multiInstance: true,
  setupSteps: [
    {
      stepId: 'get-credentials',
      title: 'Get your Twilio credentials',
      description:
        'Log in to the Twilio Console and copy your Account SID, Auth Token, and a Twilio phone number.',
      fields: ['accountSid', 'authToken', 'fromNumber'],
    },
    {
      stepId: 'configure-webhook',
      title: 'Configure your webhook',
      description:
        'Set the inbound webhook port and optionally your public URL for request signature validation.',
      fields: ['webhookPort', 'webhookUrl'],
    },
  ],
  configFields: [
    {
      key: 'accountSid',
      label: 'Account SID',
      type: 'text',
      required: true,
      placeholder: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      description: 'Your Twilio Account SID from the Twilio Console dashboard.',
      pattern: '^AC[0-9a-fA-F]{32}$',
      patternMessage: 'Account SIDs start with AC followed by 32 hex characters',
      visibleByDefault: true,
      helpMarkdown: `1. Log in to the [Twilio Console](https://console.twilio.com)
2. Your **Account SID** is on the dashboard home page under **Account Info**
3. It starts with \`AC\` followed by 32 characters`,
    },
    {
      key: 'authToken',
      label: 'Auth Token',
      type: 'password',
      required: true,
      placeholder: 'your_auth_token',
      description: 'Your Twilio Auth Token. Used to authenticate API calls and validate webhooks.',
      helpMarkdown: `1. Log in to the [Twilio Console](https://console.twilio.com)
2. Your **Auth Token** is next to your Account SID on the dashboard home page
3. Click the eye icon to reveal it`,
    },
    {
      key: 'fromNumber',
      label: 'Twilio Phone Number',
      type: 'text',
      required: true,
      placeholder: '+14155552671',
      description: 'Your Twilio phone number in E.164 format (e.g. +14155552671).',
      pattern: '^\\+[1-9]\\d{7,14}$',
      patternMessage: 'Must be a valid E.164 number (e.g. +14155552671)',
      helpMarkdown: `1. In the [Twilio Console](https://console.twilio.com), go to **Phone Numbers → Manage → Active Numbers**
2. Copy any active number in E.164 format (starts with \`+\` and country code)
3. If you don't have a number, click **Buy a Number** to provision one`,
    },
    {
      key: 'webhookPort',
      label: 'Webhook Port',
      type: 'number',
      required: false,
      default: 8445,
      description: 'Local port for the inbound SMS webhook server.',
    },
    {
      key: 'webhookUrl',
      label: 'Public Webhook URL',
      type: 'url',
      required: false,
      placeholder: 'https://your-domain.com/twilio/sms',
      description:
        'Public HTTPS URL where Twilio POSTs inbound SMS. Required for request signature validation.',
      helpMarkdown: `Set this to the public URL that maps to this adapter's webhook port.
When set, the adapter validates the \`X-Twilio-Signature\` header on every incoming request.

**To configure in Twilio:**
1. Go to **Phone Numbers → Manage → Active Numbers**
2. Select your number
3. Under **Messaging**, set the webhook URL to this value
4. Set the HTTP method to **HTTP POST**

For local development, use a tunnel (e.g. ngrok, Cloudflare Tunnel) to expose your local port.`,
    },
  ],
};

/**
 * SMS adapter for the Relay message bus via Twilio.
 *
 * Extends {@link BaseRelayAdapter} to bridge SMS conversations into the Relay
 * subject hierarchy. Inbound messages arrive via Twilio webhook POSTs to a
 * local HTTP server; outbound messages are delivered via the Twilio REST API.
 */
export class SmsAdapter extends BaseRelayAdapter {
  private readonly config: SmsAdapterConfig;
  private twilioClient: TwilioClientLike | null = null;
  private webhookServer: Server | null = null;
  private responseBuffers = new Map<string, string>();

  constructor(id: string, config: SmsAdapterConfig, displayName = 'SMS') {
    super(id, SUBJECT_PREFIX, displayName);
    this.config = config;
  }

  /**
   * Validate Twilio credentials without starting the webhook server.
   *
   * Makes a lightweight API call (`accounts(sid).fetch()`) to confirm the
   * credentials are accepted by Twilio.
   */
  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const createClient = (await import('twilio')).default as unknown as TwilioFactory;
      const client = createClient(this.config.accountSid, this.config.authToken);
      await (client as TwilioFullClient).api.accounts(this.config.accountSid).fetch();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Connect to Twilio and start the inbound webhook server. */
  protected async _start(relay: RelayPublisher): Promise<void> {
    const createClient = (await import('twilio')).default as unknown as TwilioFactory;
    this.twilioClient = createClient(
      this.config.accountSid,
      this.config.authToken,
    );

    this.webhookServer = await startWebhookServer(
      this.config.webhookPort ?? 8445,
      this.config.webhookUrl,
      this.config.authToken,
      relay,
      this.makeInboundCallbacks(),
    );
  }

  /** Stop the webhook server and release the Twilio client. */
  protected async _stop(): Promise<void> {
    await stopWebhookServer(this.webhookServer);
    this.webhookServer = null;
    this.twilioClient = null;
    this.responseBuffers.clear();
  }

  /** Deliver a Relay message as an SMS. Delegates to the outbound module. */
  async deliver(
    subject: string,
    envelope: RelayEnvelope,
    _context?: AdapterContext,
  ): Promise<DeliveryResult> {
    return deliverMessage({
      adapterId: this.id,
      subject,
      envelope,
      client: this.twilioClient,
      fromNumber: this.config.fromNumber,
      responseBuffers: this.responseBuffers,
      callbacks: this.makeOutboundCallbacks(),
    });
  }

  /** Build callbacks for inbound message handling. */
  protected makeInboundCallbacks(): AdapterInboundCallbacks {
    return {
      trackInbound: () => this.trackInbound(),
      recordError: (err: unknown) => this.recordError(err),
    };
  }

  /** Build callbacks for outbound message delivery. */
  protected makeOutboundCallbacks(): AdapterOutboundCallbacks {
    return {
      trackOutbound: () => this.trackOutbound(),
      recordError: (err: unknown) => this.recordError(err),
    };
  }
}
