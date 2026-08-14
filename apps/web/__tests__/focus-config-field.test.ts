// Landing a diagnosis deep link on the setting it names.
//
// The link is the payoff of the whole investigation, and every way it fails is
// silent: an unexpanded ancestor hides the field, a stale path scrolls nowhere,
// a non-string param becomes a focus target of "undefined". Each is asserted
// here because none of them throws.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { focusConfigField, focusParam } from '@/shared/lib/focus-config-field';

// jsdom implements the DOM, not layout, so scrollIntoView is absent. The call
// is not what these cases are about; the expansion and the marker are.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('focusConfigField', () => {
  it('opens every collapsed ancestor, not just the nearest', () => {
    // Both collapsers nest in the real form: a Panel wrapping an AutoForm group.
    // Expanding only the inner one leaves the field as invisible as before.
    document.body.innerHTML = `
      <details id="outer"><summary>Sell</summary>
        <details id="inner"><summary>Trailing</summary>
          <input id="sell.trailingStopPercentage" />
        </details>
      </details>`;

    expect(focusConfigField('sell.trailingStopPercentage')).toBe(true);
    expect([...document.querySelectorAll('details')].every((d) => d.open)).toBe(true);
  });

  it('marks the field, then clears the marker on its own', () => {
    document.body.innerHTML = '<input id="sell.enabled" />';
    const el = document.getElementById('sell.enabled') as HTMLElement;

    focusConfigField('sell.enabled');
    expect(el.classList.contains('field-focus-pulse')).toBe(true);

    vi.advanceTimersByTime(2_000);
    expect(el.classList.contains('field-focus-pulse')).toBe(false);
  });

  it('reports false for a path that is not on the page', () => {
    // A renamed setting leaves old links pointing at nothing. Returning false is
    // what lets the caller stop rather than half-scroll to an arbitrary element.
    document.body.innerHTML = '<input id="sell.enabled" />';

    expect(focusConfigField('sell.gone')).toBe(false);
  });
});

describe('focusParam', () => {
  it('takes a string target', () => {
    expect(focusParam({ focus: 'buy.accountCap' })).toEqual({ focus: 'buy.accountCap' });
  });

  it('drops anything that is not a usable path', () => {
    // The value is whatever the URL carried, so a hand-typed `?focus=` or an
    // array from a repeated key must land as absent, never as the string
    // "undefined" hunting for an element by that id.
    expect(focusParam({ focus: 7 })).toEqual({});
    expect(focusParam({ focus: '' })).toEqual({});
    expect(focusParam({})).toEqual({});
    expect(focusParam(undefined)).toEqual({});
  });
});
