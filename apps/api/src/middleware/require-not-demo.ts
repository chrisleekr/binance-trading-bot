import type { MiddlewareHandler } from 'hono';
import type { DI } from 'di.js';
import type { Env } from 'types.js';
import { HttpError } from 'middleware/error.js';

// Locks credential, notifier, backup/restore, account creation, retention
// changes, and diagnosis starts under LIVE_DEMO. A public demo box injects the
// operator identity for everyone (see sessionResolver), so requireUser() no
// longer gates these. This guard does.
// Reads di.env.LIVE_DEMO at REQUEST time, not mount time, so a route added to a
// demo box later cannot silently stay reachable.
export const requireNotDemo =
  (di: DI): MiddlewareHandler<Env> =>
  async (c, next) => {
    if (di.env.LIVE_DEMO) {
      throw new HttpError('FORBIDDEN', 'This action is disabled in the live demo.');
    }
    await next();
  };
