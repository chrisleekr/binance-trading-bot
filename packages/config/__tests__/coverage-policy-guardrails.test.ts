import { describe, expect, it } from 'vitest';

import { defineProject } from '../vitest/index.js';

describe('coverage policy guardrails', () => {
  it.each([
    ['include', ['src/narrowed.ts']],
    ['exclude', ['src/**']],
    ['ignoreClassMethods', ['constructor']],
    ['reportsDirectory', 'coverage/consumer'],
  ])('rejects a consumer coverage.%s override', (field, value) => {
    expect(() =>
      defineProject({
        packageName: '@app/web',
        test: { coverage: { [field]: value } },
      }),
    ).toThrow(`defineProject: coverage.${field} is policy-owned and cannot be overridden`);
  });

  it('keeps permitted coverage options and policy thresholds', () => {
    const config = defineProject({
      packageName: '@app/web',
      test: { coverage: { reportOnFailure: true } },
    });

    expect(config.test?.coverage).toMatchObject({
      reportOnFailure: true,
      include: ['src/**/*.{ts,tsx}'],
      thresholds: { lines: 80, branches: 70 },
    });
  });
});
