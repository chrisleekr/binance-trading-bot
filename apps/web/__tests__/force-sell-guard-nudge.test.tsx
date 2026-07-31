// ForceSellGuardNudge — shows only when a force-sell trigger is armed and its
// effective confirm window OR rebuy cooldown resolves to 0.

import { render, screen } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import { describe, expect, it } from 'vitest';

import { ForceSellGuardNudge } from '../src/features/symbol/components/force-sell-guard-nudge.js';

interface TechnicalsValues {
  technicals: {
    intervals: {
      interval: string;
      whenSell?: boolean;
      whenStrongSell?: boolean;
      whenNeutral?: boolean;
    }[];
    forceSellConfirmMinutes?: number;
    forceSellReentryCooldownMinutes?: number;
  };
}

function Harness({ values }: { readonly values: TechnicalsValues }): React.JSX.Element {
  const form = useForm<TechnicalsValues>({ defaultValues: values });
  return (
    <FormProvider {...form}>
      <ForceSellGuardNudge />
    </FormProvider>
  );
}

// The nudge mounts unconditionally in the generic SymbolConfigForm, which also
// renders for strategies that have no Technicals block at all, so `useWatch`
// returns undefined. Bare harness with no `technicals` key exercises that path.
function BareHarness(): React.JSX.Element {
  const form = useForm({ defaultValues: {} });
  return (
    <FormProvider {...form}>
      <ForceSellGuardNudge />
    </FormProvider>
  );
}

const NUDGE = 'force-sell-guard-nudge';

describe('ForceSellGuardNudge', () => {
  it('warns when a sub-1h force-sell trigger is armed and guards are left to resolve to 0', () => {
    // A 1m whenStrongSell row resolves to a non-zero default, so to reach the
    // zero-guard warning the operator must explicitly zero both fields.
    render(
      <Harness
        values={{
          technicals: {
            intervals: [{ interval: '1m', whenStrongSell: true }],
            forceSellConfirmMinutes: 0,
            forceSellReentryCooldownMinutes: 0,
          },
        }}
      />,
    );
    expect(screen.getByTestId(NUDGE)).toBeInTheDocument();
  });

  it('warns when a force-sell trigger is armed only on a 1h interval (no sub-1h default applies)', () => {
    // 1h is not sub-1h, so an omitted guard resolves to 0 — the position would
    // exit on a single 1h print with no cooldown.
    render(
      <Harness
        values={{ technicals: { intervals: [{ interval: '1h', whenStrongSell: true }] } }}
      />,
    );
    expect(screen.getByTestId(NUDGE)).toBeInTheDocument();
  });

  it('hides when a sub-1h trigger is armed and guards resolve to non-zero defaults', () => {
    // Omitted guards on a 1m trigger resolve to confirm=1, cooldown=60.
    render(
      <Harness
        values={{ technicals: { intervals: [{ interval: '1m', whenStrongSell: true }] } }}
      />,
    );
    expect(screen.queryByTestId(NUDGE)).not.toBeInTheDocument();
  });

  it('hides when explicit non-zero guards are set', () => {
    render(
      <Harness
        values={{
          technicals: {
            intervals: [{ interval: '5m', whenSell: true }],
            forceSellConfirmMinutes: 10,
            forceSellReentryCooldownMinutes: 30,
          },
        }}
      />,
    );
    expect(screen.queryByTestId(NUDGE)).not.toBeInTheDocument();
  });

  it('hides when no force-sell trigger is armed', () => {
    render(
      <Harness
        values={{
          technicals: {
            intervals: [{ interval: '1m', whenSell: false, whenStrongSell: false }],
            forceSellConfirmMinutes: 0,
            forceSellReentryCooldownMinutes: 0,
          },
        }}
      />,
    );
    expect(screen.queryByTestId(NUDGE)).not.toBeInTheDocument();
  });

  it('renders nothing when the form has no technicals block (non-TT strategy)', () => {
    render(<BareHarness />);
    expect(screen.queryByTestId(NUDGE)).not.toBeInTheDocument();
  });
});
