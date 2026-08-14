// The funnel panel's job is to answer "is this scan unlucky or does it choke
// every time" without lying in either direction. Two properties decide that and
// both are locked here: the two ladders keep their own denominators (so the
// seam between them never reads as a collapse), and a scan that recorded no
// counts renders as unknown rather than as zero survivors.

import type { DiagnosisFunnel } from '@app/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { discoveryFunnelQueryKey } from '@/features/profile/api/diagnosis';
import {
  DiscoveryFunnelPanel,
  toRungs,
} from '@/features/profile/components/discovery-funnel-panel';
import { createQueryClient } from '@/shared/lib/query-client';

const PID = '00000000-0000-4000-8000-0000000000d1';

// Yesterday's real shape: discovery healthy, the ticker set collapsing at the
// activity filter, then the shortlist thinning again at trend confirmation.
const funnel = (over: Partial<DiagnosisFunnel> = {}): DiagnosisFunnel => ({
  latestAtMs: Date.parse('2026-08-07T02:00:00.000Z'),
  ticker: [
    { stage: 'universe', survivors: 489 },
    { stage: 'quote', survivors: 231 },
    { stage: 'blacklist', survivors: 231 },
    { stage: 'liquidity', survivors: 120 },
    { stage: 'activity', survivors: 12 },
    { stage: 'spread', survivors: 12 },
    { stage: 'changeBand', survivors: 10 },
  ],
  candidate: [
    { stage: 'age', survivors: 10 },
    { stage: 'trend', survivors: 3 },
    { stage: 'eligible', survivors: 3 },
  ],
  history: [
    { atMs: 1, eligible: 3, added: 0, breadthOk: true },
    { atMs: 2, eligible: 2, added: 0, breadthOk: true },
  ],
  ...over,
});

const renderPanel = (data: { funnel: DiagnosisFunnel | null }): void => {
  const qc = createQueryClient();
  qc.setQueryData(discoveryFunnelQueryKey(PID), data);
  render(
    <QueryClientProvider client={qc}>
      <DiscoveryFunnelPanel profileId={PID} />
    </QueryClientProvider>,
  );
};

const barWidth = (stage: string): string => {
  const rung = screen.getByTestId(`funnel-rung-${stage}`);
  const bar = rung.querySelector('div > div');
  if (bar === null) throw new Error(`no bar rendered for ${stage}`);
  return (bar as HTMLElement).style.width;
};

describe('toRungs', () => {
  it('leaves the first rung without a pass rate, since there is nothing above it', () => {
    expect(toRungs([{ stage: 'universe', survivors: 489 }])[0]?.kept).toBeNull();
  });

  it('measures each rung against the rung above it, not against the ladder head', () => {
    const rungs = toRungs([
      { stage: 'universe', survivors: 400 },
      { stage: 'quote', survivors: 200 },
      { stage: 'liquidity', survivors: 100 },
    ]);
    // 100 of 200, not 100 of 400: a filter is judged on what reached it.
    expect(rungs[2]?.kept).toBeCloseTo(0.5, 6);
  });

  it('reports no pass rate rather than a divide-by-zero when the rung above is empty', () => {
    const rungs = toRungs([
      { stage: 'universe', survivors: 0 },
      { stage: 'quote', survivors: 0 },
    ]);
    expect(rungs[1]?.kept).toBeNull();
  });
});

describe('<DiscoveryFunnelPanel>', () => {
  it('scales each ladder against its own head, so the change of denominator is not drawn as a collapse', () => {
    renderPanel({ funnel: funnel() });

    // 10 survivors is 2% of the ticker ladder's 489, but it is 100% of the
    // shortlist the candidate ladder counts over. Drawing it at 2% would tell
    // the operator a filter destroyed the field when nothing was filtered.
    expect(barWidth('universe')).toBe('100%');
    expect(barWidth('age')).toBe('100%');
    expect(barWidth('trend')).toBe('30%');
  });

  it('names the same choke stage the diagnosis would, with the count that died there', () => {
    renderPanel({ funnel: funnel() });

    // liquidity 120 → activity 12 drops 90%, the largest proportional loss in
    // either ladder. Both the sentence and the highlighted rung derive from the
    // shared largestDrop rule, so the chart cannot disagree with the report.
    const choke = screen.getByTestId('funnel-choke');
    expect(choke).toHaveAttribute('data-stage', 'activity');
    expect(choke).toHaveTextContent('108 of 120 dropped there');
    expect(screen.getByTestId('funnel-rung-activity')).toBeInTheDocument();
  });

  it('searches each ladder within its own denominator, so the seam is never the choke', () => {
    // changeBand 10 → age 10 is the seam. It carries no loss at all here, and
    // even when it does, it is a change of population, not a filter.
    renderPanel({ funnel: funnel() });
    expect(screen.getByTestId('funnel-choke')).not.toHaveAttribute('data-stage', 'changeBand');
  });

  it('renders both ladders with their own stated denominator', () => {
    renderPanel({ funnel: funnel() });

    expect(screen.getByTestId('funnel-ticker')).toHaveTextContent(/every coin on the exchange/i);
    expect(screen.getByTestId('funnel-candidate')).toHaveTextContent(/the shortlist above/i);
  });

  it('says no scan recorded counts, rather than drawing an empty funnel', () => {
    renderPanel({ funnel: null });

    // "Not recorded" and "nothing survived" are opposite claims, and this panel
    // exists to tell them apart. A zeroed ladder would assert the second.
    expect(screen.getByTestId('funnel-unknown')).toHaveTextContent(
      /not the same as a scan that found nothing/i,
    );
    expect(screen.queryByTestId('funnel-rung-universe')).not.toBeInTheDocument();
  });

  it('hides the history strip until there are two scans to compare', () => {
    renderPanel({
      funnel: funnel({ history: [{ atMs: 1, eligible: 3, added: 0, breadthOk: true }] }),
    });
    expect(screen.queryByTestId('funnel-history')).not.toBeInTheDocument();
  });

  it('shows the history strip once a second scan lands', () => {
    renderPanel({ funnel: funnel() });
    expect(screen.getByTestId('funnel-history')).toBeInTheDocument();
  });
});
