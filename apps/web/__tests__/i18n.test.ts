import { describe, expect, it } from 'vitest';

import { setI18nProvider, t } from '@/shared/lib/i18n';

describe('i18n shim (default English provider)', () => {
  it('returns the English fallback for known keys', () => {
    expect(t('app.title')).toBe('BOT');
  });

  it('interpolates ICU-shaped {var} tokens', () => {
    expect(t('home.card.last_tick.ago.seconds', { seconds: 42 })).toBe('42s ago');
  });

  it('returns the key when missing', () => {
    expect(t('missing.key')).toBe('missing.key');
  });
});

describe('i18n shim provider swap', () => {
  it('routes calls through a custom provider after setI18nProvider', () => {
    setI18nProvider((key, vars) => `[${key}]${vars ? JSON.stringify(vars) : ''}`);
    try {
      expect(t('app.title')).toBe('[app.title]');
      expect(t('home.symbols.held', { qty: 'x' })).toBe('[home.symbols.held]{"qty":"x"}');
    } finally {
      setI18nProvider(originalProvider());
    }
  });
});

// Restore the in-module fallback by re-importing. Provider is module-scoped,
// so we expose this helper to keep the test isolated without a circular reset.
function originalProvider(): (
  key: string,
  vars?: Readonly<Record<string, string | number>>,
) => string {
  const en: Record<string, string> = {
    'app.title': 'binance-trading-bot',
    'theme.toggle.to_light': 'Switch to light theme',
    'theme.toggle.to_dark': 'Switch to dark theme',
  };
  return (key, vars) => {
    const tmpl = en[key] ?? key;
    if (!vars) return tmpl;
    return tmpl.replace(/\{(\w+)\}/g, (_, n: string) => {
      const v = Object.prototype.hasOwnProperty.call(vars, n) ? vars[n] : undefined;
      return v === undefined ? `{${n}}` : String(v);
    });
  };
}
