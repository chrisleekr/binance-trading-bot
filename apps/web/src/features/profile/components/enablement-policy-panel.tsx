// Live-enablement gate policy editor, rendered as a full page panel (reached from
// the profile Manage card at /profiles/:id/gate). Going live is never blocked by
// this gate; it is an advisory quality check that a recent backtest on the current
// config clears these net-of-fee thresholds. Seeded from the profile's effective
// policy and saved via PATCH /profiles/:id { enablementPolicy }.
//
// The 80% case is two controls: is the check shown, and what profit-factor bar. The
// remaining fields — trade counts, alpha, out-of-sample, age, and the live
// edge-decay monitor — are tuning the operator rarely touches, so they live behind
// an "Advanced" disclosure.

import { EnablementPolicy } from '@app/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { fetchProfile, patchProfile, profileQueryKey } from '@/features/profile/api/profile';
import { Button } from '@/shared/components/ui/button';
import { FormActions } from '@/shared/components/form-actions';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { Switch } from '@/shared/components/ui/switch';
import { Panel } from '@/shared/components/panel';

interface NumberFieldProps {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly value: number;
  readonly step?: number;
  readonly onChange: (n: number) => void;
}

function NumberField({
  id,
  label,
  hint,
  value,
  step,
  onChange,
}: NumberFieldProps): React.JSX.Element {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        step={step ?? 1}
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))}
      />
      <p className="text-muted-fg text-xs">{hint}</p>
    </div>
  );
}

/** The edge-decay monitor's Off/Warn segmented control. */
function ModeButtons<M extends string>({
  label,
  value,
  modes,
  onChange,
}: {
  readonly label: string;
  readonly value: M;
  readonly modes: readonly { readonly key: M; readonly text: string; readonly testId: string }[];
  readonly onChange: (m: M) => void;
}): React.JSX.Element {
  return (
    <div className="flex gap-2" role="group" aria-label={label}>
      {modes.map((m) => (
        <Button
          key={m.key}
          type="button"
          size="sm"
          variant={value === m.key ? 'default' : 'outline'}
          data-testid={m.testId}
          onClick={() => onChange(m.key)}
        >
          {m.text}
        </Button>
      ))}
    </div>
  );
}

