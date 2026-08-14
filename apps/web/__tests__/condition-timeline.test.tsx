// The regression this timeline exists to prevent: a symbol blocked by one
// reason for thirty days has a single log edge, written thirty days ago and
// pruned long since. An edges-only view is emptiest for the subject that has
// been stuck longest, and clipping the span to the log window silently restates
// "stuck for 30 days" as "stuck since the window opened".

import type { DiagnosisItem, ProfileDiagnosis } from '@app/contracts';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { buildTimeline, ConditionTimeline } from '@/features/profile/components/condition-timeline';

const NOW = Date.parse('2026-08-08T00:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;

const item = (over: Partial<DiagnosisItem>): DiagnosisItem => ({
  id: 'i1',
  condition: 'entry-blocked',
  code: 'knife-guard',
  severity: 'degraded',
  title: 'Entries are blocked',
  detail: null,
  sinceMs: null,
  evidence: [],
  symbols: [],
  lever: null,
  ...over,
});

const report = (over: Partial<ProfileDiagnosis> = {}): ProfileDiagnosis => ({
  asOfMs: NOW,
  verdict: 'blocked',
  headline: 'Something is in the way.',
  steps: [],
  items: [],
  funnel: null,
  timeline: [],
  ...over,
});

describe('buildTimeline', () => {
  it('keeps the true start of an open condition whose opening edge was pruned', () => {
    const t = buildTimeline(
      report({
        // The log only reaches back an hour; the condition has held for 30 days.
        timeline: [
          {
            atMs: NOW - HOUR,
            condition: 'discovery-stale',
            code: 'no-scan',
            previousCode: null,
            symbol: null,
          },
        ],
        items: [
          item({
            condition: 'entry-blocked',
            code: 'knife-guard',
            symbols: [{ symbol: 'BTCUSDT', sinceMs: NOW - 30 * DAY }],
            sinceMs: NOW - 30 * DAY,
          }),
        ],
      }),
    );

    const span = t.lanes.find((l) => l.symbol === 'BTCUSDT')?.spans[0];
    expect(span?.startMs).toBe(NOW - 30 * DAY);
    expect(span?.open).toBe(true);
    // Marked clipped, not shortened: the length is real, the left end is not.
    expect(span?.clipped).toBe(true);
    expect(t.clipped).toBe(true);
  });

  it('prefers the condition start over the edge that appeared to open it', () => {
    const t = buildTimeline(
      report({
        timeline: [
          {
            atMs: NOW - HOUR,
            condition: 'entry-blocked',
            code: 'knife-guard',
            previousCode: null,
            symbol: 'BTCUSDT',
          },
        ],
        items: [
          item({
            symbols: [{ symbol: 'BTCUSDT', sinceMs: NOW - 10 * DAY }],
            sinceMs: NOW - 10 * DAY,
          }),
        ],
      }),
    );

    // `since` outlives the log row, so where the two disagree the older one is
    // the surviving evidence, not a contradiction to average away.
    expect(t.lanes[0]?.spans[0]?.startMs).toBe(NOW - 10 * DAY);
  });

  it('gives each coin its own start, not the group headline', () => {
    // Items group coins by REASON, so one item can cover fifteen coins and
    // report the oldest of them. Painting that start on every lane would claim
    // fourteen coins were blocked since before they were, and mark them clipped
    // on top of it — the timeline's one job is to not do that.
    const t = buildTimeline(
      report({
        // An unrelated edge, only to put the log's horizon two hours back so
        // "before the horizon" and "after it" are distinguishable at all.
        timeline: [
          {
            atMs: NOW - 2 * HOUR,
            condition: 'discovery-stale',
            code: 'no-scan',
            previousCode: null,
            symbol: null,
          },
        ],
        items: [
          item({
            symbols: [
              { symbol: 'BTCUSDT', sinceMs: NOW - 30 * DAY },
              { symbol: 'ETHUSDT', sinceMs: NOW - HOUR },
            ],
            sinceMs: NOW - 30 * DAY,
          }),
        ],
      }),
    );

    const btc = t.lanes.find((l) => l.symbol === 'BTCUSDT')?.spans[0];
    const eth = t.lanes.find((l) => l.symbol === 'ETHUSDT')?.spans[0];
    expect(btc?.startMs).toBe(NOW - 30 * DAY);
    expect(btc?.clipped).toBe(true);
    expect(eth?.startMs).toBe(NOW - HOUR);
    expect(eth?.clipped).toBe(false);
  });

  it('draws no span for a coin whose own start is unknown', () => {
    // Falling back to the item's `sinceMs` here is exactly the fabrication
    // above. Unknown renders as nothing, never as the group's oldest.
    const t = buildTimeline(
      report({
        items: [
          item({
            symbols: [{ symbol: 'BTCUSDT', sinceMs: null }],
            sinceMs: NOW - 30 * DAY,
          }),
        ],
      }),
    );

    expect(t.lanes).toHaveLength(0);
  });

  it('marks a code that ended without an observed beginning as clipped', () => {
    const t = buildTimeline(
      report({
        timeline: [
          {
            atMs: NOW - HOUR,
            condition: 'entry-blocked',
            code: null,
            previousCode: 'knife-guard',
            symbol: 'ETHUSDT',
          },
        ],
      }),
    );

    const span = t.lanes[0]?.spans[0];
    expect(span?.code).toBe('knife-guard');
    expect(span?.clipped).toBe(true);
    expect(span?.open).toBe(false);
  });

  it('closes a span at the edge that replaced it and opens the next one there', () => {
    const t = buildTimeline(
      report({
        timeline: [
          {
            atMs: NOW - 2 * HOUR,
            condition: 'entry-blocked',
            code: 'knife-guard',
            previousCode: null,
            symbol: 'BTCUSDT',
          },
          {
            atMs: NOW - HOUR,
            condition: 'entry-blocked',
            code: 'awaiting-trigger-price',
            previousCode: 'knife-guard',
            symbol: 'BTCUSDT',
          },
        ],
      }),
    );

    const spans = t.lanes[0]?.spans ?? [];
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ code: 'knife-guard', endMs: NOW - HOUR, clipped: false });
    expect(spans[1]).toMatchObject({ code: 'awaiting-trigger-price', open: true, endMs: NOW });
  });

  it('puts profile-wide conditions above the per-symbol lanes', () => {
    const t = buildTimeline(
      report({
        timeline: [
          {
            atMs: NOW - HOUR,
            condition: 'entry-blocked',
            code: 'knife-guard',
            previousCode: null,
            symbol: 'SOLUSDT',
          },
          {
            atMs: NOW - HOUR,
            condition: 'config-invalid',
            code: 'schema',
            previousCode: null,
            symbol: null,
          },
        ],
      }),
    );

    // The profile-wide condition is usually the one explaining every lane under
    // it, so it reads first.
    expect(t.lanes.map((l) => l.symbol)).toEqual([null, 'SOLUSDT']);
  });

  it('has nothing to draw when no condition was ever recorded', () => {
    expect(buildTimeline(report()).lanes).toEqual([]);
  });
});

describe('<ConditionTimeline>', () => {
  it('explains the clipped left edge instead of implying the span started there', () => {
    render(
      <ConditionTimeline
        report={report({
          timeline: [
            {
              atMs: NOW - HOUR,
              condition: 'discovery-stale',
              code: 'no-scan',
              previousCode: null,
              symbol: null,
            },
          ],
          items: [
            item({
              symbols: [{ symbol: 'BTCUSDT', sinceMs: NOW - 30 * DAY }],
              sinceMs: NOW - 30 * DAY,
            }),
          ],
        })}
      />,
    );

    expect(screen.getByTestId('timeline-span-entry-blocked-knife-guard')).toHaveAttribute(
      'data-clipped',
      'true',
    );
    expect(screen.getByTestId('timeline-clipped-note')).toHaveTextContent(
      /started before the oldest log entry still kept/i,
    );
  });

  it('renders nothing at all rather than an empty frame', () => {
    const { container } = render(<ConditionTimeline report={report()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
