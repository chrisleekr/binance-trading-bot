import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { DestinationStream } from 'pino';

import { createLogger } from '../src/middleware/logger.js';

class CaptureStream extends Writable implements DestinationStream {
  public buffer = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error) => void): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    cb();
  }
  write(chunk: Buffer | string): boolean {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    return true;
  }
}

const lastLine = (out: CaptureStream): Record<string, unknown> => {
  const lines = out.buffer.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
};

describe('api logger err serializer', () => {
  it('serializes a raw Error under `err` into an object carrying the stack', () => {
    const out = new CaptureStream();
    const logger = createLogger({ level: 'debug', destination: out });
    logger.error({ err: new Error('boom') }, 'x');
    const err = lastLine(out).err as { stack?: unknown; message?: unknown };
    expect(typeof err.stack).toBe('string');
    expect(err.stack as string).toContain('boom');
    expect(err.message).toBe('boom');
  });

  it('serializes a non-Error error-shaped object without throwing', () => {
    const out = new CaptureStream();
    const logger = createLogger({ level: 'debug', destination: out });
    expect(() => logger.error({ err: { code: -1013 } }, 'x')).not.toThrow();
    expect(lastLine(out).err).toEqual({ code: -1013 });
  });
});
