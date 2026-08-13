import { repo } from '@app/db';
import type { MiddlewareHandler } from 'hono';
import { clientIp } from 'middleware/client-ip.js';
import type { DI } from 'di.js';
import type { Env } from 'types.js';

// Best-effort audit middleware. Handler sets `c.var.auditEvent = { event, payload? }`
// after a successful state-changing operation; we write one audit_logs row.
// Write failure is logged at WARN and intentionally does not roll back the
// user action because audit logging is best-effort and must not block request
// success.
//
// A 4xx normally means the mutation never happened, so recording it would
// invent history. `alreadyApplied` is the handler's declaration that it did
// happen anyway — a partial success that still answers 4xx, where the rows are
// already gone and this row is the only surviving trace of the change.
export const audit =
  (di: DI): MiddlewareHandler<Env> =>
  async (c, next) => {
    await next();
    const event = c.get('auditEvent');
    const userId = c.get('userId');
    if (!event || !userId) return;
    if (c.res.status >= 400 && !event.alreadyApplied) return;
    try {
      await repo.auditLogs.append(di.db, userId, {
        actor: 'user',
        event: event.event,
        ip: clientIp(c),
        userAgent: (c.req.header('user-agent') ?? null)?.slice(0, 256) ?? null,
        payload: event.payload ?? null,
      });
    } catch (err) {
      di.logger.warn({ err, event: event.event, userId }, 'audit_write_failed');
    }
  };
