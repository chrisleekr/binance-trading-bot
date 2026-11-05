import { describe, expect, it } from 'vitest';

import { PIPELINE_JOB_OPTIONS } from '../../src/queue/pipeline-job-options.js';

describe('PIPELINE_JOB_OPTIONS', () => {
  it('retries a throwing pipeline job twice, one second apart', () => {
    expect(PIPELINE_JOB_OPTIONS).toEqual({
      attempts: 3,
      backoff: { type: 'fixed', delay: 1_000 },
    });
  });
});
