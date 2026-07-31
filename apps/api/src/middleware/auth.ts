import { asUserId, type UserId } from '@app/contracts';
import type { MiddlewareHandler } from 'hono';
import type { Auth } from 'auth.js';
import type { Env } from 'types.js';

// Resolves Better Auth session → c.set('userId', …). Does NOT 401; the
// require-user middleware enforces that on account-scoped routes.
//
// `demo` is the boot-resolved sole operator, non-null only under LIVE_DEMO. When
// a real session is absent it is injected so every requireUser() mount,
// userIdOf(), and the WS upgrade resolve an identity and the login screen never
// appears. A real Better Auth session always wins over the demo injection.
export const sessionResolver =
  (auth: Auth, demo: { userId: UserId } | null = null): MiddlewareHandler<Env> =>
  async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (session?.user.id) c.set('userId', asUserId(session.user.id));
    else if (demo) c.set('userId', demo.userId);
    await next();
  };
