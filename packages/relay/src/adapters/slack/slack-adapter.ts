/**
 * Slack adapter for the Relay message bus.
 *
 * Thin facade composing inbound parsing and outbound delivery sub-modules
 * into a single cohesive adapter class. Uses Socket Mode via @slack/bolt
 * for receiving events without requiring a public URL.
 *
 * @module relay/adapters/slack-adapter
 */
import { App, LogLevel } from '@slack/bolt';
import type { AdapterManifest, RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { SlackAdapterConfig } from '@dorkos/shared/relay-schemas';
import { BaseRelayAdapter } from '../../base-adapter.js';
import type {
  RelayPublisher, AdapterContext, DeliveryResult,
  AdapterInboundCallbacks, AdapterOutboundCallbacks,
} from '../../types.js';
import {
  SUBJECT_PREFIX,
  handleInboundMessage,
  clearCaches,
} from './inbound.js';
import { deliverMessage } from './outbound.js';
import type { ActiveStream } from './outbound.js';

/**
 * Slack App Manifest YAML for one-click app creation.
 *
 * Pre-fills Socket Mode, bot events, and OAuth scopes so users
 * don't need to manually configure each setting.
 *
 * CRITICAL: Do NOT include `user` scopes. The "Agents & AI Apps" feature
 * in Slack silently adds user-level scopes that cause `invalid_scope`
 * errors on most workspace plans.
 */
const SLACK_APP_MANIFEST_YAML = `display_information:
  name: DorkOS Relay
settings:
  socket_mode_enabled: true
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
      - message.im
      - app_mention
features:
  bot_user:
    display_name: DorkOS Relay
    always_online: false
oauth_config:
  scopes:
    bot:
      - channels:history
      - channels:read
      - chat:write
      - groups:history
      - groups:read
      - im:history
      - im:read
      - im:write
      - mpim:history
      - app_mentions:read
      - users:read
      - reactions:write`;

/** Slack's app creation URL with pre-filled manifest for one-click setup. */
const SLACK_CREATE_APP_URL = `https://api.slack.com/apps?new_app=1&manifest_yaml=${encodeURIComponent(SLACK_APP_MANIFEST_YAML)}`;

/** Static adapter manifest for the Slack built-in adapter. */
export const SLACK_MANIFEST: AdapterManifest = {
  type: 'slack',
  displayName: 'Slack',
  description: 'Send and receive messages in Slack channels and DMs.',
  iconEmoji: '#',
  category: 'messaging',
  docsUrl: 'https://api.slack.com/start',
  builtin: true,
  multiInstance: true,
  actionButton: {
    label: 'Open Slack App Setup',
    url: SLACK_CREATE_APP_URL,
  },
  setupSteps: [
    {
      stepId: 'create-app',
      title: 'Step 1 of 3 — Create your Slack bot',
      description: 'Takes about 2 minutes — Slack walks you through it.',
      fields: [],
    },
    {
      stepId: 'bot-token',
      title: 'Step 2 of 3 — Paste your Bot Key',
      description: "Go to your Slack app and copy the Bot Key. It starts with xoxb- and is found under OAuth & Permissions.",
      fields: ['botToken'],
    },
    {
      stepId: 'credentials',
      title: 'Step 3 of 3 — Paste two more codes',
      description: "Almost done. Copy two more codes from Slack and paste them below. Use \"Where do I find this?\" if you get stuck.",
      fields: ['appToken', 'signingSecret', 'streaming', 'typingIndicator'],
    },
  ],
  configFields: [
    {
      key: 'botToken',
      label: 'Bot Key',
      type: 'password',
      required: true,
      placeholder: 'xoxb-...',
      description: 'Starts with xoxb- \u00b7 Paste from your Slack app \u2192 OAuth & Permissions',
      pattern: '^xoxb-',
      patternMessage: 'Bot keys start with xoxb- — double-check you copied the right one',
      visibleByDefault: true,
      helpMarkdown: `**Where to find this:**

1. Open [api.slack.com/apps](https://api.slack.com/apps) and select your app
2. Click **OAuth & Permissions** in the left sidebar
3. Look for **Bot User OAuth Token** — it starts with \`xoxb-\`
4. Click **Copy** and paste it here`,
    },
    {
      key: 'appToken',
      label: 'Connection Token',
      type: 'password',
      required: true,
      placeholder: 'xapp-...',
      description: 'Starts with xapp- \u00b7 Paste from your Slack app \u2192 Basic Information \u2192 App-Level Tokens',
      pattern: '^xapp-',
      patternMessage: 'Connection tokens start with xapp- — double-check you copied the right one',
      visibleByDefault: true,
      helpMarkdown: `**Where to find this:**

1. Open [api.slack.com/apps](https://api.slack.com/apps) and select your app
2. Click **Basic Information** in the left-hand menu
3. Scroll down until you see a section titled **App-Level Tokens**
4. Click the **Generate Token and Scopes** button
5. Type any name in the box (e.g. "botinfra"), then click **Add Scope** and select \`connections:write\`
6. Click **Generate** — a long code will appear
7. Click **Copy** and paste it above

**What it looks like:** a long code starting with \`xapp-\`
> Example: \`xapp-1-A12345678-1234567890123-abcdef1234567890abcdef1234567890\``,
    },
    {
      key: 'signingSecret',
      label: 'Security Code',
      type: 'password',
      required: true,
      placeholder: 'abc123...',
      description: 'Paste from your Slack app \u2192 Basic Information \u2192 App Credentials',
      helpMarkdown: `**Where to find this:**

1. Open [api.slack.com/apps](https://api.slack.com/apps) and select your app
2. Click **Basic Information** in the left-hand menu
3. Scroll down to the **App Credentials** section
4. Find the row labeled **Signing Secret** — it shows as dots (••••••••)
5. Click the **Show** button next to it to reveal the code
6. Click **Copy** and paste it above

**What it looks like:** a 32-character mix of letters and numbers
> Example: \`a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4\``,
    },
    {
      key: 'streaming',
      label: 'Show typing as it arrives',
      type: 'boolean',
      required: false,
      description: 'On: responses stream in word-by-word, like a live chat. Off: the agent sends one complete message when it finishes. Either works — this is just a preference.',
      visibleByDefault: true,
      section: 'Optional settings',
    },
    {
      key: 'typingIndicator',
      label: 'Show a "thinking" indicator',
      type: 'select',
      required: false,
      description: 'Adds a small signal while the agent is working on a reply, so people know it heard them.',
      options: [
        { label: 'Off — no indicator', value: 'none' },
        { label: '⏳ Hourglass emoji on the message', value: 'reaction' },
      ],
      visibleByDefault: true,
      section: 'Optional settings',
    },
    {
      key: 'requireMention',
      label: 'Only respond when mentioned',
      type: 'boolean',
      required: false,
      description: 'On: only respond when someone @mentions the bot in a channel. Off: respond to all messages. DMs always get a response either way.',
      section: 'Optional settings',
    },
  ],
  setupInstructions:
    '\u26a0\ufe0f One thing to watch for: when Slack asks about **"Agents & AI Apps"** \u2014 leave that **turned off**. ' +
    'Turning it on causes errors on most Slack accounts.',
};

/**
 * Slack adapter for the Relay message bus.
 *
 * Extends {@link BaseRelayAdapter} to bridge Slack channels and DMs
 * into the Relay subject hierarchy via Socket Mode. Delegates heavy
 * logic to inbound.ts and outbound.ts sub-modules.
 */
export class SlackAdapter extends BaseRelayAdapter {
  private readonly config: SlackAdapterConfig;
  private app: App | null = null;
  /** Bot's own user ID — cached after auth.test for echo prevention. */
  private botUserId = '';
  private streamState = new Map<string, ActiveStream>();

  constructor(id: string, config: SlackAdapterConfig, displayName = 'Slack') {
    super(id, SUBJECT_PREFIX, displayName);
    this.config = config;
  }

  /**
   * Validate credentials without starting Socket Mode.
   *
   * Creates a temporary WebClient, calls auth.test, and returns the result.
   * No side effects (no Socket Mode connection, no event listeners).
   */
  async testConnection(): Promise<{ ok: boolean; error?: string; botUsername?: string }> {
    try {
      // Import WebClient directly to avoid starting a full Bolt app
      const { WebClient } = await import('@slack/web-api');
      const tempClient = new WebClient(this.config.botToken);
      const result = await tempClient.auth.test();
      return { ok: true, botUsername: result.user as string | undefined };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Connect to Slack via Socket Mode and register event listeners. */
  protected async _start(relay: RelayPublisher): Promise<void> {
    const app = new App({
      token: this.config.botToken,
      appToken: this.config.appToken,
      signingSecret: this.config.signingSecret,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });

    // Cache bot's own user ID for echo prevention
    const authResult = await app.client.auth.test();
    this.botUserId = (authResult.user_id as string) ?? '';

    const requireMention = this.config.requireMention ?? false;

    // Register event listeners before starting.
    // app.message handles all messages (DMs + channels). app_mention is NOT registered
    // separately — Slack fires both for the same mention event, causing duplicate responses.
    // Instead, mention filtering is applied inside handleInboundMessage.
    app.message(async ({ event, client }) => {
      await handleInboundMessage(
        event as Parameters<typeof handleInboundMessage>[0],
        client,
        relay,
        this.botUserId,
        this.makeInboundCallbacks(),
        requireMention,
      );
    });

    // Surface unhandled listener errors through adapter status
    app.error(async (error) => {
      this.recordError(error);
    });

    // Start the Bolt app (Socket Mode connects automatically)
    await app.start();
    this.app = app;
  }

  /** Disconnect from Slack and clean up state. */
  protected async _stop(): Promise<void> {
    if (this.app) {
      try {
        await this.app.stop();
      } catch {
        // best-effort — app may already be disconnected
      }
      this.app = null;
    }
    this.botUserId = '';
    this.streamState.clear();
    clearCaches();
  }

  /**
   * Deliver a Relay message to Slack.
   *
   * Delegates to the outbound module for stream-aware delivery.
   *
   * @param subject - The target Relay subject (e.g. relay.human.slack.D123456)
   * @param envelope - The relay envelope to deliver
   * @param _context - Optional adapter context (unused by this adapter)
   */
  async deliver(
    subject: string,
    envelope: RelayEnvelope,
    _context?: AdapterContext,
  ): Promise<DeliveryResult> {
    return deliverMessage({
      adapterId: this.id,
      subject,
      envelope,
      client: this.app?.client ?? null,
      streamState: this.streamState,
      botUserId: this.botUserId,
      callbacks: this.makeOutboundCallbacks(),
      streaming: this.config.streaming ?? true,
      typingIndicator: this.config.typingIndicator ?? 'none',
    });
  }

  /** Build callbacks for inbound message handling. */
  private makeInboundCallbacks(): AdapterInboundCallbacks {
    return {
      trackInbound: () => this.trackInbound(),
      recordError: (err: unknown) => this.recordError(err),
    };
  }

  /** Build callbacks for outbound message delivery. */
  private makeOutboundCallbacks(): AdapterOutboundCallbacks {
    return {
      trackOutbound: () => this.trackOutbound(),
      recordError: (err: unknown) => this.recordError(err),
    };
  }
}
