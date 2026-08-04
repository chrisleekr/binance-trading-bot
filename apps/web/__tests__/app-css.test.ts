// A source-text assertion on the one stylesheet rule that cannot be tested
// through the DOM: happy-dom does no layout, so the only way to guard the
// viewport contract is to read the CSS.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest roots this project at apps/web, so cwd is stable. `import.meta.url` is
// not usable here: vite rewrites it to an http URL under the browser-ish env.
const css = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8');

describe('app.css', () => {
  it('html and body do not set height:100%', () => {
    // `height: 100%` on html/body pins the document to the viewport, which is
    // what makes mobile browsers keep their URL bar expanded and lets a scroll
    // inside <main> chain out to a document that cannot scroll. The shell sizes
    // itself with dynamic viewport units instead; #root may still be 100%.
    //
    // Match the selector list, not the whole file: `height: 100%` is legitimate
    // on other elements. A brace-free body means only innermost rules match, so
    // an `@layer` / `@theme` wrapper cannot swallow the rule it contains.
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const offenders = rules.filter(([, selector = '', body = '']) => {
      const targetsHtmlOrBody = /(^|,)\s*(html|body)\s*(,|$)/m.test(selector);
      return targetsHtmlOrBody && /height:\s*100%/.test(body);
    });
    expect(offenders.map(([, s]) => (s ?? '').trim())).toEqual([]);
  });

  it('exposes --skeleton in both themes and as a Tailwind colour utility', () => {
    const dark = /:root,\s*\[data-theme='dark'\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    const light = /\[data-theme='light'\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(dark).toMatch(/--skeleton:/);
    expect(light).toMatch(/--skeleton:/);
    // Without this mapping Tailwind emits no `bg-skeleton`, every placeholder
    // bar paints transparent, and the loading screens go invisible again.
    expect(css).toMatch(/--color-skeleton:\s*var\(--skeleton\)/);
  });

  it('insets the pending screen wherever its parent supplies no padding', () => {
    // Styled on data-route-pending, not the test id: a test id is meant to be
    // safe to rename, and renaming this one would silently drop the padding on
    // the screen shown for every hard page load.
    expect(css).toMatch(/:is\(#root, main:not\(\.p-4\)\) > \[data-route-pending\]/);
    const component = readFileSync(resolve(process.cwd(), 'src/app/route-pending.tsx'), 'utf8');
    expect(component).toContain('data-route-pending');
  });

  it('the boot placeholder literals still match the dark tokens they copy', () => {
    // index.html paints before the token stylesheet applies, so those values
    // must be literals; this is what bounds the copy when the theme moves.
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    const token = (name: string): string | undefined =>
      new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(css)?.[1];
    expect(html).toContain(`background: ${token('bg')}`);
    expect(html).toContain(`background: ${token('bg-elevated')}`);
    expect(html).toContain(`border: 1px solid ${token('border')}`);
    expect(html).toContain(`solid ${token('accent')}`);
  });
});
