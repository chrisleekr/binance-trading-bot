import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { buildLogger } from '../../../src/boot/builders/primitives.js';

// buildPrimitives itself opens real Redis/pg/BullMQ connections and is exercised
// end-to-end by the boot-context integration test; here we pin the one piece of
// pure logic the module owns — the pino redaction policy the logger boots with.
describe('buildLogger', () => {
  const capture = (): { lines: string[]; stream: Writable } => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    return { lines, stream };
  };

  it('redacts secret-bearing fields', () => {
    const { lines, stream } = capture();
    const logger = buildLogger('info', stream);
    logger.info({ apiKey: 'super-secret', nested: { secret: 'also-secret' } }, 'boot');
    const out = lines.join('');
    expect(out).not.toContain('super-secret');
    expect(out).not.toContain('also-secret');
    expect(out).toContain('[redacted]');
  });

  it('defaults to info level when none is given', () => {
    const logger = buildLogger(undefined);
    expect(logger.level).toBe('info');
  });
});
