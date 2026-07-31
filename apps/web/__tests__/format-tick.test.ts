import { describe, expect, it } from 'vitest';

import { formatLastTick, formatTickLatency } from '@/shared/lib/format-tick';

// A pinned "now" injected via the optional clock argument so tier boundaries
// can be asserted exactly without vi.useFakeTimers swapping the global clock
// for every consumer of Date.now() in the test process.
const NOW = new Date('2026-05-18T00:00:00.000Z').getTime();
const now = () => NOW;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

describe('formatLastTick', () => {
  it('returns "Never" for a null or unparseable timestamp', () => {
    expect(formatLastTick(null, now)).toBe('Never');
    expect(formatLastTick('not-a-date', now)).toBe('Never');
  });

  it('clamps negative ages to "0s ago" (client clock briefly ahead of server)', () => {
    expect(formatLastTick(new Date(NOW + 5_000).toISOString(), now)).toBe('0s ago');
  });

  it('reports seconds up to the minute boundary', () => {
    expect(formatLastTick(ago(0), now)).toBe('0s ago');
    expect(formatLastTick(ago(59_000), now)).toBe('59s ago');
    expect(formatLastTick(ago(60_000), now)).toBe('1m ago');
  });

  it('rolls up to hours at the 60-minute boundary', () => {
    expect(formatLastTick(ago(59 * 60_000), now)).toBe('59m ago');
    expect(formatLastTick(ago(60 * 60_000), now)).toBe('1h ago');
  });

  it('rolls up to days at the 24-hour boundary', () => {
    expect(formatLastTick(ago(23 * 3_600_000), now)).toBe('23h ago');
    expect(formatLastTick(ago(24 * 3_600_000), now)).toBe('1d ago');
    expect(formatLastTick(ago(2 * 86_400_000), now)).toBe('2d ago');
  });
});

describe('formatTickLatency', () => {
  it('renders an em-dash when latency is unknown', () => {
    expect(formatTickLatency(null)).toBe('—');
  });

  it('renders an integer millisecond value with the unit suffix', () => {
    expect(formatTickLatency(0)).toBe('0 ms');
    expect(formatTickLatency(87)).toBe('87 ms');
    expect(formatTickLatency(1234)).toBe('1234 ms');
  });
});
