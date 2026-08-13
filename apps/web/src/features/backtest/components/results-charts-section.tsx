import type { BacktestResult } from '@app/contracts';

import { useMemo } from 'react';

import { InfoHint } from '@/shared/components/ui/info-hint';
import { EquityAreaChart, type AreaChartModule } from './equity-area-chart';
import { chartColors } from './results-format';

/** Equity + underwater curves, side by side on desktop. */
export function ResultsChartsSection({
  result,
  loadChartModule,
}: {
  readonly result: BacktestResult;
  readonly loadChartModule?: (() => Promise<AreaChartModule>) | undefined;
}): React.JSX.Element {
  const equityPoints = result.equityCurve.map((p) => ({ tsMs: p.tsMs, value: Number(p.equity) }));
  const drawdownPoints = result.drawdownSeries.map((p) => ({ tsMs: p.tsMs, value: p.ddPct }));

  // Chart colors derive from theme tokens; computed once per mount (lightweight-
  // charts needs concrete rgb/rgba strings, not CSS var() references). Fallbacks
  // mirror the dark-theme token hexes for non-DOM test environments.
  const equityColors = useMemo(
    () =>
      chartColors(
        '--primary',
        { line: '#00e070', top: 'rgba(0,224,112,0.25)', bottom: 'rgba(0,224,112,0.02)' },
        0.25,
        0.02,
      ),
    [],
  );
  const drawdownColors = useMemo(
    () =>
      chartColors(
        '--down',
        { line: '#ff6257', top: 'rgba(255,98,87,0.05)', bottom: 'rgba(255,98,87,0.25)' },
        0.05,
        0.25,
      ),
    [],
  );

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section
        aria-labelledby="bt-equity-h"
        className="space-y-2 rounded-md border border-border bg-bg-elevated p-3"
      >
        <div className="flex items-center gap-1">
          <h2 id="bt-equity-h" className="text-sm font-semibold text-fg">
            Equity curve
          </h2>
          <InfoHint label="Equity curve">
            Your balance over the whole test if you had run this config. Up and to the right is
            good; a big dip is a rough stretch you would have lived through.
          </InfoHint>
        </div>
        <EquityAreaChart
          points={equityPoints}
          ariaLabel="Equity curve"
          lineColor={equityColors.line}
          topColor={equityColors.top}
          bottomColor={equityColors.bottom}
          loadModule={loadChartModule}
        />
      </section>
      <section
        aria-labelledby="bt-dd-h"
        className="space-y-2 rounded-md border border-border bg-bg-elevated p-3"
      >
        <div className="flex items-center gap-1">
          <h2 id="bt-dd-h" className="text-sm font-semibold text-fg">
            Drawdown
          </h2>
          <InfoHint label="Drawdown">
            How far below your best-ever balance you were at each moment. It sits at 0% at new highs
            and dips down during losing stretches — the deeper and longer, the harder to hold.
          </InfoHint>
        </div>
        <EquityAreaChart
          points={drawdownPoints}
          ariaLabel="Drawdown"
          lineColor={drawdownColors.line}
          topColor={drawdownColors.top}
          bottomColor={drawdownColors.bottom}
          loadModule={loadChartModule}
        />
      </section>
    </div>
  );
}
