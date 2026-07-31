import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { GateStatusResponse } from '@app/contracts';

import { gateStatusQueryOptions } from '@/features/profile/api/gate-status';
import { useActiveAccountId } from '@/shared/lib/account-scope';
import { Button } from '@/shared/components/ui/button';

export type Tone = 'up' | 'down' | 'warning' | 'muted';

export const GATE_TONE_COLOR: Record<Tone, string> = {
  up: 'var(--up)',
  down: 'var(--down)',
  warning: 'var(--warning)',
  muted: 'var(--muted-fg)',
};

const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Map the server status into a tone + plain-language title/body for the operator. */
export function describeGate(data: GateStatusResponse): {
  tone: Tone;
  title: string;
  body: string;
} {
  if (data.applicability === 'gate-off') {
    return {
      tone: 'muted',
      title: 'Live gate off.',
      body: 'This profile can run live without a passing backtest. Turn the gate on in the Live gate settings to require proof.',
    };
  }
  if (data.ok) {
    return {
      tone: 'up',
      title: 'Live trading validated.',
      body: 'A recent backtest on the current settings clears the gate.',
    };
  }
  return {
    tone: 'warning',
    title: 'Unproven config.',
    body: `${cap(data.detail)}. This is only a heads-up — trading continues and going live is never blocked. Re-run a backtest on the current settings to prove the config.`,
  };
}

/**
 * Shows whether this profile's LIVE trading is validated by a recent backtest on
 * its current config. Advisory only — the bot never pauses buys for a failing
 * gate. Renders nothing for testnet profiles (the gate guards real money only).
 */
export function LiveGateStatusCard({
  profileId,
}: {
  readonly profileId: string;
}): React.JSX.Element | null {
  const accountId = useActiveAccountId() ?? '';
  const { data } = useQuery(gateStatusQueryOptions(profileId));
  if (!data || data.applicability === 'not-live') return null;

  const { tone, title, body } = describeGate(data);
  const color = GATE_TONE_COLOR[tone];

  return (
    <section
      aria-labelledby="live-gate-h"
      className="border-border bg-bg-elevated space-y-1 rounded-md border p-3"
      data-testid="live-gate-status-card"
    >
      <h2 id="live-gate-h" className="text-fg text-sm font-semibold">
        Live gate
      </h2>
      <p
        className="rounded border px-2 py-1 text-xs"
        style={{ borderColor: color, color }}
        data-testid="gate-status-state"
        data-gate-tone={tone}
      >
        <span className="font-semibold">{title}</span> {body}
      </p>
      {/* One-click path to prove the current config: the backtest workbench
          seeds from the live config by default, so this lands the operator on a
          ready-to-run current-config backtest. Shown only when the config is
          unproven (the actionable case). */}
      {data.applicability === 'gated' && !data.ok ? (
        <Button asChild variant="outline" size="sm" className="w-full">
          <Link
            to="/accounts/$accountId/profiles/$profileId/backtest"
            params={{ accountId, profileId }}
            search={{ view: 'configure' }}
            data-testid="gate-run-current-config"
          >
            Run backtest on current config
          </Link>
        </Button>
      ) : null}
    </section>
  );
}
