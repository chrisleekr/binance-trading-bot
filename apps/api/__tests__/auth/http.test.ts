// The post-sign-in redirect guard. Better Auth does not re-validate the single sign-on callback URL this produces, so every input the browser's URL parser would rewrite into another host must come back as `/`.

import { describe, expect, it } from 'vitest';

import { sameOriginPath } from '../../src/auth/http.js';

describe('sameOriginPath', () => {
  it.each([
    ['tab between slashes', '/\t/evil.example'],
    ['newline between slashes', '/\n/evil.example'],
    ['backslash after the slash', '/\\evil.example'],
    ['protocol-relative', '//evil'],
    ['protocol-relative with a path, which must not keep the foreign path', '//evil/path'],
    ['absolute URL', 'https://evil'],
    ['dot segment collapsing to a protocol-relative path', '/.//evil.example'],
    ['parent segment collapsing to a protocol-relative path', '/a/..//evil'],
    ['unparseable host', '//['],
    ['relative path with no leading slash', 'evil.example'],
  ])('rejects %s', (_label, value) => {
    expect(sameOriginPath(value)).toBe('/');
  });

  it('keeps a same-origin path with its query and fragment', () => {
    expect(sameOriginPath('/ok?x=1#h')).toBe('/ok?x=1#h');
  });

  it('returns the re-serialised path, so a tab the browser would strip never reaches the header', () => {
    expect(sameOriginPath('/a/\t/b')).toBe('/a//b');
  });

  it('falls back to the root when no destination was asked for', () => {
    expect(sameOriginPath(undefined)).toBe('/');
  });
});
