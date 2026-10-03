import type { SecurityEvent } from '@app/contracts';
import { repo } from '@app/db';
import type { MiddlewareHandler } from 'hono';
import { clientIp } from 'middleware/client-ip.js';
import type { DI } from 'di.js';
import type { Env } from 'types.js';

/**
 * Audit events that change what an intruder could steal or who hears about it. Each also becomes a security event, which reaches the Security page and raises an alert. Keyed here, at the one place every route's audit event passes, so a route cannot record the change and forget the alert.
 */
export const SENSITIVE_AUDIT_EVENTS: Readonly<Record<string, SecurityEvent>> = {
  'backup-download': 'backup-downloaded',
  restore: 'restore-performed',
  'add-api-key': 'api-key-changed',
  'replace-api-key': 'api-key-changed',
  'delete-api-key': 'api-key-changed',
  'notify-provider-save': 'notifier-changed',
  'notify-provider-enabled': 'notifier-changed',
  'set-ops-notify-config': 'ops-notify-settings-changed',
  'set-retention-config': 'retention-settings-changed',
  'set-ai-provider': 'ai-provider-changed',
};

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
/**
 * Best-effort audit writer.
 *
 * @param di - Container supplying the database handle and the warn logger the failure path uses.
 * @param actor - Who the row attributes the action to. The default keeps every existing mount writing `user`; the MCP inner app passes `agent`, which is the only thing distinguishing an order an AI placed from one the operator clicked, since both arrive through the identical router set. The union is the enforcement: the column is free text and nothing downstream validates it, so a misspelling would attribute an agent's order to the operator and read as ordinary history forever.
 * @returns Middleware that appends one `audit_logs` row after a handler declares an auditable event.
 */
export const audit =
  (di: DI, actor: 'user' | 'agent' = 'user'): MiddlewareHandler<Env> =>
  async (c, next) => {
    await next();
    const event = c.get('auditEvent');
    const userId = c.get('userId');
    if (!event || !userId) return;
    if (c.res.status >= 400 && !event.alreadyApplied) return;
    try {
      await repo.auditLogs.append(di.db, userId, {
        actor,
        event: event.event,
        ip: clientIp(c),
        userAgent: (c.req.header('user-agent') ?? null)?.slice(0, 256) ?? null,
        payload: event.payload ?? null,
      });
    } catch (err) {
      di.logger.warn({ err, event: event.event, userId }, 'audit_write_failed');
    }
    const securityEvent = SENSITIVE_AUDIT_EVENTS[event.event];
    if (securityEvent !== undefined) {
      await di.security.events.record({
        event: securityEvent,
        actor,
        ipAddress: clientIp(c),
        userAgent: c.req.header('user-agent') ?? null,
        detail: { change: event.event },
      });
    }
  };
