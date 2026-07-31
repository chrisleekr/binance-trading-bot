import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';

import { gateStatusQueryOptions } from '@/features/profile/api/gate-status';
import {
  describeGate,
  GATE_TONE_COLOR,
  LiveGateStatusCard,
  type Tone,
} from '@/features/dashboard/components/live-gate-status-card';
import { LiveVsBacktestCard } from '@/features/dashboard/components/live-vs-backtest-card';
import { useEdgeVerdict } from '@/features/dashboard/lib/use-edge-verdict';

/** Severity rank so the worst of {gate, edge} wins the one-line headline. */
const RANK: Record<Tone, number> = { down: 3, warning: 2, up: 0, muted: 0 };

interface Headline {
  tone: Tone;
  title: string;
  body: string;
}

/**
 * Pick the one-line headline from the gate verdict and the live edge-decay
 * verdict: the worse severity wins, and the gate (the buy-blocker) wins ties so
 * its reason stays visible. A breached edge therefore takes over only a
 * merely-unproven (warning) or healthy gate, never a paused (down) one.
 */
export function pickHealthHeadline(
  gate: Headline,
  edge: { verdict: string; reason: string } | null,
): Headline {
  const edgeTone: Tone | null =
    edge?.verdict === 'breached' ? 'down' : edge?.verdict === 'warning' ? 'warning' : null;
  if (edge && edgeTone !== null && RANK[edgeTone] > RANK[gate.tone]) {
    return {
      tone: edgeTone,
      title: edge.verdict === 'breached' ? 'Edge below baseline.' : 'Edge weakening.',
      body: `${edge.reason}.`,
    };
  }
  return gate;
}

/**
 * One-line live-health summary that replaces the two stacked full-width panels
 * (Live gate + Live vs backtest) on the scoped overview. Collapsed it shows the
 * worse of the gate verdict and the live edge-decay verdict as a single coloured
 * line; expanding reveals the full gate and live-vs-backtest scorecards. The gate
 * (the buy-blocker) wins ties; a breached edge outranks a merely-unproven gate.
 */
export function ProfileHealthStrip({
  profileId,
}: {
  readonly profileId: string;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const { data } = useQuery(gateStatusQueryOptions(profileId));
  const edge = useEdgeVerdict(profileId);
  // Testnet/non-live profiles have no gate; the strip is the live-money alert
  // surface, so it renders nothing there (the detail cards self-hide too).
  if (!data || data.applicability === 'not-live') return null;

  const { tone, title, body } = pickHealthHeadline(describeGate(data), edge);
  const color = GATE_TONE_COLOR[tone];

  return (
    <section
      className="border-border bg-bg-elevated overflow-hidden rounded-md border"
      data-testid="profile-health-strip"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid="profile-health-strip-toggle"
        className="hover:bg-surface-alt focus-visible:ring-focus flex w-full items-center gap-2 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset"
      >
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-xs">
          <span className="font-semibold" style={{ color }}>
            {title}
          </span>{' '}
          <span className="text-muted-fg">{body}</span>
        </span>
        <span className="text-muted-fg flex shrink-0 items-center gap-1 text-xs">
          {open ? 'Hide' : 'Details'}
          <ChevronDown
            className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`}
            aria-hidden
          />
        </span>
      </button>
      {open ? (
        <div className="border-border space-y-3 border-t p-3">
          <LiveGateStatusCard profileId={profileId} />
          <LiveVsBacktestCard profileId={profileId} />
        </div>
      ) : null}
    </section>
  );
}
