import { describe, expect, it } from 'vitest';

import {
  commitPipelineChecked,
  type CommittablePipeline,
  type PipeReply,
} from '../../src/lib/redis-pipeline.js';

// `commitPipeline` resolves the commit method by bracket access and calls it,
// so a stub only needs an `exec` that returns the reply tuples (or null).
const stubPipe = (result: PipeReply[] | null): CommittablePipeline =>
  ({ exec: async () => result }) as unknown as CommittablePipeline;

describe('commitPipelineChecked', () => {
  it('returns the replies when every queued command succeeded', async () => {
    const replies: PipeReply[] = [
      [null, 'OK'],
      [null, 'OK'],
    ];
    await expect(commitPipelineChecked(stubPipe(replies), 'ctx')).resolves.toBe(replies);
  });

  // Criterion: a partial success (an OK row precedes the errored row) must still
  // throw. Guards against a regression that only inspects replies[0].
  it('throws the per-command error when it rides on a non-first reply', async () => {
    const boom = new Error('OOM command not allowed');
    const replies: PipeReply[] = [
      [null, 'OK'],
      [boom, null],
      [null, 'OK'],
    ];
    await expect(commitPipelineChecked(stubPipe(replies), 'ctx')).rejects.toBe(boom);
  });

  it('throws the first error when several commands failed', async () => {
    const first = new Error('first');
    const replies: PipeReply[] = [
      [first, null],
      [new Error('second'), null],
    ];
    await expect(commitPipelineChecked(stubPipe(replies), 'ctx')).rejects.toBe(first);
  });

  it('throws a context-prefixed error when the commit resolves to null', async () => {
    await expect(commitPipelineChecked(stubPipe(null), 'signal-TTL refresh')).rejects.toThrow(
      'signal-TTL refresh: pipeline commit returned null',
    );
  });
});
