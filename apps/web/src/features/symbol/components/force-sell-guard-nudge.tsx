// Inline warning shown when a force-sell trigger is armed but its safety
// guards resolve to zero — i.e. the position would exit on a single signal
// print and could rebuy on the very next tick. Reads the live form values via
// `useWatch` so it tracks unsaved edits, and reuses the strategy's pure
// `resolveForceSellGuards` so the displayed effective guards match exactly what
// the worker would apply (apps/web may import strategy packages for typed
// consumption; this helper is integer math, no decimal.js).

import { useWatch } from 'react-hook-form';

import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';

// Imported via the package's `./force-sell-guards` subpath, not the root, so
// web's type graph pulls only this pure integer-math file and not the strategy
// index (which transitively references strategy-core's replay.ts / node:fs).
import { resolveForceSellGuards } from '@app/strategy-trailing-trade/force-sell-guards';

interface IntervalRow {
  interval?: string;
  whenSell?: boolean;
  whenStrongSell?: boolean;
  whenNeutral?: boolean;
}

interface TechnicalsValue {
  intervals?: IntervalRow[];
  forceSellConfirmMinutes?: number;
  forceSellReentryCooldownMinutes?: number;
}

/** True when any interval row arms a force-sell trigger. */
function anyForceSellTrigger(intervals: IntervalRow[]): boolean {
  return intervals.some(
    (row) => row.whenSell === true || row.whenStrongSell === true || row.whenNeutral === true,
  );
}

/**
 * Force-sell safety nudge. Renders nothing unless a force-sell trigger is armed
 * AND the effective confirm window OR rebuy cooldown resolves to 0 (an informed
 * opt-out, but worth flagging because it whipsaws a position on a single print).
 * Mounts inside an AutoForm so `useWatch` reads the live config tree.
 */
export function ForceSellGuardNudge(): React.JSX.Element | null {
  const technicals = useWatch({ name: 'technicals' }) as TechnicalsValue | undefined;
  const intervals = technicals?.intervals ?? [];

  if (!anyForceSellTrigger(intervals)) return null;

  const guards = resolveForceSellGuards({
    intervals,
    forceSellConfirmMinutes: technicals?.forceSellConfirmMinutes,
    forceSellReentryCooldownMinutes: technicals?.forceSellReentryCooldownMinutes,
  });

  if (guards.confirmMinutes > 0 && guards.cooldownMinutes > 0) return null;

  return (
    <Alert variant="warning" data-testid="force-sell-guard-nudge">
      <AlertTitle>Force-sell has no safety window</AlertTitle>
      <AlertDescription>
        This exits on a single signal print and can rebuy immediately — set a confirm window and a
        rebuy cooldown.
      </AlertDescription>
    </Alert>
  );
}
