import React from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  SettingsCheckboxRow,
  SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { recordDeferredOpenCodeRestart } from '@/lib/opencode/deferredRestart';
import { updateDesktopSettings } from '@/lib/persistence';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';

const STATUS_POLL_INTERVAL_MS = 30_000;

type HermesStatus = {
  ok: boolean;
  server: { version: string; uptimeMs: number };
  integrations: {
    agentActivity: { available: boolean };
    steer: { available: boolean };
    planGate: { available: boolean };
  };
  config: {
    planGateDefault: boolean;
    activityRateLimitMs: number;
  };
} | null;

function StatusDot({ available }: { available: boolean }) {
  return (
    <span
      className={cn(
        'inline-block size-2 rounded-full',
        available
          ? 'bg-[var(--status-success)]'
          : 'bg-[var(--status-error)]',
      )}
    />
  );
}

function StatusRow({
  label,
  available,
  detail,
}: {
  label: string;
  available: boolean;
  detail?: string;
}) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <StatusDot available={available} />
      <span className="typography-settings-field-label text-foreground">{label}</span>
      {detail ? (
        <span className="typography-meta text-muted-foreground">{detail}</span>
      ) : null}
    </div>
  );
}

export const HermesIntegration: React.FC = () => {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [status, setStatus] = React.useState<HermesStatus>(null);
  const [fetchError, setFetchError] = React.useState(false);

  const hermesPlanGateDefault = useUIStore((state) => state.hermesPlanGateDefault);
  const setHermesPlanGateDefault = useUIStore((state) => state.setHermesPlanGateDefault);

  const fetchStatus = React.useCallback(async () => {
    try {
      const response = await fetch('/api/openchamber/hermes/status');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data: HermesStatus = await response.json();
      setStatus(data);
      setFetchError(false);
    } catch {
      setStatus(null);
      setFetchError(true);
    }
  }, []);

  React.useEffect(() => {
    void fetchStatus();
    const timer = window.setInterval(fetchStatus, STATUS_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [fetchStatus]);

  const handlePlanGateDefaultChange = React.useCallback((enabled: boolean) => {
    setHermesPlanGateDefault(enabled);
    void updateDesktopSettings({ hermesPlanGateDefault: enabled });
    recordDeferredOpenCodeRestart('cli', { id: 'hermes-plan-gate' });
  }, [setHermesPlanGateDefault]);

  const connected = status?.ok === true && !fetchError;
  const statusLabel = fetchError
    ? t('settings.integrations.hermes.status.unreachable')
    : connected
      ? t('settings.integrations.hermes.status.connected')
      : t('settings.integrations.hermes.status.checking');
  const statusClassName = fetchError
    ? 'bg-[var(--status-error)]/15 text-[var(--status-error)]'
    : connected
      ? 'bg-[var(--status-success)]/15 text-[var(--status-success)]'
      : 'bg-[var(--surface-muted)] text-muted-foreground';

  const activityRateLimitMs = status?.config?.activityRateLimitMs ?? 2000;
  const activityRateLabel = `${Math.round(activityRateLimitMs / 1000)}s`;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        data-settings-item="integrations.hermes"
        className="overflow-hidden rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)]"
      >
        <CollapsibleTrigger
          className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left hover:bg-[var(--interactive-hover)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--interactive-focus-ring)]"
        >
          <div className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--surface-muted)]">
            <Icon name="robot" className="size-5 text-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-foreground">
              {t('settings.integrations.hermes.title')}
            </div>
            <p className="mt-0.5 line-clamp-1 text-xs leading-snug text-muted-foreground">
              {t('settings.integrations.hermes.description')}
            </p>
          </div>
          <span
            aria-live="polite"
            className={cn(
              'max-w-36 shrink-0 truncate rounded-full px-2 py-0.5 text-[10px] font-medium',
              statusClassName,
            )}
          >
            {statusLabel}
          </span>
          <Icon
            name="arrow-down-s"
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none',
              open && 'rotate-180',
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t border-[var(--interactive-border)] px-4 py-4">
          <div className="space-y-4">
            <div className={SETTINGS_OPTION_STACK_CLASS}>
              <SettingsCheckboxRow
                settingsItem="integrations.hermes.plan-gate-default"
                checked={hermesPlanGateDefault}
                onChange={handlePlanGateDefaultChange}
                label={t('settings.integrations.hermes.field.planGateDefault')}
                ariaLabel={t('settings.integrations.hermes.field.planGateDefaultAria')}
                info={t('settings.integrations.hermes.field.planGateDefaultInfo')}
              />
            </div>

            <div className="space-y-2">
              <p className="typography-meta font-medium text-foreground">
                {t('settings.integrations.hermes.section.status')}
              </p>
              <StatusRow
                label={t('settings.integrations.hermes.field.activityStream')}
                available={status?.integrations?.agentActivity?.available ?? false}
                detail={`${t('settings.integrations.hermes.field.activityStreamDetail')} · ${activityRateLabel}`}
              />
              <StatusRow
                label={t('settings.integrations.hermes.field.steerChannel')}
                available={status?.integrations?.steer?.available ?? false}
              />
              <StatusRow
                label={t('settings.integrations.hermes.field.planGate')}
                available={status?.integrations?.planGate?.available ?? false}
              />
            </div>

            {status?.server ? (
              <p className="typography-meta text-muted-foreground">
                v{status.server.version} · {t('settings.integrations.hermes.field.uptime')}{' '}
                {Math.round(status.server.uptimeMs / 1000)}s
              </p>
            ) : null}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
};
