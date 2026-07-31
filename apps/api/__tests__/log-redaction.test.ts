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

const buildLogger = (): { logger: ReturnType<typeof createLogger>; out: CaptureStream } => {
  const out = new CaptureStream();
  const logger = createLogger({ level: 'debug', destination: out });
  return { logger, out };
};

describe('api logger redactor — smoke', () => {
  it('strips top-level apiKey and apiSecret from a logged payload', () => {
    const { logger, out } = buildLogger();
    const SECRET = 'plaintext-secret-do-not-leak';
    const KEY = 'plaintext-key-do-not-leak';
    logger.info(
      {
        apiKey: KEY,
        apiSecret: SECRET,
        nested: { secret: SECRET, key: KEY, password: 'pw' },
        req: { headers: { authorization: 'Bearer xyz', cookie: 'session=abc' } },
      },
      'add-api-key',
    );
    expect(out.buffer).not.toContain(SECRET);
    expect(out.buffer).not.toContain(KEY);
    expect(out.buffer).not.toContain('Bearer xyz');
    expect(out.buffer).not.toContain('session=abc');
    expect(out.buffer).toContain('[redacted]');
  });

  it('strips top-level Authorization (case-sensitive) and authorization values', () => {
    const { logger, out } = buildLogger();
    logger.info({ Authorization: 'Bearer leaky', authorization: 'Bearer leaky2' }, 'admin');
    expect(out.buffer).not.toContain('Bearer leaky');
    expect(out.buffer).not.toContain('Bearer leaky2');
  });

  it('strips password fields including oldPassword/newPassword nests', () => {
    const { logger, out } = buildLogger();
    logger.info(
      {
        password: 'top-pw',
        body: { oldPassword: 'old-pw', newPassword: 'new-pw', token: 'leaky-token' },
      },
      'change-password',
    );
    expect(out.buffer).not.toContain('top-pw');
    expect(out.buffer).not.toContain('old-pw');
    expect(out.buffer).not.toContain('new-pw');
    expect(out.buffer).not.toContain('leaky-token');
  });

  it('strips top-level token and key as well as their nested forms', () => {
    const { logger, out } = buildLogger();
    logger.info(
      {
        key: 'top-key-leak',
        secret: 'top-secret-leak',
        token: 'top-token-leak',
        password: 'top-password-leak',
      },
      'top-paths',
    );
    for (const v of ['top-key-leak', 'top-secret-leak', 'top-token-leak', 'top-password-leak']) {
      expect(out.buffer).not.toContain(v);
    }
  });
});
