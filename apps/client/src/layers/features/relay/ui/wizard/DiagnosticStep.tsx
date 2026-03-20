import { useState, useEffect } from 'react';
import { CheckCircle2, XCircle, Copy, Check, ExternalLink } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '@/layers/shared/ui/button';
import { cn } from '@/layers/shared/lib';

/** Pre-filled Slack app manifest — sets Socket Mode, all required events and scopes. */
const SLACK_MANIFEST_JSON = JSON.stringify(
  {
    display_information: { name: 'DorkOS Relay' },
    features: { bot_user: { display_name: 'DorkOS Relay', always_online: false } },
    oauth_config: {
      scopes: {
        bot: [
          'channels:history', 'channels:read', 'chat:write',
          'groups:history', 'groups:read', 'im:history',
          'im:read', 'im:write', 'mpim:history',
          'app_mentions:read', 'users:read', 'reactions:write',
        ],
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: ['message.im', 'message.channels', 'message.groups', 'app_mention'],
      },
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  },
  null,
  2,
);

interface DiagnosticStepProps {
  adapterType: string;
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
  errorMessage?: string;
  botUsername?: string;
  onRetry: () => void;
  /** Notifies the parent when all checks are confirmed and the wizard can advance. */
  onReadyChange: (ready: boolean) => void;
}

/** Post-credentials diagnostic step — auto-verifies the connection and, for Slack, guides manual configuration. */
export function DiagnosticStep({
  adapterType,
  isPending,
  isSuccess,
  isError,
  errorMessage,
  botUsername,
  onRetry,
  onReadyChange,
}: DiagnosticStepProps) {
  const isSlack = adapterType === 'slack';
  const [eventsConfirmed, setEventsConfirmed] = useState(false);
  const [messagesConfirmed, setMessagesConfirmed] = useState(false);
  const [reinstallConfirmed, setReinstallConfirmed] = useState(false);
  const [openPanel, setOpenPanel] = useState<'events' | 'messages' | 'reinstall' | null>(null);
  const [copied, setCopied] = useState(false);

  // Non-Slack adapters auto-pass once the connection test succeeds.
  const allManualDone = isSlack ? (eventsConfirmed && messagesConfirmed && reinstallConfirmed) : true;
  const isReady = isSuccess && allManualDone;

  useEffect(() => {
    onReadyChange(isReady);
  }, [isReady, onReadyChange]);

  const handleCopy = () => {
    void navigator.clipboard.writeText(SLACK_MANIFEST_JSON);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const togglePanel = (panel: 'events' | 'messages' | 'reinstall') => {
    setOpenPanel((prev) => (prev === panel ? null : panel));
  };

  if (isPending) {
    return (
      <div className="flex flex-col items-center gap-3 py-10">
        <span className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-orange-400 opacity-75" />
          <span className="relative inline-flex size-2 rounded-full bg-orange-500" />
        </span>
        <p className="text-sm font-medium text-zinc-700">
          {isSlack ? 'Checking your Slack configuration...' : 'Testing connection...'}
        </p>
        <p className="text-xs text-zinc-400">Usually takes a second</p>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <div className="flex size-12 items-center justify-center rounded-full bg-red-50 border border-red-100">
          <XCircle className="size-5 text-red-500" />
        </div>
        <div className="text-center">
          <p className="text-sm font-semibold text-zinc-800">Couldn&apos;t connect</p>
          <p className="text-xs text-zinc-500 mt-1">Check your Bot Key and try again</p>
        </div>
        {errorMessage && (
          <div className="w-full rounded-md border border-red-100 bg-red-50 px-3 py-2.5 text-xs text-red-600">
            {errorMessage}
          </div>
        )}
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  if (!isSuccess) return null;

  // Non-Slack: simple auto-pass card.
  if (!isSlack) {
    return (
      <div className="space-y-2">
        <DiagItem
          status="pass"
          label="Connection verified"
          detail={botUsername ? `@${botUsername}` : undefined}
        />
        <div className="rounded-lg border border-green-100 bg-green-50 px-3 py-2.5 text-center text-xs text-green-700">
          Ready to save.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">

      {/* ── Auto-detected ── */}
      <DiagItem status="pass" label="Bot connected" detail={botUsername ? `@${botUsername}` : undefined} />
      <DiagItem status="pass" label="Socket Mode enabled" detail="No public URL needed" />

      {/* ── Event subscriptions ── */}
      <DiagItem
        status={eventsConfirmed ? 'pass' : 'fail'}
        label="Event subscriptions"
        detail={eventsConfirmed ? 'message.im · message.channels · app_mention' : "Bot won't receive any messages"}
        action={!eventsConfirmed ? { label: openPanel === 'events' ? 'Close' : 'Fix →', onClick: () => togglePanel('events') } : undefined}
      />
      <AnimatePresence>
        {openPanel === 'events' && (
          <motion.div
            key="events-panel"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <FixPanel
              title="Add event subscriptions"
              description="Paste this manifest into your Slack app's App Manifest page and save. No URL required."
              steps={[
                'Open your Slack app → click App Manifest in the sidebar',
                'Switch to the JSON tab and replace the entire contents with this',
                'Click Save Changes',
              ]}
              codeContent={SLACK_MANIFEST_JSON}
              copied={copied}
              onCopy={handleCopy}
              actionLabel="Open App Manifest"
              onConfirm={() => { setEventsConfirmed(true); setOpenPanel(null); }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Messages Tab ── */}
      <DiagItem
        status={messagesConfirmed ? 'pass' : 'fail'}
        label="Messages Tab enabled"
        detail={messagesConfirmed ? 'Users can DM your bot' : "Users can't DM your bot yet"}
        disabled={!eventsConfirmed}
        action={eventsConfirmed && !messagesConfirmed ? { label: openPanel === 'messages' ? 'Close' : 'Fix →', onClick: () => togglePanel('messages') } : undefined}
      />
      <AnimatePresence>
        {openPanel === 'messages' && (
          <motion.div
            key="messages-panel"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <FixPanel
              title="Allow DMs to your bot"
              description="Turn on the Messages Tab so people can send your bot direct messages."
              steps={[
                'Open your Slack app → click App Home in the sidebar',
                'Scroll to Show Tabs → enable Messages Tab',
                'Check "Allow users to send messages from the messages tab"',
              ]}
              actionLabel="Open App Home"
              onConfirm={() => { setMessagesConfirmed(true); setOpenPanel(null); }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Reinstall (appears once both manual items done) ── */}
      <AnimatePresence>
        {eventsConfirmed && messagesConfirmed && (
          <motion.div
            key="reinstall"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
          >
            <DiagItem
              status={reinstallConfirmed ? 'pass' : 'warn'}
              label={reinstallConfirmed ? 'App reinstalled' : 'Reinstall your app'}
              detail={reinstallConfirmed ? 'All changes applied' : 'Required to apply the changes above'}
              action={!reinstallConfirmed ? { label: openPanel === 'reinstall' ? 'Close' : 'How →', onClick: () => togglePanel('reinstall') } : undefined}
            />
            <AnimatePresence>
              {openPanel === 'reinstall' && (
                <motion.div
                  key="reinstall-panel"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.18 }}
                  className="overflow-hidden"
                >
                  <FixPanel
                    title="Reinstall to workspace"
                    description="Applies the event subscriptions and Messages Tab changes you just made."
                    steps={[
                      'Open your Slack app → click Install App in the sidebar',
                      'Click Reinstall to Workspace',
                      'Approve the permissions',
                    ]}
                    actionLabel="Open Install App"
                    confirmLabel="I've reinstalled ✓"
                    onConfirm={() => { setReinstallConfirmed(true); setOpenPanel(null); }}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── All clear ── */}
      <AnimatePresence>
        {isReady && (
          <motion.div
            key="all-clear"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: 0.1 }}
            className="mt-2 rounded-lg border border-green-100 bg-green-50 px-3 py-2.5 text-center text-xs text-green-700"
          >
            All checks passed — ready to save.
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Internal sub-components ───────────────────────────────────────────────────

interface DiagItemProps {
  status: 'pass' | 'fail' | 'warn';
  label: string;
  detail?: string;
  action?: { label: string; onClick: () => void };
  disabled?: boolean;
}

function DiagItem({ status, label, detail, action, disabled = false }: DiagItemProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors',
        status === 'fail' && !disabled && 'bg-red-50',
        status === 'warn' && 'bg-amber-50',
        disabled && 'opacity-40',
      )}
    >
      <div
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-full',
          status === 'pass' && 'bg-green-100',
          status === 'fail' && 'bg-red-100',
          status === 'warn' && 'bg-amber-100',
        )}
      >
        {status === 'pass' && <CheckCircle2 className="size-3.5 text-green-600" />}
        {status === 'fail' && <XCircle className="size-3.5 text-red-500" />}
        {status === 'warn' && <span className="text-[10px] font-bold leading-none text-amber-600">!</span>}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-zinc-800">{label}</p>
        {detail && <p className="truncate text-xs text-zinc-400">{detail}</p>}
      </div>
      {action && !disabled && (
        <button
          type="button"
          onClick={action.onClick}
          className="shrink-0 rounded px-2 py-1 text-xs font-medium text-orange-500 transition-colors hover:bg-orange-50 hover:text-orange-600"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

interface FixPanelProps {
  title: string;
  description: string;
  steps: string[];
  codeContent?: string;
  copied?: boolean;
  onCopy?: () => void;
  actionLabel: string;
  onConfirm: () => void;
  confirmLabel?: string;
}

function FixPanel({
  title,
  description,
  steps,
  codeContent,
  copied,
  onCopy,
  actionLabel,
  onConfirm,
  confirmLabel = "I've done this ✓",
}: FixPanelProps) {
  return (
    <div className="mb-1.5 ml-8 mr-1 space-y-3 rounded-lg border border-zinc-200 bg-zinc-50 p-4">
      <div>
        <p className="text-sm font-semibold text-zinc-800">{title}</p>
        <p className="mt-0.5 text-xs text-zinc-500">{description}</p>
      </div>

      {codeContent && onCopy !== undefined && (
        <div className="overflow-hidden rounded-md border border-zinc-200 bg-white">
          <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
              App Manifest · JSON
            </span>
            <button
              type="button"
              onClick={onCopy}
              className="flex items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-700"
            >
              {copied ? <Check className="size-3 text-green-500" /> : <Copy className="size-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre className="max-h-32 overflow-y-auto p-3 font-mono text-[10.5px] leading-relaxed text-zinc-500">
            {codeContent}
          </pre>
        </div>
      )}

      <ol className="space-y-2">
        {steps.map((step, i) => (
          <li key={i} className="flex items-start gap-2.5">
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-[10px] font-semibold text-zinc-500">
              {i + 1}
            </span>
            <span className="text-xs leading-relaxed text-zinc-600">{step}</span>
          </li>
        ))}
      </ol>

      <div className="flex gap-2 pt-0.5">
        <Button size="sm" onClick={onConfirm} className="h-7 text-xs">
          {confirmLabel}
        </Button>
        <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer">
          <Button variant="outline" size="sm" className="h-7 gap-1 text-xs">
            <ExternalLink className="size-3" />
            {actionLabel}
          </Button>
        </a>
      </div>
    </div>
  );
}