export function EnablementPolicyPanel({
  profileId,
}: {
  readonly profileId: string;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: profileQueryKey(profileId),
    queryFn: () => fetchProfile(profileId),
  });
  const [form, setForm] = useState<EnablementPolicy | null>(null);
  // Seed the form from the profile's effective policy once it loads.
  useEffect(() => {
    if (data) setForm(data.enablementPolicy);
  }, [data]);

  const save = useMutation({
    mutationFn: (policy: EnablementPolicy) => patchProfile(profileId, { enablementPolicy: policy }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: profileQueryKey(profileId) });
      toast.success('Live gate saved.');
    },
    onError: (err: unknown) => {
      toast.error(
        err instanceof Error ? err.message : 'Could not save the live-enablement policy.',
      );
    },
  });

  const parsed = form ? EnablementPolicy.safeParse(form) : null;
  const patch = <K extends keyof EnablementPolicy>(key: K, value: EnablementPolicy[K]): void =>
    setForm((f) => (f ? { ...f, [key]: value } : f));
  const patchMonitor = <K extends keyof EnablementPolicy['monitor']>(
    key: K,
    value: EnablementPolicy['monitor'][K],
  ): void => setForm((f) => (f ? { ...f, monitor: { ...f.monitor, [key]: value } } : f));

  if (!form) return <p className="text-muted-fg text-sm">Loading…</p>;

  return (
    <div className="space-y-6" data-testid="enablement-policy-panel">
      {/* Essentials — the on/off, the bar, and block-vs-flag. */}
      <Panel
        title="Backtest quality check"
        description="An advisory check that this profile's most recent backtest on its current settings clears these net-of-fee bars. Going live is never blocked by it — it just tells you whether the config has proven itself first."
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <Label htmlFor="gate-enabled">Show the backtest quality check</Label>
              <p className="text-muted-fg text-xs">
                Off = skip this check entirely. Going live is never blocked either way; this only
                decides whether the check is evaluated and shown.
              </p>
            </div>
            <Switch
              id="gate-enabled"
              checked={form.enabled}
              onCheckedChange={(v) => patch('enabled', v)}
            />
          </div>
          <NumberField
            id="gate-pf"
            label="Min profit factor"
            hint="For every $1 the strategy lost in the backtest, how many dollars it made. 1.0 = broke even; 1.1 leaves a small margin. Higher = stricter."
            value={form.minProfitFactor}
            step={0.1}
            onChange={(n) => patch('minProfitFactor', n)}
          />
        </div>
      </Panel>

      {/* Advanced — trade-count/alpha/out-of-sample/age bars and the live monitor.
          Collapsed by default: rarely-touched tuning, the same "tucked" treatment
          the config form's Advanced fold gets. */}
      <Panel
        title="Advanced thresholds"
        description="Trade-count, alpha, out-of-sample, and age bars, plus the live edge-decay monitor. Rarely touched."
        collapsible
        defaultOpen={false}
        summaryTestId="gate-advanced-toggle"
      >
        <div className="space-y-4">
          <NumberField
            id="gate-trades"
            label="Min closed trades"
            hint="A profit factor over a tiny sample is noise. Out-of-sample below is the real curve-fit defence, not this count."
            value={form.minTrades}
            onChange={(n) => patch('minTrades', n)}
          />
          <NumberField
            id="gate-alpha"
            label="Min alpha vs hold (%)"
            hint="Return beyond just holding. 0 = must at least match holding."
            value={form.minAlphaVsHoldPct}
            step={0.5}
            onChange={(n) => patch('minAlphaVsHoldPct', n)}
          />

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label htmlFor="gate-oos">Require out-of-sample validation</Label>
                <p className="text-muted-fg text-xs">
                  The edge must also clear the profit-factor and alpha bars in the most-recent 30%
                  of the backtest — the slice you didn&apos;t tune against. The real defence against
                  curve-fitting a single window.
                </p>
              </div>
              <Switch
                id="gate-oos"
                checked={form.requireOutOfSample}
                onCheckedChange={(v) => patch('requireOutOfSample', v)}
              />
            </div>
            {form.requireOutOfSample ? (
              <NumberField
                id="gate-oos-trades"
                label="Min out-of-sample trades"
                hint="The holdout is ~30% of the run, so it holds fewer trades. Below this its metrics are too noisy to trust."
                value={form.minOutOfSampleTrades}
                onChange={(n) => patch('minOutOfSampleTrades', n)}
              />
            ) : null}
          </div>
          <NumberField
            id="gate-age"
            label="Max backtest age (days)"
            hint="Reject proof older than this — markets and config drift."
            value={form.maxBacktestAgeDays}
            onChange={(n) => patch('maxBacktestAgeDays', n)}
          />

          <div className="space-y-2">
            <div>
              <Label>Edge-decay monitor (while live)</Label>
              <p className="text-muted-fg text-xs">
                The bars above gate going live; this keeps watching afterwards. It compares the
                profile&apos;s live profit factor against its pinned backtest baseline. Off = no
                watch; Warn = flag it on the dashboard and send a heads-up notification. The bot
                never pauses buys for edge decay.
              </p>
            </div>
            <ModeButtons
              label="Edge-decay monitor mode"
              value={form.monitor.mode}
              modes={[
                { key: 'off', text: 'Off', testId: 'monitor-mode-off' },
                { key: 'warn', text: 'Warn', testId: 'monitor-mode-warn' },
              ]}
              onChange={(m) => patchMonitor('mode', m)}
            />
            {form.monitor.mode !== 'off' ? (
              <div className="space-y-4 pt-2">
                <NumberField
                  id="monitor-mintrades"
                  label="Min live trades"
                  hint="Don't judge the live edge until this many closed trades."
                  value={form.monitor.minTrades}
                  onChange={(n) => patchMonitor('minTrades', n)}
                />
                <NumberField
                  id="monitor-warn"
                  label="Warn below (× baseline PF)"
                  hint="Live PF under baseline × this is a warning. 0.85 = 15% below baseline."
                  value={form.monitor.warnFactor}
                  step={0.05}
                  onChange={(n) => patchMonitor('warnFactor', n)}
                />
                <NumberField
                  id="monitor-breach"
                  label="Breach below (× baseline PF)"
                  hint="Live PF under baseline × this is a breach (sends a heads-up; never pauses buys). 0.6 = 40% below."
                  value={form.monitor.breachFactor}
                  step={0.05}
                  onChange={(n) => patchMonitor('breachFactor', n)}
                />
              </div>
            ) : null}
          </div>
        </div>
      </Panel>

      <FormActions>
        <Button
          data-testid="enablement-policy-save"
          disabled={!parsed?.success || save.isPending}
          onClick={() => parsed?.success && save.mutate(parsed.data)}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </FormActions>
    </div>
  );
}
