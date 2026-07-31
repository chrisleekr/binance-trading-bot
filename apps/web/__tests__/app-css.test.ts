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
});
