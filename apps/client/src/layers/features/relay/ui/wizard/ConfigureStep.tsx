import { useState } from 'react';
import { BookOpen, ExternalLink } from 'lucide-react';
import { Button } from '@/layers/shared/ui/button';
import { Input } from '@/layers/shared/ui/input';
import { Label } from '@/layers/shared/ui/label';
import { ConfigFieldGroup } from '../ConfigFieldInput';
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';

interface ConfigureStepProps {
  manifest: AdapterManifest;
  label: string;
  onLabelChange: (label: string) => void;
  fields: AdapterManifest['configFields'];
  values: Record<string, unknown>;
  errors: Record<string, string>;
  onChange: (key: string, value: unknown) => void;
  /** Whether the adapter has a setup guide available. */
  hasSetupGuide?: boolean;
  /** Callback to open the setup guide panel. */
  onOpenGuide?: () => void;
}

/** Form step for configuring adapter credentials and settings. */
export function ConfigureStep({
  manifest,
  label,
  onLabelChange,
  fields,
  values,
  errors,
  onChange,
  hasSetupGuide,
  onOpenGuide,
}: ConfigureStepProps) {
  // Banner starts closed on field steps so the form is immediately visible.
  const isIntroStep = fields.length === 0;
  const [helpOpen, setHelpOpen] = useState(false);

  return (
    <div className="space-y-5">

      {/* ── INTRO STEP (no fields): big button, nothing else ── */}
      {isIntroStep && (
        <div className="flex flex-col items-center gap-4 py-4 text-center">
          {/* Emoji icon */}
          <div className="flex size-14 items-center justify-center rounded-2xl bg-muted text-3xl">
            {manifest.iconEmoji ?? '🔌'}
          </div>

          <div className="space-y-1">
            <p className="text-base font-semibold">Connect {manifest.displayName} to your workspace</p>
            <p className="text-sm text-muted-foreground">
              Takes about 2 minutes. Click the button and Slack will walk you through it.
            </p>
          </div>

          {/* Primary action button — big and obvious */}
          {manifest.actionButton && (
            <a href={manifest.actionButton.url} target="_blank" rel="noopener noreferrer" className="w-full">
              <Button type="button" className="w-full gap-2" size="lg">
                <ExternalLink className="size-4" />
                {manifest.actionButton.label}
              </Button>
            </a>
          )}

          {/* Warning — small, below the button, not alarming */}
          {manifest.setupInstructions && (
            <p className="max-w-sm text-xs text-muted-foreground">
              {/* Strip markdown for the plain-text warning */}
              {manifest.setupInstructions.replace(/\*\*/g, '')}
            </p>
          )}

          {/* Setup Guide link — secondary, unobtrusive */}
          {hasSetupGuide && (
            <button
              type="button"
              onClick={onOpenGuide}
              className="flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              <BookOpen className="size-3" />
              Need detailed instructions? Open the Setup Guide
            </button>
          )}
        </div>
      )}

      {/* ── FIELD STEPS: form first, help secondary ── */}
      {!isIntroStep && (
        <>
          {/* Subtle help row — collapsed by default so the form is front and center */}
          {(manifest.actionButton || hasSetupGuide) && (
            <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
              <button
                type="button"
                onClick={() => setHelpOpen((o) => !o)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                {helpOpen ? '▲ Hide help' : '▼ Need help finding these?'}
              </button>
              <div className="flex items-center gap-2">
                {hasSetupGuide && (
                  <Button type="button" variant="ghost" size="sm" onClick={onOpenGuide} className="h-6 px-2 text-xs">
                    <BookOpen className="mr-1 size-3" />
                    Setup Guide
                  </Button>
                )}
                {manifest.actionButton && (
                  <a href={manifest.actionButton.url} target="_blank" rel="noopener noreferrer">
                    <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs">
                      <ExternalLink className="mr-1 size-3" />
                      Open Slack
                    </Button>
                  </a>
                )}
              </div>
            </div>
          )}

          {/* Name field */}
          <div className="space-y-1.5">
            <Label htmlFor="adapter-label">
              Name <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="adapter-label"
              placeholder={manifest.displayName}
              value={label}
              onChange={(e) => onLabelChange(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              A friendly label so you can tell adapters apart (e.g. "Support Team Slack").
            </p>
          </div>

          <ConfigFieldGroup
            fields={fields}
            values={values}
            onChange={onChange}
            errors={errors}
          />

          {/* Setup instructions on field steps — shown as a muted note below the form */}
          {manifest.setupInstructions && (
            <p className="text-xs text-muted-foreground">
              {manifest.setupInstructions.replace(/\*\*/g, '')}
            </p>
          )}
        </>
      )}
    </div>
  );
}
