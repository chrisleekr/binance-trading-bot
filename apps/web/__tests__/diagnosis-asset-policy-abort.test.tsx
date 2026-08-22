// An aborted discovery cycle has to reach the operator as a blocking finding that names the fault in their own language. The whole point of carrying the cause this far is that the page can say "it gave up before choosing any coins, and here is why" rather than showing a funnel that merely looks old.
//
// The finding is DERIVED from the ladder rather than retyped here, so the rendered card is the one production builds: a renamed item id, a dropped evidence line, or a downgraded severity fails here instead of leaving both suites green while the page renders nothing.

import {
  ASSET_POLICY_ABORT_CAUSE_COPY,
  runDiagnosisStep,
  type DiagnosisRun,
  type ProfileDiagnosisInput,
} from '@app/contracts';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DiagnosisRunBody } from '@/features/profile/components/diagnosis-run-view';

const NOW = Date.parse('2026-08-21T00:00:00.000Z');
const CAUSE = 'stablecoin-route-empty';

const input: ProfileDiagnosisInput = {
  nowMs: NOW,
  profile: {
    enabled: true,
    quoteAsset: 'USDT',
    config: {},
    discoveryEnabled: true,
    discoveryConfig: {},
    maxAutoSymbols: 5,
    refreshPeriodMs: 900_000,
    autoSymbolCount: 2,
  },
  worker: { heartbeatPresent: true },
  halts: [],
  conditions: [],
  // Six days of refusals, which is the case the whole `firstAtMs` carry-forward exists for: the record's own `atMs` moves every cycle, so a duration read off it would render this as minutes.
  assetPolicyAbort: { cause: CAUSE, atMs: NOW - 900_000, firstAtMs: NOW - 6 * 86_400_000 },
  snapshots: [],
  reasonAttribution: {},
  discoveryHealthWindow: 8,
  timeline: [],
};

const items = runDiagnosisStep('discovery-running', input).items;

const run: DiagnosisRun = {
  id: 'run-1',
  status: 'done',
  steps: [],
  report: {
    asOfMs: NOW,
    verdict: 'blocked',
    headline: items[0]?.title ?? '',
    steps: [],
    items: [...items],
    funnel: null,
    timeline: [],
  },
  error: null,
  startedAtMs: NOW - 5_000,
  finishedAtMs: NOW,
};

describe('the asset-policy abort finding on the profile page', () => {
  it('renders as blocking, with the cause spelled out and no internal name in sight', () => {
    render(<DiagnosisRunBody run={run} profileId="p1" />);

    const card = screen.getByTestId('diagnosis-item-discovery-asset-policy-abort');
    expect(card.getAttribute('data-severity')).toBe('blocking');
    // The operator reads the sentence, never the enum member behind it — the literal is the code, and a page that shows it has explained nothing.
    expect(card.textContent).toContain(ASSET_POLICY_ABORT_CAUSE_COPY[CAUSE]);
    expect(card.textContent).not.toContain(CAUSE);
    expect(screen.getByTestId('diagnosis-verdict').getAttribute('data-verdict')).toBe('blocked');
  });

  it('dates the finding from the start of the refusal, not from the last attempt', () => {
    render(<DiagnosisRunBody run={run} profileId="p1" />);

    // A refusal in force for six days must not read as "for 15m" because the record was rewritten one refresh period ago.
    expect(screen.getByTestId('diagnosis-item-since').textContent).toMatch(/6d/);
  });

  it('paints the timeline span the same colour as the card, and hides the code from its tooltip', () => {
    render(<DiagnosisRunBody run={run} profileId="p1" />);

    const span = screen.getByTestId(`timeline-span-asset-policy-refused-${CAUSE}`);
    expect(span.getAttribute('data-severity')).toBe('blocking');
    expect(span.className).toContain('bg-danger');
    // `title` is not part of `textContent`, which is why the card assertions above cannot see this leak. Swept across the whole subtree so any future hover text is covered too.
    for (const el of Array.from(document.querySelectorAll('[title]'))) {
      expect(el.getAttribute('title')).not.toContain(CAUSE);
    }
  });
});
