// Lock the merge rule that turns saved (config, secrets) into the
// executor's flat config shape. The contract is invisible to the
// executor (it only sees `ResolvedNotifier.config`), so a regression in
// the merge — losing secrets, leaving them under a `secrets` key, or
// double-counting disabled rows — would silently break notify decisions.

import { describe, expect, it } from 'vitest';

import { resolveNotifiersFromRows, type NotifierRowInput } from '../../src/notifiers/lookup.js';

const enabled = (provider: string, config: unknown, secrets: unknown): NotifierRowInput => ({
  provider,
  config,
  secrets,
  enabled: true,
});

describe('resolveNotifiersFromRows', () => {
  it('merges config and secrets into one flat object per row', () => {
    const rows = [enabled('slack', { channel: '#ops' }, { webhookUrl: 'https://h/x' })];
    expect(resolveNotifiersFromRows(rows)).toEqual([
      { providerName: 'slack', config: { channel: '#ops', webhookUrl: 'https://h/x' } },
    ]);
  });

  it('secrets win on key collision so a same-named visible field cannot shadow a stored secret', () => {
    // Hypothetical migration where `webhookUrl` was once non-secret. The
    // secret-side value must override the wire-visible one.
    const rows = [
      enabled('slack', { webhookUrl: 'leaked-public-value' }, { webhookUrl: 'https://real/x' }),
    ];
    expect(resolveNotifiersFromRows(rows)).toEqual([
      { providerName: 'slack', config: { webhookUrl: 'https://real/x' } },
    ]);
  });

  it('skips disabled rows entirely', () => {
    const rows: NotifierRowInput[] = [
      { provider: 'slack', config: { a: 1 }, secrets: { b: 2 }, enabled: false },
      { provider: 'webhook', config: { url: 'https://w' }, secrets: {}, enabled: true },
    ];
    expect(resolveNotifiersFromRows(rows)).toEqual([
      { providerName: 'webhook', config: { url: 'https://w' } },
    ]);
  });

  it('treats null / non-object config or secrets as empty so a partially-migrated row never crashes', () => {
    const rows: NotifierRowInput[] = [
      { provider: 'telegram', config: null, secrets: { botToken: 't' }, enabled: true },
      { provider: 'webhook', config: { url: 'https://w' }, secrets: null, enabled: true },
    ];
    expect(resolveNotifiersFromRows(rows)).toEqual([
      { providerName: 'telegram', config: { botToken: 't' } },
      { providerName: 'webhook', config: { url: 'https://w' } },
    ]);
  });

  it('returns an empty array on empty input', () => {
    expect(resolveNotifiersFromRows([])).toEqual([]);
  });
});
